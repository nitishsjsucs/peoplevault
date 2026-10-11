"""Cache warm-up and analytics extracts through the API as the personas (SPEC.md sections 6.7 step 6 and 19.1 step 3).
Cache entries expire 3600 s after writing, so the eval warms them right before submitting requests."""

from __future__ import annotations

import json

from peoplevault import config
from peoplevault.evals.client import LocalClient
from peoplevault.synth import counts as C


def load_truth(name: str):
    return json.loads((config.GENERATED_DIR / "truth" / name).read_text())


def warm_kv(client: LocalClient, entries: list[dict] | None = None) -> dict:
    entries = entries if entries is not None else load_truth("kv_warmup.json")
    ok = failed = 0
    for e in entries:
        if e["kind"] == "team":
            r = client.request(e["principal"], "GET", "/api/v1/purposes/team_management/team")
        else:
            r = client.request(e["principal"], "GET", f"/api/v1/purposes/{e['purpose']}/employees/{e['ref']}")
        if r.status_code == 200:
            ok += 1
        else:
            failed += 1
    return {"requested": len(entries), "ok": ok, "failed": failed}


def create_extracts(client: LocalClient, analyst: str = "analyst-01") -> dict:
    keys = []
    for month in C.EXTRACT_MONTHS:
        r = client.request(analyst, "POST", "/api/v1/purposes/workforce_analytics/extracts", {"month": month})
        r.raise_for_status()
        keys.append(r.json()["key"])
    return {"extracts": len(keys)}
