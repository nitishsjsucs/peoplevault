"""Every BigQuery query this package starts is byte-capped (SPEC.md sections 18.5 and 30.3.8)."""

import re
from pathlib import Path

import yaml

from peoplevault import bqjob

SRC = Path(__file__).resolve().parents[1] / "src" / "peoplevault"
PROFILES = Path(__file__).resolve().parents[1] / "dbt" / "profiles.yml"
# a BigQuery client's query method called directly (BqWarehouse.query and DuckDB connections are other objects)
DIRECT_QUERY = re.compile(r"\b(?:client|bq|self\.client|self\.bq|executor_client|executor)\.query\(|bigquery\.Client\([^)]*\)\.query\(")


def _sources():
    return [p for p in SRC.rglob("*.py") if p.name != "bqjob.py"]


def test_no_module_builds_its_own_query_job_config():
    offenders = [str(p.relative_to(SRC)) for p in _sources() if "QueryJobConfig(" in p.read_text()]
    assert offenders == []


def test_no_module_calls_a_bigquery_client_query_directly():
    offenders = [f"{p.relative_to(SRC)}:{i}" for p in _sources() for i, line in enumerate(p.read_text().splitlines(), 1) if DIRECT_QUERY.search(line)]
    assert offenders == []


def test_load_jobs_carry_the_job_id_prefix():
    for p in _sources():
        for i, line in enumerate(p.read_text().splitlines(), 1):
            if "load_table_from_" in line:
                assert "load_kwargs()" in line, f"{p.relative_to(SRC)}:{i}"


def test_run_query_sets_the_cap_the_prefix_and_no_cache():
    calls = []

    class FakeClient:
        def query(self, sql, job_config=None, job_id_prefix=None):
            calls.append((sql, job_config, job_id_prefix))
            return "job"

    assert bqjob.run_query(FakeClient(), "SELECT 1") == "job"
    bqjob.run_query(FakeClient(), "SELECT 2", max_bytes=bqjob.CEILING_PROBE_BYTES, labels={"purpose": "workforce_analytics"})
    (_, cfg, prefix), (_, probe_cfg, _) = calls
    assert prefix == "peoplevault_" == bqjob.JOB_ID_PREFIX
    assert cfg.maximum_bytes_billed == 1 << 30
    assert probe_cfg.maximum_bytes_billed == 100 * 1024 * 1024
    assert cfg.use_query_cache is False
    assert cfg.labels == {"app": "peoplevault"}
    assert probe_cfg.labels == {"app": "peoplevault", "purpose": "workforce_analytics"}
    assert bqjob.load_kwargs() == {"job_id_prefix": "peoplevault_"}


def test_bq_warehouse_goes_through_run_query():
    from peoplevault.warehouse.bq import BqWarehouse

    seen = []

    class Row(dict):
        def items(self):
            return super().items()

    class Job:
        def result(self):
            return [Row(n=1)]

    class FakeClient:
        def query(self, sql, job_config=None, job_id_prefix=None):
            seen.append((job_config.maximum_bytes_billed, job_id_prefix, job_config.labels))
            return Job()

    wh = BqWarehouse("proj", client=FakeClient())
    assert wh.query("SELECT 1 AS n WHERE $x = 1", {"x": 1}) == [{"n": 1}]
    assert seen == [(1 << 30, "peoplevault_", {"app": "peoplevault", "role": "executor"})]


def test_dbt_bigquery_profiles_cap_bytes():
    outputs = yaml.safe_load(PROFILES.read_text())["peoplevault"]["outputs"]
    for name in ("bigquery", "bigquery_actions", "bigquery_ci"):
        assert outputs[name]["maximum_bytes_billed"] == 1073741824, name
