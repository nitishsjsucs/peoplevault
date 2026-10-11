"""The 100 authorization cases through the deployed API, against the full synthetic population (SPEC.md sections
18.3 and 19.2; `npm run authz:prod` and its local rehearsal `pv authz api --target local`).

The vitest harness runs every case against the fixture world. Here the same case file runs against a Worker seeded
with the full population, through the same tokens production has: one per persona principal (`hrbp-01`, `mgr-001`,
`analyst-01`, `privacy-01`) and the executor's. Through Cloudflare Access each of them is an Access service token, so
persona requests carry service identities resolved to the persona principals, not user sessions.

Subject selectors are re-resolved from the population's ground truth (the generator's truth and export files, with
pseudonyms computed from the master key), never from the system under test. Subjects in any eval cohort, subjects past
the retention cutoff (the daily sweep deletes them) and subjects with a deletion request are never picked. A case
runs only when everything it needs exists; otherwise it is reported as skipped with its reason, and the runnable count
is whatever that leaves (no count is promised in advance):
- forged or missing tokens and unmapped emails cannot pass Cloudflare Access (category A except A01 and A11);
- principals without a token (the fixture's other managers and its disabled principal);
- selectors with no qualifying subject in this population for the principal (for example a manager without a
  restricted direct report, or no completed deletion in scope);
- cases that write production state (a deletion request and a legal hold) unless `--allow-writes` is given.
"""

from __future__ import annotations

import base64
import csv
import io
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from peoplevault import config
from peoplevault.authz.cases import Case, load_cases
from peoplevault.pseudo import Pseudonymizer

TOKEN_PRINCIPALS = ("hrbp-01", "mgr-001", "analyst-01", "privacy-01")
FORGED = {"expired", "nbf_future", "wrong_aud", "wrong_iss", "other_key", "unknown_kid", "alg_none", "hs256_confusion", "missing", "unknown_email"}
WRITE_CASES = {"create_deletion_request", "place_legal_hold", "release_legal_hold"}
REPRESENTATIVE = {"direct_identifier": "full_name", "date_of_birth": "birth_date", "compensation": "base_salary", "performance": "rating",
                  "health_leave": "leave_type", "protected_attribute": "gender"}
RAW_ID = re.compile(r"\bE\d{5}\b")
SUPPRESSED = {"running", "completed", "completed_with_residuals", "failed"}
MAX_PAGES = 40
# matter ids are two letters, a year and three digits (LegalHoldBody); 900 and above are never seeded
AUTHZ_MATTER = "LH-2026-900"


class Skip(Exception):
    """The case cannot run in this environment; the message is the reason."""


class Fail(Exception):
    """The case ran and an expectation did not hold; the message says which (never a value)."""


# ---- population ground truth ---------------------------------------------------------------------------------------
@dataclass
class Person:
    employee_id: str
    full_name: str
    work_email: str
    org_unit: str
    status: str
    termination_date: str | None
    manager_id: str | None
    is_restricted: bool
    held: bool
    refs: dict[str, str]
    values: dict = field(default_factory=dict)

    def entry(self) -> dict:
        t = {"full_name": self.full_name, "work_email": self.work_email, "org_unit": self.org_unit, "employment_status": self.status,
             "is_restricted": self.is_restricted, "held": self.held, **self.values}
        return {"employee_ref": self.refs["employee_ref"], "analytics_id": self.refs["analytics_id"], "subject_ref": self.refs["subject_ref"], "truth": t}


def _latest_values(gen_dir: Path) -> dict[str, dict]:
    """birth_date and gender from the latest HRIS export; the latest base_salary, rating and leave_type the way the
    profile model picks them (latest pay period; latest cycle then review id; latest start date then leave id)."""
    manifest = json.loads((gen_dir / "manifest.json").read_text())["exports"]
    out: dict[str, dict] = {}
    hris = max((e for e in manifest if e["family"] == "hris"), key=lambda e: e["basis_date"])
    for line in (gen_dir / hris["key"]).read_text().splitlines():
        r = json.loads(line)
        out.setdefault(r["employee_id"], {}).update({"birth_date": r["birth_date"], "gender": r["gender"]})
    pay: dict[str, tuple[str, float]] = {}
    perf: dict[str, tuple[str, str, int]] = {}
    leave: dict[str, tuple[str, str, str]] = {}
    for e in manifest:
        body = (gen_dir / e["key"]).read_text()
        if e["family"] == "payroll":
            for r in csv.DictReader(io.StringIO(body)):
                cur = pay.get(r["employee_id"])
                if cur is None or r["pay_period_end"] > cur[0]:
                    pay[r["employee_id"]] = (r["pay_period_end"], float(r["base_salary"]))
        elif e["family"] == "performance":
            for line in body.splitlines():
                r = json.loads(line)
                k = (r["cycle"], r["review_id"], r["rating"])
                if r["employee_id"] not in perf or k[:2] > perf[r["employee_id"]][:2]:
                    perf[r["employee_id"]] = k
        elif e["family"] == "leave":
            for line in body.splitlines():
                r = json.loads(line)
                k = (r["start_date"], r["leave_id"], r["leave_type"])
                if r["employee_id"] not in leave or k[:2] > leave[r["employee_id"]][:2]:
                    leave[r["employee_id"]] = k
    for emp, v in out.items():
        v["base_salary"] = pay[emp][1] if emp in pay else None
        v["rating"] = perf[emp][2] if emp in perf else None
        v["leave_type"] = leave[emp][2] if emp in leave else None
    return out


@dataclass
class Population:
    people: dict[str, Person]
    principals: dict[str, dict]
    cohort_ids: set[str]
    retention_cutoff: str

    @classmethod
    def load(cls, gen_dir: Path, master_key: bytes, today: date | None = None) -> Population:
        truth = json.loads((gen_dir / "truth" / "subjects.json").read_text())
        principals = {p["id"]: p for p in json.loads((gen_dir / "truth" / "principals.json").read_text())}
        cohorts = json.loads((gen_dir / "truth" / "cohorts.json").read_text())
        ps = Pseudonymizer(master_key)
        values = _latest_values(gen_dir)
        people = {
            t["employee_id"]: Person(t["employee_id"], t["full_name"], t["work_email"], t["org_unit"], t["status"], t["termination_date"], t["manager_id"],
                                     bool(t["is_restricted"]), bool(t["hold_matter"]), ps.all(t["employee_id"]), values.get(t["employee_id"], {}))
            for t in truth
        }
        ids: set[str] = set()
        for profile in cohorts.values():
            for k, v in profile.items():
                if k == "D_groups":
                    continue
                ids.update(x["subject"] if isinstance(x, dict) else x for x in v)
        # the daily sweep deletes terminated employees past 3 years; keep 30 days of margin so a pick never races it
        today = today or date.today()
        cutoff = (today.replace(year=today.year - 3) + timedelta(days=30)).isoformat()
        return cls(people, principals, ids, cutoff)


@dataclass
class LiveState:
    """Deletion requests as the system reports them (privacy officer API): only used to keep picks away from subjects
    that are being or have been deleted, and to find completed deletions for the deleted-subject cases."""

    status_by_subject_ref: dict[str, set[str]]

    def requested(self, p: Person) -> bool:
        return p.refs["subject_ref"] in self.status_by_subject_ref

    def suppressed(self, p: Person) -> bool:
        return bool(self.status_by_subject_ref.get(p.refs["subject_ref"], set()) & SUPPRESSED)

    def uncertain(self, p: Person) -> bool:
        return "received" in self.status_by_subject_ref.get(p.refs["subject_ref"], set())

    def deleted(self, p: Person) -> bool:
        return bool(self.status_by_subject_ref.get(p.refs["subject_ref"], set()) & {"completed", "completed_with_residuals"})


class Resolver:
    """Case selectors over the population, mirroring `pv fixtures build` (fixtures/world.py) for the fixture world."""

    def __init__(self, pop: Population, live: LiveState):
        self.pop, self.live = pop, live

    def _eligible(self, p: Person) -> bool:
        if p.employee_id in self.pop.cohort_ids or self.live.requested(p):
            return False
        return not (p.termination_date and p.termination_date <= self.pop.retention_cutoff)

    def _active_ok(self, p: Person) -> bool:
        return p.status == "active" and not self.live.suppressed(p)

    def scope(self, principal: str, selector: str, *, pick: bool) -> list[Person]:
        """Subjects matching a selector, sorted by employee id. pick=True keeps only subjects safe to use as a case's
        subject; pick=False is the whole live population the API should return (for set expectations)."""
        people = self.pop.people
        ok = self._eligible if pick else (lambda p: True)

        def live(p: Person) -> bool:
            return not self.live.suppressed(p)

        if selector == "deleted":
            return sorted((p for p in people.values() if self.live.deleted(p)), key=lambda p: p.employee_id)
        if principal == "*":
            sel = {
                "active": lambda p: self._active_ok(p) and not p.is_restricted and not p.held,
                "restricted": lambda p: self._active_ok(p) and p.is_restricted,
                "terminated": lambda p: live(p) and p.status == "terminated",
                "held": lambda p: p.held,
            }[selector]
            return sorted((p for p in people.values() if sel(p) and ok(p)), key=lambda p: p.employee_id)
        pr = self.pop.principals.get(principal)
        if not pr or not pr.get("employee_id"):
            raise Skip(f"principal {principal} is not in this population")
        me = pr["employee_id"]
        reports = [p for p in people.values() if p.manager_id == me]
        units = set(pr.get("org_units") or [])
        boss = people[me].manager_id
        peers = {p.employee_id for p in people.values() if boss and p.manager_id == boss and p.employee_id != me}
        report_ids = {p.employee_id for p in reports}
        sel_map: dict[str, Callable[[Person], bool]] = {
            "self": lambda p: p.employee_id == me,
            "direct_report": lambda p: p.manager_id == me and self._active_ok(p) and not p.is_restricted and not p.held,
            "restricted_direct_report": lambda p: p.manager_id == me and self._active_ok(p) and p.is_restricted,
            "held_direct_report": lambda p: p.manager_id == me and self._active_ok(p) and p.held,
            "skip_level_report": lambda p: p.manager_id in report_ids and self._active_ok(p) and not p.is_restricted,
            "peer_report": lambda p: p.manager_id in peers and self._active_ok(p) and not p.is_restricted,
            "in_unit": lambda p: p.org_unit in units and self._active_ok(p) and not p.is_restricted and not p.held,
            "restricted_in_unit": lambda p: p.org_unit in units and self._active_ok(p) and p.is_restricted,
            "terminated_in_unit": lambda p: p.org_unit in units and live(p) and p.status == "terminated",
            "held_in_unit": lambda p: p.org_unit in units and live(p) and p.held,
            "outside_unit": lambda p: p.org_unit not in units and self._active_ok(p) and not p.is_restricted,
        }
        if selector not in sel_map:
            raise Skip(f"unknown selector {selector}")
        chosen = [p for p in people.values() if sel_map[selector](p)]
        if selector == "self":
            return chosen
        return sorted((p for p in chosen if ok(p)), key=lambda p: p.employee_id)

    def deleted_in_scope(self, principal: str, purpose: str) -> list[Person]:
        """Completed deletions that the principal's purpose would otherwise have shown (the meaningful 404)."""
        pr = self.pop.principals.get(principal, {})
        units = set(pr.get("org_units") or [])
        me = pr.get("employee_id")
        out = []
        for p in sorted(self.pop.people.values(), key=lambda x: x.employee_id):
            if not self.live.deleted(p):
                continue
            if purpose == "employee_relations" and p.org_unit not in units:
                continue
            if purpose == "team_management" and (p.manager_id != me or p.is_restricted):
                continue
            if purpose == "workforce_analytics" and p.is_restricted:
                continue
            out.append(p)
        return out

    def subject(self, c: dict) -> Person | None:
        s = c.get("subject")
        if not s:
            return None
        if s["selector"] == "deleted":
            cands = self.deleted_in_scope(c["principal"], c.get("purpose") or "")
            if not cands:
                raise Skip("no completed deletion in this principal's scope yet")
            return cands[0]
        cands = self.scope(s["principal"], s["selector"], pick=True)
        if len(cands) <= s["index"]:
            raise Skip(f"no subject for selector {s['principal']}/{s['selector']} index {s['index']} in this population")
        return cands[s["index"]]


# ---- running the cases --------------------------------------------------------------------------------------------
@dataclass
class Env:
    """What the runner talks to. `request(principal, method, path, body, omit_csrf)` returns an httpx.Response-like
    object; `read_extract(key)` returns the object body; `principals` are the principals that have a token."""

    request: Callable
    read_extract: Callable[[str], str]
    principals: set[str]
    executor: str
    column_class: dict[str, str]
    purpose_ref: dict[str, str]


class AuditTail:
    """New audit events since the last call, through the privacy officer's audit API (no direct D1 access)."""

    def __init__(self, env: Env):
        self.env = env
        self.cursor = 0
        self._drain()

    def _page(self) -> tuple[list[dict], int | None]:
        r = self.env.request("privacy-01", "GET", f"/api/v1/privacy/audit?cursor={self.cursor}", None, False)
        if r.status_code != 200:
            raise Fail(f"audit API returned {r.status_code}")
        body = r.json()
        return body["events"], body.get("cursor")

    def _drain(self) -> list[dict]:
        out: list[dict] = []
        while True:
            events, nxt = self._page()
            out.extend(events)
            if events:
                self.cursor = max(self.cursor, max(int(e["seq"]) for e in events))
            if nxt is None:
                return out

    def new_events(self) -> list[dict]:
        return self._drain()


def _check(cond: bool, what: str) -> None:
    if not cond:
        raise Fail(what)


def _body(r) -> dict:
    try:
        b = r.json()
    except ValueError:
        return {}
    return b if isinstance(b, dict) else {}


def _all_rows(env: Env, principal: str, purpose: str) -> list[dict]:
    rows: list[dict] = []
    cursor = None
    for _ in range(MAX_PAGES):
        q = f"?cursor={cursor}" if cursor else ""
        r = env.request(principal, "GET", f"/api/v1/purposes/{purpose}/employees{q}", None, False)
        _check(r.status_code == 200, f"list page returned {r.status_code}")
        b = r.json()
        rows.extend(b.get("rows") or [])
        cursor = b.get("nextCursor")
        if not cursor:
            return rows
    raise Fail(f"more than {MAX_PAGES} pages")


class Runner:
    def __init__(self, env: Env, resolver: Resolver, *, allow_writes: bool):
        self.env, self.res, self.allow_writes = env, resolver, allow_writes
        self.audit: AuditTail | None = None
        self.placed_hold: str | None = None

    # -- mapping -------------------------------------------------------------------------------------------------
    def principal(self, c: dict) -> str:
        p = c["principal"]
        if p == "pv-executor-local":
            return self.env.executor
        if p not in self.env.principals:
            raise Skip(f"principal {p} has no token in this environment (only the persona principals and the executor do)")
        return p

    def ref(self, c: dict, s: Person) -> str:
        kind = c.get("ref_kind") or self.env.purpose_ref.get(c.get("purpose") or "", "employee_ref")
        ref = s.refs[kind]
        return ref[:-1] + ("b" if ref.endswith("a") else "a") if c.get("tamper") else ref

    def build(self, c: dict, s: Person | None) -> tuple[str, str, dict | None]:
        purpose = c.get("purpose") or ""
        a = c["action"]
        if a == "me":
            return "GET", "/api/v1/me", None
        if a == "executor_claim":
            # retention tasks exist only during the daily sweep; a 30-second lease at most delays one task briefly
            return "POST", "/api/v1/executor/tasks/claim", {"phases": ["retention"], "max": 1, "lease_seconds": 30}
        if a == "list_employees":
            qs = ""
            if c.get("query"):
                qs = "?" + "&".join(f"{k}={s.work_email if v == 'subject_work_email' else v}" for k, v in c["query"].items())
            return "GET", f"/api/v1/purposes/{purpose}/employees{qs}", None
        if a == "read_profile":
            return "GET", f"/api/v1/purposes/{purpose}/employees/{self.ref(c, s)}", None
        if a == "identity_lookup":
            # the full name is a unique prefix in this population (prefix-free last names), so the subject is never
            # pushed out of the 20-row page
            return "POST", f"/api/v1/purposes/{purpose}/identity-lookup", {"q": s.full_name if s else "zzz-no-match"}
        if a == "create_extract":
            return "POST", f"/api/v1/purposes/{purpose}/extracts", c.get("body")
        if a == "create_deletion_request":
            return "POST", "/api/v1/privacy/deletion-requests", {"employee_ref": s.refs["employee_ref"], "reason": "authorization case"}
        if a == "place_legal_hold":
            return "POST", "/api/v1/privacy/legal-holds", {"matter_id": AUTHZ_MATTER, "employee_ref": s.refs["employee_ref"], "reason": "authorization case"}
        if a == "release_legal_hold":
            if not self.placed_hold:
                raise Skip("no hold placed by this run to release (F05 did not run)")
            return "POST", f"/api/v1/privacy/legal-holds/{self.placed_hold}/release", None
        raise Skip(f"unknown action {a}")

    # -- one case ------------------------------------------------------------------------------------------------
    def run_case(self, c: dict) -> None:
        tok = c.get("token", "user")
        if tok in FORGED:
            raise Skip("forged, missing or unmapped tokens cannot pass Cloudflare Access (the edge answers first)")
        who = self.principal(c)
        writes = c["action"] in WRITE_CASES and c["expect"]["status"] < 400 and not c.get("omit_csrf")
        if writes and not self.allow_writes:
            raise Skip("writes production state (a deletion request or a legal hold); run with --allow-writes")
        s = self.res.subject(c)
        method, path, body = self.build(c, s)
        exp = c["expect"]
        if exp.get("audit") and self.audit is None:
            self.audit = AuditTail(self.env)
        elif exp.get("audit"):
            self.audit.new_events()
        r = self.env.request(who, method, path, body, bool(c.get("omit_csrf")))
        b = _body(r)
        _check(r.status_code == exp["status"], f"status {r.status_code}, expected {exp['status']}")
        if exp.get("code"):
            _check(b.get("code") == exp["code"], f"code {b.get('code')}, expected {exp['code']}")
        if c["action"] == "place_legal_hold" and r.status_code == 201:
            self.placed_hold = (b.get("hold") or {}).get("id") or b.get("id")
        if exp.get("class_visibility"):
            cls, vis = next(iter(exp["class_visibility"].items()))
            row = next((x for x in b.get("rows") or [] if x.get("employee_ref") == s.refs["employee_ref"]), None) if c["action"] == "identity_lookup" else b.get("profile")
            _check(row is not None, "subject row missing")
            self.class_visibility(row, cls, vis, s)
        self.row_checks(c, who, b)
        for sel in exp.get("lookup_finds") or []:
            cands = self.res.scope("*", sel, pick=True)
            if not cands:
                raise Skip(f"no {sel} subject in this population")
            t = cands[0]
            rr = self.env.request(who, "POST", f"/api/v1/purposes/{c['purpose']}/identity-lookup", {"q": t.full_name}, False)
            _check(t.refs["employee_ref"] in [x.get("employee_ref") for x in rr.json().get("rows") or []], f"{sel} subject not found by lookup")
        if exp.get("pseudonyms_distinct"):
            er = b["profile"]["employee_ref"]
            wa = self.env.request("analyst-01", "GET", f"/api/v1/purposes/workforce_analytics/employees/{s.refs['analytics_id']}", None, False)
            _check(wa.status_code == 200, f"analyst profile returned {wa.status_code}")
            wp = wa.json()["profile"]
            an = wp["analytics_id"]
            _check(len({er, an, s.refs["subject_ref"]}) == 3 and (er[:3], an[:3]) == ("er_", "an_"), "pseudonyms not distinct per kind")
            _check("employee_ref" not in wp and "analytics_id" not in b["profile"], "a profile carries the other purpose's pseudonym")
        if exp.get("audit"):
            self.audit_check(c, who, s)
        if exp.get("extract_no_direct_identifiers"):
            text = self.env.read_extract(str(b["key"]))
            lines = [json.loads(x) for x in text.strip().splitlines()]
            _check(len(lines) > 0, "extract is empty")
            banned = {k for k, v in self.env.column_class.items() if v == "direct_identifier"} | {"employee_ref", "employee_key"}
            for line in lines:
                _check(not (set(line) & banned), "extract has a direct identifier column")
                _check(not any(re.search(r"@|\bE\d{5}\b", str(v)) for v in line.values()), "extract value looks like an identifier")

    def class_visibility(self, row: dict, cls: str, vis: str, s: Person) -> None:
        cols = [k for k, v in self.env.column_class.items() if v == cls]
        present = [x for x in cols if x in row]
        rep = REPRESENTATIVE[cls]
        truth = s.entry()["truth"]
        if vis == "deny":
            _check(present == [], f"{cls} columns present")
        elif vis == "allow":
            _check(rep in row and row[rep] == truth.get(rep), f"{rep} missing or not the true value")
        elif vis == "mask_nullify":
            _check(len(present) > 0 and all(row[x] is None for x in present), f"{cls} not nulled")
        elif vis == "mask_date_year":
            _check(row.get(rep) == f"{str(truth.get(rep))[:4]}-01-01", f"{rep} not masked to January 1")

    def row_checks(self, c: dict, who: str, b: dict) -> None:
        r = c["expect"].get("rows") or {}
        if not r:
            return
        purpose = c["purpose"]
        rows = _all_rows(self.env, who, purpose)
        pr = self.res.pop.principals.get(c["principal"], {})
        if r.get("within_principal_units"):
            units = set(pr.get("org_units") or [])
            _check(all(x.get("org_unit") in units for x in rows), "a row outside the principal's units")
        if r.get("count_selectors"):
            want = [p for sel in r["count_selectors"] for p in self.res.scope(c["principal"], sel, pick=False)]
            sure = sum(1 for p in want if not self.res.live.uncertain(p))
            _check(sure <= len(rows) <= len(want), f"{len(rows)} rows, expected {sure} to {len(want)}")
        if r.get("equals_selectors"):
            want = {p.refs["employee_ref"] for sel in r["equals_selectors"] for p in self.res.scope(c["principal"], sel, pick=False)}
            _check({str(x.get("employee_ref")) for x in rows} == want, "rows differ from the direct reports")
        if r.get("excludes_selector"):
            ids = {p.refs["analytics_id"] for p in self.res.scope("*", r["excludes_selector"], pick=False)}
            _check(len(ids) > 0, "no subject to exclude")
            _check(not any(str(x.get("analytics_id")) in ids for x in rows), "an excluded subject is listed")
        if r.get("includes_selector"):
            got = {str(x.get("analytics_id")) for x in rows}
            want = [p for p in self.res.scope("*", r["includes_selector"], pick=False) if not self.res.live.uncertain(p)]
            _check(len(want) > 0 and all(p.refs["analytics_id"] in got for p in want), "an included subject is missing")
        if r.get("pseudonymous_only"):
            _check(len(rows) > 0, "no rows")
            for x in rows:
                _check(str(x.get("analytics_id", "")).startswith("an_"), "row without analytics_id")
                _check(not any(k in x for k in ("employee_ref", "employee_id", "work_email", "full_name", "personal_email")), "identified column in an analytics row")
                _check(not any(re.search(r"@|\bE\d{5}\b", str(v)) for v in x.values()), "identifier-like value in an analytics row")
        if r.get("employee_ref_no_raw_ids"):
            also = c["also"]
            second = _all_rows(self.env, self.principal({"principal": also["principal"]}), also["purpose"])
            allrows = rows + second
            _check(len(allrows) > 0, "no rows")
            for x in allrows:
                _check(bool(re.fullmatch(r"er_[a-z2-7]{26}", str(x.get("employee_ref")))), "row without employee_ref")
                _check("employee_id" not in x and not any(RAW_ID.search(str(v)) for v in x.values()), "raw employee id in a row")

    def audit_check(self, c: dict, who: str, s: Person | None) -> None:
        kind = c["expect"]["audit"]
        events = [e for e in self.audit.new_events() if e.get("actor") == who]
        _check(len(events) > 0, "no audit event for this request")
        ev = events[-1] if kind != "subject_ref_only" else next((e for e in reversed(events) if e.get("route") == "/api/v1/purposes/:purpose/employees/:ref"), events[-1])
        if kind == "deny_event":
            _check(ev.get("decision") == "deny", "no deny event")
        elif kind == "allow_event_with_row_count":
            _check(ev.get("decision") == "allow" and isinstance(ev.get("row_count"), int), "no allow event with a row count")
        elif kind == "subject_ref_only":
            _check(ev.get("subject_ref") == s.refs["subject_ref"], "event subject_ref differs")
            flat = json.dumps(ev)
            _check(not any(t in flat for t in (s.refs["employee_ref"], s.refs["analytics_id"], s.full_name, s.work_email)), "identifier in the audit event")
            _check(not RAW_ID.search(flat), "raw id in the audit event")
            _check(ev.get("route") == "/api/v1/purposes/:purpose/employees/:ref", "route is not the template")

    def run_all(self, cases: list[Case]) -> dict:
        out = {"passed": [], "failed": [], "skipped": []}
        for case in cases:
            c = case.raw
            try:
                self.run_case(c)
                out["passed"].append(case.id)
            except Skip as e:
                out["skipped"].append({"id": case.id, "reason": str(e)})
            except Fail as e:
                out["failed"].append({"id": case.id, "reason": str(e)})
            except Exception as e:  # noqa: BLE001  (a transport error is a failure of that case, reported by type)
                out["failed"].append({"id": case.id, "reason": f"{type(e).__name__}"})
        return out


def summarize(cases: list[Case], out: dict, header: dict, *, target: str, allow_writes: bool) -> dict:
    by_cat: dict[str, dict] = {}
    status = {i: "passed" for i in out["passed"]} | {x["id"]: "failed" for x in out["failed"]} | {x["id"]: "skipped" for x in out["skipped"]}
    for c in cases:
        d = by_cat.setdefault(c.category, {"cases": 0, "runnable": 0, "passed": 0, "skipped": 0})
        d["cases"] += 1
        st = status[c.id]
        d["runnable"] += st != "skipped"
        d["passed"] += st == "passed"
        d["skipped"] += st == "skipped"
    runnable = len(out["passed"]) + len(out["failed"])
    reasons: dict[str, int] = {}
    for x in out["skipped"]:
        reasons[x["reason"]] = reasons.get(x["reason"], 0) + 1
    return {
        **header,
        "kind": "authz",
        "cases_total": len(cases),
        "layers": {"api": {"target": target, "runnable": runnable, "passed": len(out["passed"]), "failed": len(out["failed"]), "skipped": len(out["skipped"]),
                           "allow_writes": allow_writes,
                           "runner": "pv authz api (the case file through the deployed API, full synthetic population, one token per persona principal and the executor)"}},
        "by_category": by_cat,
        "failures": out["failed"],
        "skipped": out["skipped"],
        "skip_reasons": reasons,
    }


def compiled_policy() -> tuple[dict[str, str], dict[str, str]]:
    pol = json.loads((config.POLICY_DIR / "compiled" / "policy.json").read_text())
    return pol["columnClass"], {k: v["ref"] for k, v in pol["purposes"].items()}


def live_state(request: Callable) -> LiveState:
    r = request("privacy-01", "GET", "/api/v1/privacy/deletion-requests", None, False)
    if r.status_code != 200:
        raise RuntimeError(f"deletion request list returned {r.status_code}")
    out: dict[str, set[str]] = {}
    for x in r.json()["requests"]:
        out.setdefault(x["subjectRef"], set()).add(x["status"])
    return LiveState(out)


def master_key_b64(target: str) -> bytes:
    if target == "local":
        return config.local_settings().master_key
    secrets = config.parse_env_file(config.SECRETS_DIR / "worker-secrets.env")
    if not secrets.get("PV_PSEUDONYM_MASTER_KEY"):
        raise RuntimeError("PV_PSEUDONYM_MASTER_KEY missing from .secrets/worker-secrets.env (run `npm run setup:prod`)")
    return base64.b64decode(secrets["PV_PSEUDONYM_MASTER_KEY"])


def _local_extract_reader(key: str) -> str:
    import subprocess

    res = subprocess.run([str(config.REPO_ROOT / "node_modules" / ".bin" / "wrangler"), "r2", "object", "get", f"pv-derived/{key}", "--local", "--pipe"],
                         cwd=config.REPO_ROOT, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise Fail("could not read the extract from local R2")
    return res.stdout


def _local_up() -> bool:
    import httpx

    try:
        return httpx.get(f"http://127.0.0.1:{config.WORKER_PORT}/api/health", timeout=3.0).status_code == 200
    except httpx.HTTPError:
        return False


def run_api(target: str, *, allow_writes: bool = False, start: bool = False, write_results: bool = False) -> dict:
    """Runs every case it can through the API of `target` and returns (and optionally writes) the result."""
    from peoplevault.evals.report import LOCAL_ENVIRONMENT, header, write_result

    column_class, purpose_ref = compiled_policy()
    started = False
    if target == "local":
        from peoplevault.evals.client import LocalClient

        gen_dir = config.GENERATED_DIR
        if not (gen_dir / "truth" / "subjects.json").exists():
            raise RuntimeError("no local population: run `npm run seed:local`")
        if not _local_up():
            if not start:
                raise RuntimeError("the local stack is not running: start it with `npm run dev`, or pass --start")
            from peoplevault.evals.deletion import _node

            _node(["scripts/dev.ts", "--detach"])
            started = True
        client = LocalClient(json.loads((gen_dir / "truth" / "principals.json").read_text()))
        env = Env(client.request, _local_extract_reader, set(TOKEN_PRINCIPALS), "pv-executor-local", column_class, purpose_ref)
        command = "pv authz api --target local" + (" --allow-writes" if allow_writes else "")
        environment = LOCAL_ENVIRONMENT
        name = "authz-api-local"
    else:
        from peoplevault.evals.client import PROD_EXECUTOR, ProdClient
        from peoplevault.evals.prod import PROD_ENVIRONMENT, PROD_GENERATED
        from peoplevault.evals.prod_stores import CloudflareRest, oauth_token

        gen_dir = PROD_GENERATED
        if not (gen_dir / "truth" / "subjects.json").exists():
            raise RuntimeError("no production population on this machine: run `npm run seed:prod` (it writes data/generated-prod)")
        penv = config.prod_env()
        client = ProdClient(penv)
        cf = CloudflareRest(penv.get("CLOUDFLARE_ACCOUNT_ID", ""), oauth_token())
        env = Env(client.request, lambda key: cf.r2_get("pv-derived", key).decode(), set(TOKEN_PRINCIPALS) & client.principals(), PROD_EXECUTOR, column_class, purpose_ref)
        command = "npm run authz:prod" + (" -- --allow-writes" if allow_writes else "")
        environment = PROD_ENVIRONMENT
        name = "authz-prod"
    try:
        run_header = header(command, environment=environment)
        pop = Population.load(gen_dir, master_key_b64(target))
        cases = load_cases()
        out = Runner(env, Resolver(pop, live_state(env.request)), allow_writes=allow_writes).run_all(cases)
    finally:
        if started:
            from peoplevault.evals.deletion import _node

            _node(["scripts/stop-local.ts"], check=False)
    result = summarize(cases, out, run_header, target=target, allow_writes=allow_writes)
    if write_results:
        result["written"] = str(write_result(f"{name}-{run_header['date']}.json", {k: v for k, v in result.items() if k != "written"}).relative_to(config.REPO_ROOT))
    return result


__all__ = ["Env", "LiveState", "Population", "Resolver", "Runner", "Skip", "compiled_policy", "live_state", "load_cases", "master_key_b64", "run_api", "summarize"]
