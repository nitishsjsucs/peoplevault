"""SCD2 snapshot replay: one `dbt snapshot` per weekly HRIS export date, in order (SPEC.md section 9.3).

The replay is idempotent: it applies only the export dates after the newest `export_date` already in the history.
The snapshot versions rows on the attribute columns (strategy `check`), so its newest export_date is the last
export that changed a row, and every later export already equals the current rows. Replaying an older export again
would compare it with the current rows and add backward-in-time versions; in production the merge-only snapshot
(ADR 0006) could not be repaired, and `pv load` is a normal recovery path (setup:prod re-runs seed:prod).
"""

from __future__ import annotations

import json

from peoplevault.dbtrun import DbtResult, run

SCHEMA, TABLE = "peoplevault_snapshots", "dim_employee_history"


def pending(export_dates: list[str], replayed_through: str | None) -> list[str]:
    """The export dates still to replay, oldest first."""
    dates = sorted(set(export_dates))
    return dates if replayed_through is None else [d for d in dates if d > replayed_through]


def replayed_through_duckdb(conn) -> str | None:
    """Newest export_date in the local history, or None when the snapshot does not exist yet or is empty."""
    exists = conn.execute("select count(*) from information_schema.tables where table_schema = $s and table_name = $t", {"s": SCHEMA, "t": TABLE}).fetchone()[0]
    if not exists:
        return None
    d = conn.execute(f"select max(export_date) from {SCHEMA}.{TABLE}").fetchone()[0]
    return None if d is None else str(d)[:10]


def replayed_through_bigquery(client, project: str) -> str | None:
    """Newest export_date in the production history (as peoplevault-executor, which every row access policy admits)."""
    from google.api_core.exceptions import NotFound

    from peoplevault.bqjob import run_query

    try:
        client.get_table(f"{project}.{SCHEMA}.{TABLE}")
    except NotFound:
        return None
    rows = list(run_query(client, f"SELECT CAST(MAX(export_date) AS STRING) AS d FROM `{project}.{SCHEMA}.{TABLE}`").result())
    return rows[0]["d"] if rows and rows[0]["d"] else None


def replay(export_dates: list[str], target: str = "local", *, replayed_through: str | None = None) -> list[DbtResult]:
    results = []
    for d in pending(export_dates, replayed_through):
        res = run(["snapshot", "--target", target, "--vars", json.dumps({"pv_snapshot_export_date": d})])
        if not res.success:
            raise RuntimeError(f"dbt snapshot failed for export {d} ({res.exception})")
        results.append(res)
    return results
