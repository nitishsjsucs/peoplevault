import re

from synth_helpers import population, principals

from peoplevault.pseudo import TEST_MASTER_KEY, Pseudonymizer

ID_PATTERN = re.compile(r"^(hrbp-0[1-6]|mgr-(0\d\d|1[01]\d|120)|analyst-0[1-4]|privacy-0[12]|pv-executor-local)$")


def _all_tokens():
    pop = population()
    ps = Pseudonymizer(TEST_MASTER_KEY)
    out = []
    for e_id, e in pop.employees.items():
        refs = ps.all(e_id)
        out.extend([e_id, e.work_email, e.full_name, e.first_name.lower(), e.last_name.lower(), refs["employee_ref"], refs["warehouse_key"], refs["analytics_id"]])
        out.append(e_id[1:])  # digits of the id
    return out


def test_principal_ids_are_opaque():
    rows = principals()
    tokens = _all_tokens()
    for p in rows:
        assert ID_PATTERN.match(p.id), p.id
        low = p.id.lower()
        for t in tokens:
            assert t.lower() not in low, (p.id, "contains an identifier token")


def test_manager_ids_not_in_employee_id_order():
    rows = [p for p in principals() if p.persona == "manager"]
    by_pid = [p.employee_id for p in sorted(rows, key=lambda p: p.id)]
    assert by_pid != sorted(by_pid)
    hr = [p.employee_id for p in sorted((p for p in principals() if p.persona == "hr_partner"), key=lambda p: p.id)]
    assert len(hr) == 6
