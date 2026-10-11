"""`pv residuals check --target prod` (SPEC.md section 14.4). Status: written, not yet executed.

bq_time_travel: a token-free COUNT(*) FOR SYSTEM_TIME AS OF one second before the deletion, as peoplevault-executor (which
holds the custom role peoplevaultTimeTravelReader). Success means the pre-deletion version is still recoverable (pending);
only the documented out-of-window error clears it; any other error is error, never cleared.
iceberg_snapshots: pending while a snapshot older than the deletion commit is retained in the Basin Catalog.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from peoplevault.residuals.bq import classify_time_travel_error, time_travel_count_sql
from peoplevault.residuals.check import check_lake_residual


def _error_dict(exc: Exception) -> dict:
    errors = getattr(exc, "errors", None) or []
    first = errors[0] if errors else {}
    return {"reason": first.get("reason", type(exc).__name__), "message": first.get("message", str(exc))}


def check_bq_residual(wh, residual: dict, now: datetime | None = None) -> dict | None:
    now = now or datetime.now(UTC)
    detail = json.loads(residual.get("detail_json") or "{}")
    deleted_ms = int(datetime.fromisoformat(detail["deleted_at"].replace("Z", "+00:00")).timestamp() * 1000)
    try:
        wh.query(time_travel_count_sql(f"{wh.project}.{detail['table']}", deleted_ms))
        c = classify_time_travel_error(None)
    except Exception as e:  # noqa: BLE001
        c = classify_time_travel_error(_error_dict(e))
    if c.state == "pending":
        return None
    out = {"id": residual["id"], "state": c.state, "evidence": "observed"}
    if c.state == "cleared":
        out["clearedAt"] = now.isoformat().replace("+00:00", "Z")
    return out


def check_prod(api, wh, cat) -> dict:
    pending = api.pending_residuals()
    updates = []
    for r in pending:
        if r["kind"] == "bq_time_travel" and r["evidence"] == "observed":
            u = check_bq_residual(wh, r)
        elif r["kind"] == "iceberg_snapshots":
            u = check_lake_residual(cat, r)
        else:
            u = None
        if u:
            updates.append(u)
    return {"pending_before": len(pending), "updated": api.post_residuals(updates), "cleared": sum(1 for u in updates if u["state"] == "cleared"),
            "errors": sum(1 for u in updates if u["state"] == "error")}
