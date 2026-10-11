"""Runs the 48 warehouse-layer authorization cases against the purpose views and table functions of a warehouse built
from the fixture world, through the shim query function (the same named queries the Worker runs).

Status mapping at this layer: a profile read is "200" when the scoped query returns exactly one row and "404" when it
returns none; list and lookup expectations are checked on the returned rows. Locally the ceiling (masking, restricted
filter, dataset allowlist) is the DuckDB emulation in the generated view SQL; in production the same cases run against
BigQuery as each purpose's service account.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from peoplevault.authz.cases import Case, load_cases, load_subjects, subject
from peoplevault.fixtures.world import load_world
from peoplevault.policy.model import TAGGED_CLASSES, policy
from peoplevault.pseudo import TEST_MASTER_KEY, Pseudonymizer

REPRESENTATIVE = {
    "direct_identifier": "full_name", "date_of_birth": "birth_date", "compensation": "base_salary",
    "performance": "rating", "health_leave": "leave_type", "protected_attribute": "gender",
}
RAW_ID = re.compile(r"\bE\d{5}\b")

Runner = Callable[[str, str, dict], list[dict]]  # (purpose, query_id, params) -> rows


@dataclass
class CaseResult:
    id: str
    category: str
    passed: bool
    detail: str = ""


@dataclass
class Report:
    results: list[CaseResult] = field(default_factory=list)

    @property
    def passed(self) -> int:
        return sum(r.passed for r in self.results)

    def by_category(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for r in self.results:
            d = out.setdefault(r.category, {"passed": 0, "total": 0})
            d["total"] += 1
            d["passed"] += int(r.passed)
        return dict(sorted(out.items()))


class CaseFailure(AssertionError):
    pass


def _check(cond: bool, msg: str) -> None:
    if not cond:
        raise CaseFailure(msg)


def _norm(v):
    return v.isoformat() if hasattr(v, "isoformat") else v


class WorldContext:
    def __init__(self, master_key: bytes = TEST_MASTER_KEY):
        self.world = load_world()
        self.subjects = load_subjects()
        self.ps = Pseudonymizer(master_key)
        self.principals = {p["id"]: p for p in self.world["principals"]}
        self.policy = policy()

    def scope(self, principal: str, purpose: str) -> dict:
        p = self.principals[principal]
        rs = self.policy.purposes[purpose].row_scope
        if rs == "org_units":
            return {"org_units": list(p.get("org_units", []))}
        if rs == "direct_reports":
            return {"manager_key": self.ps.pseudonym("warehouse_key", p["employee"])}
        return {}


def _all_pages(run: Runner, purpose: str, qid: str, base: dict) -> list[dict]:
    q = policy().queries[purpose][qid.split(".", 1)[1]]
    if not q.paged_by:
        return run(purpose, qid, base)
    out, cursor = [], ""
    while True:
        rows = run(purpose, qid, {**base, "cursor": cursor, "limit": 100})
        out.extend(rows)
        if len(rows) < 100:
            return out
        cursor = str(rows[-1][q.paged_by])


def _profile(ctx: WorldContext, run: Runner, principal: str, purpose: str, s: dict) -> list[dict]:
    ref_kind = ctx.policy.purposes[purpose].ref
    return run(purpose, f"{purpose}.profile", {**ctx.scope(principal, purpose), ref_kind: s[ref_kind]})


def _lookup(run: Runner, purpose: str, s: dict) -> list[dict]:
    return run(purpose, f"{purpose}.identity_lookup", {"q": s["truth"]["full_name"][:6]})


def _projected(purpose: str, qname: str, cls: str) -> list[str]:
    """The columns of a class that the named query returns."""
    cols = set(ctx_cols(cls))
    return [c for c in policy().queries[purpose][qname].columns if c in cols]


def _class_visibility(row: dict, cls: str, vis: str, s: dict, purpose: str, qname: str) -> None:
    cols = ctx_cols(cls)
    present = [c for c in cols if c in row]
    rep = REPRESENTATIVE[cls]
    if vis == "deny":
        _check(present == [], f"{cls} columns present: {present}")
    elif vis == "allow":
        # every column of the class the query returns equals the truth, not only the representative
        projected = _projected(purpose, qname, cls)
        _check(rep in projected and sorted(present) == sorted(projected), f"{cls} columns {present}, expected {projected}")
        wrong = [c for c in present if c not in s["truth"] or _norm(row[c]) != s["truth"][c]]
        _check(wrong == [], f"{wrong} do not equal the true values")
    elif vis == "mask_nullify":
        projected = _projected(purpose, qname, cls)
        _check(len(projected) > 0 and all(c in row and row[c] is None for c in projected), f"{cls} not nulled (or dropped instead of masked)")
    elif vis == "mask_date_year":
        _check(_norm(row.get(rep)) == s["truth"][rep][:4] + "-01-01", f"{rep} not masked to January 1")


def ctx_cols(cls: str) -> list[str]:
    return list(policy().columns[cls])


def run_case(ctx: WorldContext, run: Runner, case: Case) -> None:
    c = case.raw
    exp = c["expect"]
    purpose = c.get("purpose")
    principal = c["principal"]
    s = subject(ctx.subjects, c["subject"]) if c.get("subject") else None
    action = c["action"]
    if exp.get("class_visibility"):
        (cls, vis), = exp["class_visibility"].items()
        assert cls in TAGGED_CLASSES
        if action == "identity_lookup":
            rows = [r for r in _lookup(run, purpose, s) if r["employee_ref"] == s["employee_ref"]]
        else:
            rows = _profile(ctx, run, principal, purpose, s)
        _check(len(rows) == 1, f"expected the subject row, got {len(rows)}")
        _class_visibility(rows[0], cls, vis, s, purpose, "identity_lookup" if action == "identity_lookup" else "profile")
        return
    if action == "read_profile":
        rows = _profile(ctx, run, principal, purpose, s)
        if exp["status"] == 200:
            _check(len(rows) == 1, f"expected 1 row, got {len(rows)}")
        else:
            _check(len(rows) == 0, f"expected no row, got {len(rows)}")
        if exp.get("pseudonyms_distinct"):
            wa = run("workforce_analytics", "workforce_analytics.profile", {"analytics_id": s["analytics_id"]})
            _check(len(wa) == 1, "analytics profile missing")
            er, an = rows[0]["employee_ref"], wa[0]["analytics_id"]
            _check(len({er, an, s["subject_ref"]}) == 3, "pseudonyms not distinct")
            _check("employee_ref" not in wa[0] and "analytics_id" not in rows[0], "pseudonym kinds leak across purposes")
        return
    if action == "list_employees":
        rows = _all_pages(run, purpose, f"{purpose}.list", ctx.scope(principal, purpose))
        r = exp.get("rows", {})
        if r.get("within_principal_units"):
            units = set(ctx.principals[principal]["org_units"])
            _check(all(row["org_unit"] in units for row in rows), "row outside the principal's units")
        if r.get("count_selectors"):
            n = sum(len(ctx.subjects[principal].get(sel, [])) for sel in r["count_selectors"])
            _check(len(rows) == n, f"expected {n} rows, got {len(rows)}")
        if r.get("equals_selectors"):
            want = sorted(x["employee_ref"] for sel in r["equals_selectors"] for x in ctx.subjects[principal].get(sel, []))
            _check(sorted(row["employee_ref"] for row in rows) == want, "rows differ from direct reports")
        if r.get("excludes_selector"):
            ids = {x["analytics_id"] for x in ctx.subjects["*"][r["excludes_selector"]]}
            _check(bool(ids) and not ids & {row["analytics_id"] for row in rows}, "restricted subject present")
        if r.get("includes_selector"):
            ids = {x["analytics_id"] for x in ctx.subjects["*"][r["includes_selector"]]}
            _check(bool(ids) and ids <= {row["analytics_id"] for row in rows}, "terminated subject missing")
        if r.get("pseudonymous_only"):
            _check(len(rows) > 0, "no rows")
            for row in rows:
                _check(str(row.get("analytics_id", "")).startswith("an_"), "analytics_id missing")
                _check(not {"employee_ref", "employee_id", "work_email", "full_name", "personal_email"} & set(row), "identified column present")
        if r.get("employee_ref_no_raw_ids"):
            also = c["also"]
            rows2 = _all_pages(run, also["purpose"], f"{also['purpose']}.list", ctx.scope(also["principal"], also["purpose"]))
            allrows = rows + rows2
            _check(len(allrows) > 0, "no rows")
            for row in allrows:
                _check(re.fullmatch(r"er_[a-z2-7]{26}", str(row.get("employee_ref", ""))) is not None, "employee_ref missing")
                _check("employee_id" not in row and not any(RAW_ID.search(str(v)) for v in row.values()), "raw id present")
        return
    if action == "identity_lookup":
        for sel in exp.get("lookup_finds", []):
            target = ctx.subjects["*"][sel][0]
            refs = {r["employee_ref"] for r in _lookup(run, purpose, target)}
            _check(target["employee_ref"] in refs, f"{sel} subject not found")
        return
    raise CaseFailure(f"no warehouse-layer interpretation for {case.id}")


def run_all(run: Runner, ctx: WorldContext | None = None) -> Report:
    ctx = ctx or WorldContext()
    report = Report()
    for case in load_cases():
        if "warehouse" not in case.layers:
            continue
        try:
            run_case(ctx, run, case)
            report.results.append(CaseResult(case.id, case.category, True))
        except CaseFailure as e:
            report.results.append(CaseResult(case.id, case.category, False, str(e)))
    return report
