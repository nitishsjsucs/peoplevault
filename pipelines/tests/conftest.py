from __future__ import annotations

import pytest

from peoplevault import logging_redact


@pytest.fixture(autouse=True)
def _redacting_logger():
    logging_redact.install()
    yield


@pytest.fixture(scope="session")
def empty_warehouse(tmp_path_factory):
    """Every dbt model built into an empty DuckDB (raw tables created, zero rows): {schema.table: [columns]}."""
    from peoplevault.policy.protected import build_empty_warehouse

    return build_empty_warehouse(tmp_path_factory.mktemp("wh") / "empty.duckdb")


@pytest.fixture(scope="session")
def bigquery_manifest():
    """dbt manifest parsed for target bigquery_ci (placeholder policy tag names, no credentials)."""
    import json

    from peoplevault import config
    from peoplevault.dbtrun import run

    result = run(["parse", "--target", "bigquery_ci"])
    assert result.success, result.exception
    return json.loads((config.DBT_DIR / "target" / "manifest.json").read_text())


def _load_world(root, only_keys=None):
    from peoplevault.load.run import load_local
    from peoplevault.pseudo import TEST_MASTER_KEY
    from peoplevault.synth.generate import generate

    gen = root / "gen"
    generate(gen, TEST_MASTER_KEY)
    result = load_local(
        suppressed=set(), master_key=TEST_MASTER_KEY, duckdb_path=root / "wh.duckdb", lake_root=root / "lake", generated=gen, only_keys=only_keys
    )
    return {"root": root, "gen": gen, "duckdb": root / "wh.duckdb", "lake": root / "lake", "result": result}


@pytest.fixture(scope="session")
def full_load(tmp_path_factory):
    """The full synthetic population loaded into a temp DuckDB and a temp Iceberg SqlCatalog (test master key)."""
    return _load_world(tmp_path_factory.mktemp("full"))


SMALL_KEYS = {
    "exports/hris/employees/dt=2026-09-21/employees.jsonl",
    "exports/hris/employees/dt=2026-09-28/employees.jsonl",
    "exports/payroll/compensation/period=2026-09/compensation.csv",
    "exports/leave/requests/month=2026-09/requests.jsonl",
    "exports/performance/reviews/cycle=2026H1/reviews.jsonl",
}


@pytest.fixture()
def small_load(tmp_path):
    """Five export objects loaded into a fresh temp warehouse (for tests that mutate it)."""
    return _load_world(tmp_path, SMALL_KEYS)
