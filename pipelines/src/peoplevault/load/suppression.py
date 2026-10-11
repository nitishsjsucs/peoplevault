"""Suppression list: subject_refs whose deletion has started. Loaders skip their rows and scrub references to
them, so a reload never resurrects an erased subject (SPEC.md sections 9.3 and 14.6)."""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime

from peoplevault import config


def from_d1_local() -> set[str]:
    """Reads D1 suppression_list from the local Miniflare state (wrangler d1 execute --local)."""
    wrangler = config.REPO_ROOT / "node_modules" / ".bin" / "wrangler"
    if not wrangler.exists() or not (config.REPO_ROOT / ".wrangler" / "state").exists():
        return set()
    res = subprocess.run(
        [str(wrangler), "d1", "execute", "pv-control", "--local", "--json", "--command", "SELECT subject_ref FROM suppression_list"],
        cwd=config.REPO_ROOT, capture_output=True, text=True, check=False,
    )
    if res.returncode != 0:
        raise RuntimeError("could not read the local D1 suppression list")
    out = res.stdout[res.stdout.index("[") :]
    return {r["subject_ref"] for r in json.loads(out)[0]["results"]}


def sync_duckdb(conn, subject_refs: set[str], request_id: str = "sync") -> int:
    """Adds missing subject_refs to peoplevault_restricted.suppression (append-only)."""
    existing = {r[0] for r in conn.execute("select subject_ref from peoplevault_restricted.suppression").fetchall()}
    new = sorted(subject_refs - existing)
    now = datetime.now(UTC).replace(tzinfo=None)
    for ref in new:
        conn.execute("insert into peoplevault_restricted.suppression values ($s, $r, $t)", {"s": ref, "r": request_id, "t": now})
    return len(new)
