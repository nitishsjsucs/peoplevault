"""SCD2 snapshot replay: one `dbt snapshot` per weekly HRIS export date, in order (SPEC.md section 9.3)."""

from __future__ import annotations

import json

from peoplevault.dbtrun import DbtResult, run


def replay(export_dates: list[str], target: str = "local") -> list[DbtResult]:
    results = []
    for d in sorted(export_dates):
        res = run(["snapshot", "--target", target, "--vars", json.dumps({"pv_snapshot_export_date": d})])
        if not res.success:
            raise RuntimeError(f"dbt snapshot failed for export {d} ({res.exception})")
        results.append(res)
    return results
