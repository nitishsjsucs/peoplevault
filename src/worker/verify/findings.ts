// Findings and location-to-asset mapping for the Worker probes (no imports from erase/ or workflows/).
import type { AssetCategory } from "../../shared/policy-types.ts";
import { ASSETS } from "../assets/registry.ts";
import { POLICY } from "../policy/compiled.ts";

export interface Finding {
  store: "r2" | "kv" | "d1" | "warehouse" | "iceberg";
  location: string;
  assetId: string | null;
  matches: number;
}

export interface ProbeError {
  store: "r2" | "kv" | "d1";
  location: string;
  error: string;
}

export interface ProbeResult {
  findings: Finding[];
  errors: ProbeError[];
  scanned: number;
}

export function r2AssetFor(bucket: string, key: string): string | null {
  for (const a of ASSETS) {
    if (a.store !== "r2") continue;
    const assetBucket = a.location.split("/")[0];
    if (assetBucket !== bucket) continue;
    for (const p of a.parts) if (p.location && key.startsWith(p.location)) return a.id;
  }
  return null;
}

export function kvAssetFor(key: string): string | null {
  if (key.startsWith("profile:")) return "cache.kv.profile_cards";
  if (key.startsWith("team:")) return "cache.kv.team_rosters";
  return null;
}

export function d1AssetFor(table: string): string | null {
  return table === "identity_map" || table === "principals" ? "id.d1.identity_records" : null;
}

/** Category under which an unregistered location's residue is counted (the store's role). */
export function categoryForLocation(store: Finding["store"], location: string): AssetCategory {
  switch (store) {
    case "r2":
      return location.startsWith("pv-derived/") ? "derived_datasets" : "source_exports";
    case "kv":
      return "application_caches";
    case "d1":
      return "identity_mappings";
    case "iceberg":
      return "historical_snapshots";
    case "warehouse": {
      const ds = location.split(".")[0] ?? "";
      const p = POLICY.naming.prefix;
      if (ds === `${p}_snapshots`) return "historical_snapshots";
      if (ds === `${p}_restricted`) return "identity_mappings";
      if (ds === `${p}_marts`) return "derived_datasets";
      return "warehouse_tables";
    }
  }
}
