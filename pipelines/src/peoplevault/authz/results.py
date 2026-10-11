"""Summary of both authorization layers for `npm run eval:authz` (SPEC.md section 19.2)."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from peoplevault.authz.cases import load_cases
from peoplevault.authz.warehouse_runner import Report
from peoplevault.evals.report import header, write_result


def pdp_results(vitest_json: Path) -> dict[str, bool]:
    """case id -> passed, from the vitest JSON report of test/worker/authz.cases.test.ts."""
    data = json.loads(vitest_json.read_text())
    out: dict[str, bool] = {}
    for f in data.get("testResults", []):
        for a in f.get("assertionResults", []):
            title = a.get("title", "")
            if ":" in title:
                out[title.split(":", 1)[0]] = a.get("status") == "passed"
    return out


def summarize(pdp: dict[str, bool], warehouse: Report, command: str) -> dict:
    cases = load_cases()
    wh = {r.id: r.passed for r in warehouse.results}
    by_cat: dict[str, dict] = {}
    for c in cases:
        d = by_cat.setdefault(c.category, {"cases": 0, "pdp_passed": 0, "warehouse_cases": 0, "warehouse_passed": 0})
        d["cases"] += 1
        d["pdp_passed"] += int(pdp.get(c.id, False))
        if "warehouse" in c.layers:
            d["warehouse_cases"] += 1
            d["warehouse_passed"] += int(wh.get(c.id, False))
    return {
        **header(command),
        "kind": "authz",
        "cases_total": len(cases),
        "layers": {
            "pdp": {"passed": sum(pdp.get(c.id, False) for c in cases), "total": len(cases), "runner": "vitest test/worker/authz.cases.test.ts (Worker app, fixture world, FakeWarehouse over real DuckDB view rows)"},
            "warehouse": {"passed": warehouse.passed, "total": len(warehouse.results), "runner": "pv authz warehouse --target local (DuckDB purpose views through the shim query function)", "backend": "duckdb"},
        },
        "by_category": dict(sorted(by_cat.items())),
        "failures": {"pdp": sorted(k for k, v in pdp.items() if not v), "warehouse": sorted(r.id for r in warehouse.results if not r.passed)},
    }


def write(summary: dict) -> Path:
    return write_result(f"authz-local-{date.today().isoformat()}.json", summary)
