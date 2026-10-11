import { describe, expect, it } from "vitest";
import { ASSETS, PYTHON_ASSETS, WORKER_ASSETS, assetsByCategory } from "../../src/worker/assets/registry.ts";
import { POLICY } from "../../src/worker/policy/compiled.ts";

// Same ids as pipelines/tests/test_policy_registry.py::EXPECTED (both read the one policy file).
const EXPECTED: Record<string, string> = {
  "src.r2.exports": "source_exports",
  "wh.raw": "warehouse_tables",
  "wh.core": "warehouse_tables",
  "hist.dbt.dim_employee_history": "historical_snapshots",
  "hist.lake.employee_monthly": "historical_snapshots",
  "id.d1.identity_records": "identity_mappings",
  "id.wh.identity_xref": "identity_mappings",
  "drv.marts.attrition_features": "derived_datasets",
  "drv.marts.team_roster": "derived_datasets",
  "drv.marts.headcount_monthly": "derived_datasets",
  "drv.r2.analytics_extracts": "derived_datasets",
  "cache.kv.profile_cards": "application_caches",
  "cache.kv.team_rosters": "application_caches",
};

describe("asset registry", () => {
  it("has exactly 13 assets in exactly the 6 categories", () => {
    expect(ASSETS).toHaveLength(13);
    expect(Object.fromEntries(ASSETS.map((a) => [a.id, a.category]))).toEqual(EXPECTED);
    const byCat = assetsByCategory();
    expect(Object.keys(byCat)).toEqual([
      "source_exports",
      "warehouse_tables",
      "historical_snapshots",
      "identity_mappings",
      "derived_datasets",
      "application_caches",
    ]);
    for (const list of Object.values(byCat)) expect(list.length).toBeGreaterThan(0);
  });

  it("splits worker-native and python-native assets by store", () => {
    expect(WORKER_ASSETS.map((a) => a.id).sort()).toEqual(
      ["cache.kv.profile_cards", "cache.kv.team_rosters", "drv.r2.analytics_extracts", "id.d1.identity_records", "src.r2.exports"].sort(),
    );
    for (const a of WORKER_ASSETS) expect(["r2", "kv", "d1"]).toContain(a.store);
    for (const a of PYTHON_ASSETS) expect(["warehouse", "iceberg"]).toContain(a.store);
  });

  it("source exports have the four export families with retention", () => {
    const exports = ASSETS.find((a) => a.id === "src.r2.exports")!;
    expect(exports.parts.map((p) => [p.name, p.retention?.days])).toEqual([
      ["hris", 56],
      ["payroll", 300],
      ["leave", 365],
      ["performance", 540],
    ]);
  });

  it("policy hash is a sha256 hex", () => {
    expect(POLICY.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
