"""Live BigQuery suite (`-m bigquery`, skipped by default; needs the production setup in docs/PRODUCTION.md).
Run by the owner: `uv run --directory pipelines pytest -m bigquery`. Status: written, not yet executed."""

import pytest

from peoplevault import config

pytestmark = pytest.mark.bigquery


@pytest.fixture(scope="module")
def project():
    p = config.prod_env().get("PV_GCP_PROJECT")
    if not p:
        pytest.fail("PV_GCP_PROJECT missing from .secrets/prod.env")
    return p


def test_48_warehouse_cases_as_purpose_service_accounts(project):
    from peoplevault.authz.bq_ceiling import purpose_runner
    from peoplevault.authz.warehouse_runner import run_all

    report = run_all(purpose_runner(project))
    assert len(report.results) == 48 and report.passed == 48, [(r.id, r.detail) for r in report.results if not r.passed]


def test_37_ceiling_probes(project):
    from peoplevault.authz.bq_ceiling import run_probes

    res = run_probes(project)
    assert res["total"] == 37 and res["passed"] == 37, res


def test_tags_and_row_access_policies_on_every_protected_table(project):
    from peoplevault.setup.bq_controls import live_verify

    assert live_verify(project) == []


def test_time_travel_window_is_48_hours(project):
    from peoplevault.warehouse.bq import BqWarehouse

    wh = BqWarehouse(project)
    for ds in ("pv_raw", "pv_core", "pv_snapshots", "pv_restricted", "pv_marts"):
        assert wh.time_travel_hours(ds) == 48


def test_time_travel_read_as_executor(project):
    """A row-policy table read at now minus 1 minute as pv-executor succeeds (pvTimeTravelReader)."""
    from peoplevault.warehouse.bq import BqWarehouse

    rows = BqWarehouse(project).query(f"SELECT COUNT(*) AS n FROM `{project}.pv_core.dim_employee` FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 MINUTE)")
    assert rows[0]["n"] > 0
