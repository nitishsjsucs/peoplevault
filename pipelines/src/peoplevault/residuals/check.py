"""`pv residuals check --target local`: token-free state checks of pending residuals, posted to the Worker.

iceberg_snapshots: pending while any snapshot older than the deletion commit is retained, cleared otherwise.
iceberg_orphan_files (local, observed): pending while any recorded data file still exists, cleared otherwise.
BigQuery windows stay modeled locally; production observes them with time travel reads (see residuals/bq.py).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def check_lake_residual(cat, residual: dict, now: datetime | None = None) -> dict | None:
    now = now or datetime.now(UTC)
    detail = json.loads(residual.get("detail_json") or "{}")
    table = detail.get("table")
    if not table:
        return {"id": residual["id"], "state": "error", "evidence": residual["evidence"]}
    try:
        tbl = cat.load_table(table)
    except Exception:  # noqa: BLE001
        return {"id": residual["id"], "state": "error", "evidence": residual["evidence"]}
    if residual["kind"] == "iceberg_snapshots":
        deleted_ms = int(_parse(detail["deleted_at"]).timestamp() * 1000)
        older = [s for s in tbl.snapshots() if s.timestamp_ms < deleted_ms]
        if older:
            return None
        return {"id": residual["id"], "state": "cleared", "evidence": "observed", "clearedAt": now.isoformat().replace("+00:00", "Z")}
    if residual["kind"] == "iceberg_orphan_files":
        if residual["evidence"] != "observed":
            return None
        loc = tbl.location()
        data_dir = Path(urlparse(loc).path if loc.startswith("file://") else loc) / "data"
        if any((data_dir / f).exists() for f in detail.get("data_files") or []):
            return None
        return {"id": residual["id"], "state": "cleared", "evidence": "observed", "clearedAt": now.isoformat().replace("+00:00", "Z")}
    return None


def check_local(api, cat) -> dict:
    pending = api.pending_residuals()
    updates = []
    for r in pending:
        if r["kind"] in ("iceberg_snapshots", "iceberg_orphan_files"):
            u = check_lake_residual(cat, r)
            if u:
                updates.append(u)
    n = api.post_residuals(updates)
    return {"pending_before": len(pending), "updated": n, "cleared": sum(1 for u in updates if u["state"] == "cleared"), "errors": sum(1 for u in updates if u["state"] == "error")}
