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
