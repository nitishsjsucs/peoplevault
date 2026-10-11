from collections import Counter
from datetime import date

from synth_helpers import cohorts, exports, lake, population, principals

from peoplevault.synth import counts as C


def test_population_counts():
    pop = population()
    emps = list(pop.employees.values())
    assert len(emps) == 1200
    assert sorted(pop.employees) == [f"E{n:05d}" for n in range(1, 1201)]
    active = [e for e in emps if e.termination_date is None]
    terminated = [e for e in emps if e.termination_date is not None]
    assert len(active) == 1000 and len(terminated) == 200
    assert sum(1 for e in terminated if e.termination_date <= date(2023, 9, 30)) == 72
    assert sum(1 for e in terminated if e.termination_date > date(2023, 9, 30)) == 128


def test_unique_names_and_emails():
    emps = population().employees.values()
    assert len({e.full_name for e in emps}) == 1200
    assert len({e.work_email for e in emps}) == 1200
    for e in emps:
        assert e.work_email.endswith("@peoplevault.test") and e.personal_email.endswith("@example.test")
        assert e.phone.startswith("+1-555-01") and len(e.phone) == 11
        assert e.ethnicity in {"group_a", "group_b", "group_c", "group_d", "group_e"}


def test_org_structure():
    pop = population()
    emps = pop.employees
    assert len(C.ORG_UNITS) == 12
    assert {pop.final(e).org_unit for e in emps if emps[e].termination_date is None} == set(C.ORG_UNITS)
    managers = [e for e in emps.values() if e.is_manager]
    assert len(managers) == 120
    assert Counter(e.role for e in managers) == {"ceo": 1, "org_head": 11, "line_manager": 108}
    assert emps["E00001"].role == "ceo"
    active = [e for e in emps if emps[e].termination_date is None]
    reports = Counter(pop.final(e).manager_id for e in active)
    for m in managers:
        assert m.termination_date is None and reports[m.employee_id] >= 1
    for e in active:
        f = pop.final(e)
        if not f.is_manager:
            assert pop.final(f.manager_id).org_unit == f.org_unit


def test_restricted_population():
    pop = population()
    restricted = [e for e in pop.employees.values() if e.is_restricted and e.termination_date is None]
    assert len(restricted) == 24
    assert Counter(e.role for e in restricted) == {"ceo": 1, "org_head": 11, "staff": 12}


def test_principals():
    rows = principals()
    assert len(rows) == 133
    assert Counter(p.persona for p in rows if p.kind == "human") == {"hr_partner": 6, "manager": 120, "people_analyst": 4, "privacy_officer": 2}
    assert [p.id for p in rows if p.kind == "system"] == ["pv-executor-local"]
    hr_units = [u for p in rows if p.persona == "hr_partner" for u in p.org_units]
    assert len(hr_units) == 12 and set(hr_units) == set(C.ORG_UNITS)
    for p in rows:
        if p.persona == "hr_partner":
            assert len(p.org_units) == 2
    emails = {p.email for p in rows if p.email}
    assert len(emails) == 132
    pop = population()
    for p in rows:
        if p.employee_id:
            assert p.email == pop.employees[p.employee_id].work_email
            assert pop.employees[p.employee_id].termination_date is None


def test_legal_holds():
    pop = population()
    assert list(pop.holds) == ["LH-2026-001", "LH-2026-002"]
    held = pop.held_subjects()
    assert len(held) == 6 and len(set(held)) == 6
    e = pop.employees
    m1, m2 = pop.holds["LH-2026-001"], pop.holds["LH-2026-002"]
    assert sum(1 for s in m1 if e[s].termination_date and e[s].termination_date <= date(2023, 9, 30) and e[s].hire_date < date(2019, 10, 1)) == 2
    assert sum(1 for s in m1 if e[s].termination_date is None) == 1
    assert sum(1 for s in m2 if e[s].termination_date is None) == 1
    assert sum(1 for s in m2 if e[s].termination_date and e[s].termination_date > date(2023, 9, 30)) == 2


def test_attribute_changes():
    pop = population()
    assert Counter(c.kind for c in pop.changes) == {"promotion": 60, "transfer": 40, "manager_change": 30}
    for c in pop.changes:
        assert 1 <= c.export_index <= 12


def test_export_objects():
    objs = exports()
    assert len(objs) == 41
    assert Counter(o.family for o in objs) == {"hris": 13, "payroll": 12, "leave": 12, "performance": 4}
    hris = [o for o in objs if o.family == "hris"]
    assert hris[0].key == "exports/hris/employees/dt=2026-07-06/employees.jsonl"
    assert hris[-1].key == "exports/hris/employees/dt=2026-09-28/employees.jsonl"
    assert [o.key.split("cycle=")[1][:6] for o in objs if o.family == "performance"] == ["2024H2", "2025H1", "2025H2", "2026H1"]
    for o in objs:
        for row in o.rows:
            if "leave_id" in row:
                assert row["leave_id"].startswith("LV-") and row["leave_id"][3:].isdigit() and len(row["leave_id"]) == 9
            if "review_id" in row:
                assert row["review_id"].startswith("RV-") and len(row["review_id"]) == 9


def test_lake_history():
    rows = lake()
    assert sorted(rows) == list(range(2019, 2027))
    months = {r["month"] for rs in rows.values() for r in rs}
    assert len(months) == 93 and min(months) == "2019-01-01" and max(months) == "2026-09-01"


def test_cohort_sizes():
    c = cohorts()
    full = c["full"]
    assert len(full["R"]) == 72 and len(full["R_held"]) == 2
    assert len(full["D"]) == 40 and len(full["H"]) == 4 and len(full["F"]) == 20
    assert {k: len(v) for k, v in full["D_groups"].items()} == {"active_non_managers": 20, "active_managers": 8, "terminated_recent": 12}
    everyone = full["R"] + full["D"] + full["H"] + [f["subject"] for f in full["F"]]
    assert len(everyone) == len(set(everyone)) == 136
    assert Counter(f["store"] for f in full["F"]) == {"r2": 6, "warehouse": 5, "iceberg": 3, "kv": 3, "d1": 3}
    assert len(full["variants"]) == 3
    ci = c["ci"]
    assert len(ci["R"]) == 12 and len(ci["D"]) == 6 and len(ci["H"]) == 2 and len(ci["F"]) == 5
    assert [f["store"] for f in ci["F"]] == ["r2", "warehouse", "iceberg", "kv", "d1"]


def test_held_subjects_managers_outside_every_cohort():
    pop = population()
    c = cohorts()["full"]
    cohort_subjects = set(c["R"] + c["D"] + c["H"] + [f["subject"] for f in c["F"]])
    for h in pop.held_subjects():
        for m in pop.managers_ever(h):
            assert m not in cohort_subjects
