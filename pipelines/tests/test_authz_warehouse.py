"""The 48 warehouse-layer authorization cases against a DuckDB built from world.yaml, through the shim query function."""

import pytest

from peoplevault.authz.cases import load_cases
from peoplevault.authz.warehouse_runner import WorldContext, run_all, run_case
from peoplevault.fixtures.world import build_warehouse, load_world
from peoplevault.shim.queries import run_named
from peoplevault.warehouse.duck import DuckWarehouse


@pytest.fixture(scope="module")
def world_wh(tmp_path_factory):
    path = tmp_path_factory.mktemp("world") / "world.duckdb"
    build_warehouse(load_world(), path)
    wh = DuckWarehouse.open(path)
    yield wh
    wh.close()


def test_exactly_48_warehouse_cases_all_pass(world_wh):
    report = run_all(lambda purpose, qid, params: run_named(world_wh, purpose, qid, params))
    assert len(report.results) == 48
    failed = [(r.id, r.detail) for r in report.results if not r.passed]
    assert failed == []
    assert report.by_category() == {"C": {"passed": 30, "total": 30}, "D": {"passed": 15, "total": 15}, "E": {"passed": 3, "total": 3}}


def test_cases_fail_when_the_ceiling_is_broken(world_wh):
    """A view that leaked compensation to team_management would fail the C case (the runner is not vacuous)."""
    ctx = WorldContext()
    case = next(c for c in load_cases() if c.id == "C-team_management-compensation")

    def leaky(purpose, qid, params):
        rows = run_named(world_wh, purpose, qid, params)
        return [{**r, "base_salary": 123456.0} for r in rows]

    with pytest.raises(AssertionError):
        run_case(ctx, leaky, case)
