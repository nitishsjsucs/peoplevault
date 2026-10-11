"""`pv fixtures check`: the committed Worker fixtures match a rebuild of world.yaml through the real loaders and
dbt (the DuckDB cross-check of the hand-authored world)."""

import json

from peoplevault import config
from peoplevault.fixtures.world import check, load_world


def test_committed_fixtures_match_a_rebuild():
    assert check() == []


def test_world_shape():
    world = load_world()
    emps = world["employees"]
    assert len(emps) == 40
    assert {e["unit"] for e in emps} == set(world["org_units"]) and len(world["org_units"]) == 4
    assert sum(1 for e in emps if e.get("deleted")) == 3
    assert sum(1 for e in emps if e.get("held")) == 1
    assert any(p.get("status") == "disabled" for p in world["principals"])
    hr = [p for p in world["principals"] if p.get("persona") == "hr_partner"]
    assert len(hr) == 2 and set(hr[0]["org_units"]).isdisjoint(hr[1]["org_units"])


def test_deleted_subjects_never_reach_the_warehouse():
    rows = json.loads((config.FIXTURES_DIR / "purpose_rows.json").read_text())["views"]
    subjects = json.loads((config.FIXTURES_DIR / "authz_subjects.json").read_text())["principals"]["*"]["deleted"]
    refs = {s["employee_ref"] for s in subjects} | {s["analytics_id"] for s in subjects}
    for view_rows in rows.values():
        for r in view_rows:
            assert not refs & set(map(str, r.values()))
