"""`pv synth`: writes exports, history, D1 seed, truth and the golden counts (SPEC.md section 7)."""

from __future__ import annotations

import json
import shutil
from datetime import date
from pathlib import Path

from peoplevault import retention_rules as rr
from peoplevault.policy.model import policy
from peoplevault.pseudo import Pseudonymizer
from peoplevault.synth import counts as C
from peoplevault.synth.exports import ExportObject, all_exports, month_end
from peoplevault.synth.history import monthly_rows
from peoplevault.synth.population import Population, build_population
from peoplevault.synth.principals import build_principals, seed_sql
from peoplevault.synth.truth import build_cohorts, build_kv_warmup, subject_truth

PART_OF_FAMILY = {"hris": "hris", "payroll": "payroll", "leave": "leave", "performance": "performance"}


def _dump(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=False) + "\n")


def export_retention_days() -> dict[str, int]:
    asset = next(a for a in policy().assets if a.id == "src.r2.exports")
    return {p.name: int(p.retention.days) for p in asset.parts if p.retention and p.retention.days}


def retention_expectations(pop: Population, exports: list[ExportObject], lake_rows: dict[int, list[dict]], cohorts: dict, as_of: date = C.AS_OF) -> dict:
    held = set(pop.held_subjects())
    days = export_retention_days()
    expired = [o for o in exports if rr.is_past(o.basis_date, rr.minus_days(as_of, days[PART_OF_FAMILY[o.family]]))]
    minimized = [o for o in expired if any(r["employee_id"] in held for r in o.rows)]
    raw_expired: dict[str, int] = {}
    for o in expired:
        raw_expired[o.family] = raw_expired.get(o.family, 0) + sum(1 for r in o.rows if r["employee_id"] not in held)
    extract_cutoff = rr.minus_days(as_of, 90)
    extracts = [m for m in C.EXTRACT_MONTHS if rr.is_past(month_end(m), extract_cutoff)]
    lake_cutoff = rr.minus_months(as_of, 84)
    lake_expired = sum(1 for rows in lake_rows.values() for r in rows if rr.is_past(date.fromisoformat(r["month"]), lake_cutoff) and r["employee_id"] not in held)
    full_r, ci_r = cohorts["full"], cohorts["ci"]
    base = {
        "export_objects_expired": len(expired),
        "export_objects_deleted": len(expired) - len(minimized),
        "export_objects_minimized_for_hold": len(minimized),
        "expired_export_keys": [o.key for o in expired],
        "minimized_export_keys": [o.key for o in minimized],
        "raw_rows_expired": dict(sorted(raw_expired.items())),
        "extracts_expired": len(extracts),
        "lake_rows_expired_employee_monthly": lake_expired,
    }
    full = dict(base, retention_requests=len(full_r["R"]) - len(full_r["R_held"]), retention_held=len(full_r["R_held"]))
    ci = dict(base, retention_requests=len(ci_r["R"]) - len(ci_r["R_held"]), retention_held=len(ci_r["R_held"]))
    return {"retention_expected": full, "retention_expected_ci": ci}


def expected_counts(pop: Population, exports: list[ExportObject], lake_rows: dict[int, list[dict]], cohorts: dict, principals_n: int) -> dict:
    export_rows: dict[str, dict] = {}
    for o in exports:
        fam = export_rows.setdefault(o.family, {"objects": {}, "total": 0})
        fam["objects"][o.key] = len(o.rows)
        fam["total"] += len(o.rows)
    out = {
        "description": "Golden counts from `pv synth` ground truth (SPEC.md section 7.2). Regenerate with `pv synth --write-expected` and review the diff in the same commit.",
        "population": {
            "employees_ever": C.EMPLOYEES_EVER, "active": sum(1 for e in pop.employees.values() if e.termination_date is None),
            "terminated": sum(1 for e in pop.employees.values() if e.termination_date is not None),
            "managers": sum(1 for e in pop.employees.values() if e.is_manager),
            "restricted_active": sum(1 for e in pop.employees.values() if e.is_restricted and e.termination_date is None),
            "held_subjects": len(pop.held_subjects()),
            "changes": {k: sum(1 for c in pop.changes if c.kind == k) for k in ("promotion", "transfer", "manager_change")},
        },
        "export_objects": len(exports),
        "export_rows": export_rows,
        "export_rows_total": sum(len(o.rows) for o in exports),
        "lake": {"employee_monthly": {"rows": sum(len(r) for r in lake_rows.values()), "appends": len(lake_rows), "months": C.LAKE_MONTHS}},
        "d1": {"principals": principals_n, "identity_map": C.EMPLOYEES_EVER, "legal_holds": len(pop.held_subjects())},
        "kv": {"profile": C.KV_PROFILE_ER + C.KV_PROFILE_TM + C.KV_PROFILE_WA, "team": C.KV_TEAM},
        "extracts": len(C.EXTRACT_MONTHS),
        "cohorts": {
            profile: {k: len(v) for k, v in cohorts[profile].items() if isinstance(v, list)} for profile in ("full", "ci", "prod")
        },
    }
    out.update(retention_expectations(pop, exports, lake_rows, cohorts))
    return out


def generate(out_dir: Path, master_key: bytes, *, clean: bool = True) -> dict:
    """Writes everything under out_dir and returns the expected counts (not written; see write_expected)."""
    if clean and out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ps = Pseudonymizer(master_key)
    pop = build_population()
    exports = all_exports(pop)
    lake_rows = monthly_rows(pop)
    principals = build_principals(pop)
    cohorts = build_cohorts(pop)
    warmup = build_kv_warmup(pop, principals, cohorts, ps)
    for o in exports:
        target = out_dir / o.key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(o.body())
    for year, rows in sorted(lake_rows.items()):
        target = out_dir / "history" / "employee_monthly" / f"year={year}.jsonl"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("".join(json.dumps(r) + "\n" for r in rows))
    (out_dir / "seed.sql").write_text(seed_sql(pop, principals, ps))
    _dump(out_dir / "manifest.json", {
        "seed": C.SEED, "as_of": C.AS_OF.isoformat(),
        "exports": [{"key": o.key, "family": o.family, "basis_date": o.basis_date.isoformat(), "rows": len(o.rows), "format": o.fmt} for o in exports],
        "extract_months": list(C.EXTRACT_MONTHS),
    })
    _dump(out_dir / "truth" / "subjects.json", subject_truth(pop, exports, lake_rows, principals))
    _dump(out_dir / "truth" / "cohorts.json", cohorts)
    _dump(out_dir / "truth" / "kv_warmup.json", warmup)
    _dump(out_dir / "truth" / "principals.json", [p.__dict__ for p in principals])
    _dump(out_dir / "truth" / "holds.json", pop.holds)
    return expected_counts(pop, exports, lake_rows, cohorts, len(principals))
