"""`dbt parse` must succeed for the BigQuery CI target without credentials (CI cannot compile)."""

from peoplevault.dbtrun import run


def test_dbt_parse_bigquery_ci_without_credentials(monkeypatch):
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    result = run(["parse", "--target", "bigquery_ci"])
    assert result.success, result.exception


def test_dbt_parse_local(tmp_path, monkeypatch):
    monkeypatch.setenv("PV_DUCKDB_PATH", str(tmp_path / "w.duckdb"))
    result = run(["parse", "--target", "local"])
    assert result.success, result.exception
