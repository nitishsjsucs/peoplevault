"""Ground truth for the eval oracle: subjects, cohorts and the KV warm-up plan (SPEC.md sections 7.3 and 19.1).

The oracle reads truth, never the system. Cohorts are drawn deterministically with these constraints:
- R: every subject terminated on or before the retention cutoff (72, of which 2 held).
- D: 20 active non-managers, 8 active line managers, 12 recently terminated; never a principal used by the
  eval (HR partners, analysts, privacy officers), the CEO, an org head or a held subject. D managers never
  managed or reviewed a held subject at any point, so reference scrubbing never meets a held row.
- H: the 4 held subjects that are not retention-eligible (2 active, 2 recently terminated).
- F: 20 subjects with one planted residue each (R2 6, warehouse 5, Iceberg 3, KV 3, D1 3).
"""

from __future__ import annotations

from peoplevault.pseudo import Pseudonymizer
from peoplevault.synth import counts as C
from peoplevault.synth.exports import REFERENCE_COLUMNS, ExportObject
from peoplevault.synth.population import Population, rng
from peoplevault.synth.principals import PrincipalRow

FAULT_SCENARIOS: tuple[tuple[str, str], ...] = (
    ("r2", "r2.adhoc_export_rows"),
    ("r2", "r2.notes_email"),
    ("r2", "r2.derived_adhoc_extract"),
    ("r2", "r2.custom_metadata_ref"),
    ("r2", "r2.manager_reference_row"),
    ("r2", "r2.key_name_id"),
    ("warehouse", "wh.core_tmp_backup"),
    ("warehouse", "wh.marts_analyst_scratch"),
    ("warehouse", "wh.scratch_schema"),
    ("warehouse", "wh.restricted_legacy_xref"),
    ("warehouse", "wh.unregistered_email_text"),
    ("iceberg", "lake.adhoc_backup"),
    ("iceberg", "lake.scratch_namespace"),
    ("iceberg", "lake.adhoc_notes_analytics_id"),
    ("kv", "kv.tmp_employee_ref"),
    ("kv", "kv.report_summary_name"),
    ("kv", "kv.export_pending_analytics_id"),
    ("d1", "d1.support_notes"),
    ("d1", "d1.principal_aliases"),
    ("d1", "d1.cache_mirror"),
)
OUT_OF_DESIGN_VARIANTS: tuple[tuple[str, str], ...] = (
    ("r2", "variant.r2_uppercase_email"),
    ("d1", "variant.d1_last_comma_first"),
    ("kv", "variant.kv_base64_employee_id"),
)


def _is_old_terminated(pop: Population, e_id: str) -> bool:
    t = pop.employees[e_id].termination_date
    return t is not None and t <= C.SUBJECT_RETENTION_CUTOFF


def build_cohorts(pop: Population) -> dict:
    ids = pop.ids()
    emp = pop.employees
    held = pop.held_subjects()
    held_set = set(held)
    r_all = [e for e in ids if _is_old_terminated(pop, e)]
    assert len(r_all) == C.TERMINATED_PAST_RETENTION
    r_held = [e for e in r_all if e in held_set]
    r_eligible = [e for e in r_all if e not in held_set]  # employee id order: the Worker's deterministic order
    h_full = [e for e in held if e not in r_all]
    assert len(r_held) == 2 and len(h_full) == 4
    excluded = held_set | set(pop.hr_partners) | set(pop.analysts) | set(pop.privacy_officers)
    held_managers = {m for h in held for m in pop.managers_ever(h)}
    active_non_managers = [e for e in ids if emp[e].termination_date is None and not emp[e].is_manager and e not in excluded]
    line_managers = sorted(m for ms in pop.line_managers.values() for m in ms if m not in held_managers)
    recent_terminated = [e for e in ids if emp[e].termination_date is not None and not _is_old_terminated(pop, e) and e not in held_set]
    r = rng("cohorts")
    d_nm = r.sample(active_non_managers, C.COHORT_D_ACTIVE_NON_MANAGERS)
    d_m = r.sample(line_managers, C.COHORT_D_ACTIVE_MANAGERS)
    d_t = r.sample(recent_terminated, C.COHORT_D_TERMINATED_RECENT)
    d_full = d_nm + d_m + d_t
    taken = set(d_full)
    f_pool = [e for e in active_non_managers + recent_terminated if e not in taken]
    f_subjects = r.sample(sorted(f_pool), C.COHORT_F)
    f_full = [{"subject": s, "store": store, "scenario": scen} for s, (store, scen) in zip(f_subjects, FAULT_SCENARIOS, strict=True)]
    variants = [{"subject": f_full[i]["subject"], "store": store, "variant": v} for i, (store, v) in zip((0, 17, 14), OUT_OF_DESIGN_VARIANTS, strict=True)]
    f_ci: list[dict] = []
    for store in ("r2", "warehouse", "iceberg", "kv", "d1"):
        f_ci.append(next(f for f in f_full if f["store"] == store))
    d_ci = d_nm[:3] + d_m[:1] + d_t[:2]
    h_ci = [h_full[0], h_full[2]]  # one active, one recently terminated
    r_ci = r_eligible[: C.CI_MAX_SUBJECTS] + r_held
    cohorts = {
        "full": {"R": r_all, "R_held": r_held, "D": d_full, "D_groups": {"active_non_managers": d_nm, "active_managers": d_m, "terminated_recent": d_t}, "H": h_full, "F": f_full, "variants": variants},
        "ci": {"R": r_ci, "R_held": r_held, "D": d_ci, "H": h_ci, "F": f_ci, "variants": []},
        "prod": {"R": [], "R_held": [], "D": d_ci, "H": h_full[:1], "F": f_ci, "variants": []},
    }
    all_full = r_all + d_full + h_full + [f["subject"] for f in f_full]
    assert len(all_full) == len(set(all_full)) == 136
    return cohorts


def build_kv_warmup(pop: Population, principals: list[PrincipalRow], cohorts: dict, ps: Pseudonymizer) -> list[dict]:
    emp = pop.employees
    pid_of = {p.employee_id: p.id for p in principals if p.employee_id}
    hrbp_for_unit = {}
    for p in principals:
        if p.persona == "hr_partner":
            for u in p.org_units:
                hrbp_for_unit[u] = p.id
    analysts = sorted(p.id for p in principals if p.persona == "people_analyst")
    full = cohorts["full"]
    ci = cohorts["ci"]
    priority = list(dict.fromkeys(
        full["D"] + full["H"] + [f["subject"] for f in full["F"]] + ci["R"] + full["R"] + pop.ids()
    ))
    entries: list[dict] = []

    def take(n: int, purpose: str, eligible, reader, ref_kind: str) -> None:
        got = 0
        for e_id in priority:
            if got == n:
                break
            if eligible(e_id):
                entries.append({"principal": reader(e_id), "purpose": purpose, "kind": "profile", "ref": ps.pseudonym(ref_kind, e_id)})
                got += 1
        assert got == n, (purpose, got)

    take(C.KV_PROFILE_ER, "employee_relations", lambda e: True, lambda e: hrbp_for_unit[pop.final(e).org_unit], "employee_ref")
    take(
        C.KV_PROFILE_TM, "team_management",
        lambda e: emp[e].termination_date is None and not pop.final(e).is_restricted and pop.final(e).manager_id is not None,
        lambda e: pid_of[pop.final(e).manager_id], "employee_ref",
    )
    counter = {"i": 0}

    def analyst(_e: str) -> str:
        counter["i"] += 1
        return analysts[(counter["i"] - 1) % len(analysts)]

    take(C.KV_PROFILE_WA, "workforce_analytics", lambda e: not pop.final(e).is_restricted, analyst, "analytics_id")
    managers = sorted((p for p in principals if p.persona == "manager"), key=lambda p: p.id)
    for p in managers:
        entries.append({"principal": p.id, "purpose": "team_management", "kind": "team", "ref": ps.pseudonym("employee_ref", p.employee_id)})
    assert len(entries) == C.KV_ENTRIES
    keys = {(e["purpose"], e["kind"], e["ref"]) for e in entries}
    assert len(keys) == C.KV_ENTRIES, "warm-up entries must be distinct"
    return entries


def subject_truth(pop: Population, exports: list[ExportObject], lake_rows: dict[int, list[dict]], principals: list[PrincipalRow]) -> list[dict]:
    pid_of = {p.employee_id: p.id for p in principals if p.employee_id}
    rows_in: dict[str, dict[str, int]] = {e: {} for e in pop.ids()}
    refs_in: dict[str, dict[str, int]] = {e: {} for e in pop.ids()}
    record_ids: dict[str, list[str]] = {e: [] for e in pop.ids()}
    for obj in exports:
        for row in obj.rows:
            s = row["employee_id"]
            rows_in[s][obj.key] = rows_in[s].get(obj.key, 0) + 1
            for col in REFERENCE_COLUMNS[obj.family]:
                ref = row.get(col)
                if ref:
                    refs_in[ref][obj.key] = refs_in[ref].get(obj.key, 0) + 1
            for col in ("leave_id", "review_id"):
                if col in row:
                    record_ids[s].append(row[col])
    from peoplevault.retention_rules import minus_months

    lake_cutoff = minus_months(C.AS_OF, 84).isoformat()
    lake_count = {e: 0 for e in pop.ids()}
    lake_ref = {e: 0 for e in pop.ids()}
    lake_after = {e: 0 for e in pop.ids()}
    lake_ref_after = {e: 0 for e in pop.ids()}
    for rows in lake_rows.values():
        for row in rows:
            lake_count[row["employee_id"]] += 1
            after = row["month"] > lake_cutoff
            lake_after[row["employee_id"]] += int(after)
            if row["manager_employee_id"]:
                lake_ref[row["manager_employee_id"]] += 1
                lake_ref_after[row["manager_employee_id"]] += int(after)
    out = []
    for e_id in pop.ids():
        e = pop.employees[e_id]
        f = pop.final(e_id)
        out.append({
            "employee_id": e_id, "full_name": f.full_name, "first_name": f.first_name, "last_name": f.last_name,
            "work_email": f.work_email, "personal_email": f.personal_email, "phone": f.phone,
            "status": "active" if f.termination_date is None else "terminated",
            "hire_date": f.hire_date.isoformat(), "termination_date": f.termination_date.isoformat() if f.termination_date else None,
            "org_unit": f.org_unit, "manager_id": f.manager_id, "managers_ever": pop.managers_ever(e_id),
            "role": e.role, "is_restricted": f.is_restricted, "hold_matter": e.hold_matter, "principal_id": pid_of.get(e_id),
            "export_rows": rows_in[e_id], "export_refs": refs_in[e_id], "record_ids": record_ids[e_id],
            "lake_rows": lake_count[e_id], "lake_ref_rows": lake_ref[e_id],
            "lake_rows_after_retention_cutoff": lake_after[e_id], "lake_ref_rows_after_retention_cutoff": lake_ref_after[e_id],
        })
    return out
