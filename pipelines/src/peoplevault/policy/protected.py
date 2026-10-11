"""Protected BigQuery tables (ADR 0006): tagged columns or row access policies, created once, then changed only
by MERGE and DML. Their columns are pinned in infra/bigquery/protected_schemas.json; a change needs an explicit
migration in infra/bigquery/migrations/ (ALTER TABLE ... ADD COLUMN), because with on_schema_change: ignore a new
column in the model changes nothing in an existing table.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import duckdb

from peoplevault import config

PROTECTED_MODELS: dict[str, str] = {
    "dim_employee": "pv_core.dim_employee",
    "fct_compensation": "pv_core.fct_compensation",
    "fct_leave": "pv_core.fct_leave",
    "fct_performance": "pv_core.fct_performance",
    "dim_employee_history": "pv_snapshots.dim_employee_history",
    "attrition_features": "pv_marts.attrition_features",
    "team_roster": "pv_marts.team_roster",
}
REBUILT_MODELS: dict[str, str] = {"headcount_monthly": "pv_marts.headcount_monthly"}
SCHEMAS_FILE = config.REPO_ROOT / "infra" / "bigquery" / "protected_schemas.json"
MIGRATIONS_DIR = config.REPO_ROOT / "infra" / "bigquery" / "migrations"
_ADD = re.compile(r"alter\s+table\s+`?(?:[\w-]+\.)?(\w+\.\w+)`?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)", re.I)


def build_empty_warehouse(path: Path) -> dict[str, list[str]]:
    """Builds every dbt model into an empty DuckDB file and returns {schema.table: [columns]} for all tables."""
    from peoplevault.dbtrun import run
    from peoplevault.load.schema import create_all_duckdb

    conn = duckdb.connect(str(path))
    create_all_duckdb(conn)
    conn.close()
    old = os.environ.get("PV_DUCKDB_PATH")
    os.environ["PV_DUCKDB_PATH"] = str(path)
    try:
        result = run(["build", "--target", "local"])
    finally:
        if old is None:
            os.environ.pop("PV_DUCKDB_PATH", None)
        else:
            os.environ["PV_DUCKDB_PATH"] = old
    if not result.success:
        raise RuntimeError(f"dbt build on an empty warehouse failed ({result.exception})")
    conn = duckdb.connect(str(path))  # same configuration as the in-process dbt-duckdb connection
    try:
        rows = conn.execute(
            "select table_schema || '.' || table_name, column_name from information_schema.columns "
            "where table_schema like 'pv_%' order by table_schema, table_name, ordinal_position"
        ).fetchall()
    finally:
        conn.close()
    out: dict[str, list[str]] = {}
    for table, col in rows:
        out.setdefault(table, []).append(col)
    return out


def migration_columns() -> dict[str, list[str]]:
    added: dict[str, list[str]] = {}
    if MIGRATIONS_DIR.exists():
        for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
            for table, col in _ADD.findall(f.read_text()):
                added.setdefault(table, []).append(col)
    return added


def committed_schemas() -> dict[str, list[str]]:
    return json.loads(SCHEMAS_FILE.read_text())["baseline"]


def expected_columns() -> dict[str, list[str]]:
    base = {k: list(v) for k, v in committed_schemas().items()}
    for table, cols in migration_columns().items():
        base.setdefault(table, []).extend(c for c in cols if c not in base.get(table, []))
    return base


def render_baseline(columns: dict[str, list[str]]) -> str:
    baseline = {table: columns[table] for table in PROTECTED_MODELS.values()}
    doc = {
        "description": "Columns of every protected BigQuery table (ADR 0006). Changing a protected model's columns needs a "
        "migration file in infra/bigquery/migrations/ (ALTER TABLE ... ADD COLUMN); test_dbt_materializations.py enforces it.",
        "baseline": baseline,
    }
    return json.dumps(doc, indent=2) + "\n"
