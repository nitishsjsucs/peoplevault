import type { AssetCategory, AssetDef } from "../../shared/policy-types.ts";
import { POLICY } from "../policy/compiled.ts";

/** The 13 registered assets from the compiled policy (SPEC.md section 8.5). */
export const ASSETS: readonly AssetDef[] = POLICY.assets;

export const ASSET_BY_ID: ReadonlyMap<string, AssetDef> = new Map(ASSETS.map((a) => [a.id, a]));

export function asset(id: string): AssetDef {
  const a = ASSET_BY_ID.get(id);
  if (!a) throw new Error(`unknown asset ${id}`);
  return a;
}

export function assetsByCategory(): Record<AssetCategory, AssetDef[]> {
  const out = Object.fromEntries(POLICY.categories.map((c) => [c, [] as AssetDef[]])) as Record<AssetCategory, AssetDef[]>;
  for (const a of ASSETS) out[a.category].push(a);
  return out;
}

export const WORKER_ASSETS: readonly AssetDef[] = ASSETS.filter((a) => a.executor === "worker");
export const PYTHON_ASSETS: readonly AssetDef[] = ASSETS.filter((a) => a.executor === "python");
