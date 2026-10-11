// Plants eval faults into the local Miniflare state (R2 objects with custom metadata, KV entries, D1 ad hoc tables)
// while no wrangler dev is running. It writes through Miniflare's own storage API with the same persistence root as
// wrangler dev (.wrangler/state/v3); no product code is involved, and product code has no fault switches.
// Usage: node scripts/eval-plant.ts <plan.json> [state root, default .wrangler/state/v3]
import { readFileSync } from "node:fs";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { REPO_ROOT } from "./lib/run.ts";

interface Plan {
  r2?: { bucket: "pv-source-exports" | "pv-derived"; key: string; body: string; customMetadata?: Record<string, string> }[];
  kv?: { key: string; value: string }[];
  d1?: string[];
}

function stripJsonc(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

export async function plant(plan: Plan, stateRoot = path.join(REPO_ROOT, ".wrangler", "state", "v3")): Promise<{ r2: number; kv: number; d1: number }> {
  const cfg = JSON.parse(stripJsonc(readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf8")));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      resourcePersistencePath: stateRoot,
      name: "pv-eval-plant",
      modules: true,
      script: "export default { fetch() { return new Response('plant') } }",
      compatibilityDate: cfg.compatibility_date,
      r2Buckets: { EXPORTS: "pv-source-exports", DERIVED: "pv-derived" },
      kvNamespaces: { CACHE: cfg.kv_namespaces[0].id },
      d1Databases: { DB: cfg.d1_databases[0].database_id },
    }),
  );
  type Putter = { put(key: string, value: string, opts?: unknown): Promise<unknown> };
  try {
    const buckets = {
      "pv-source-exports": (await mf.getR2Bucket("EXPORTS")) as unknown as Putter,
      "pv-derived": (await mf.getR2Bucket("DERIVED")) as unknown as Putter,
    };
    for (const o of plan.r2 ?? []) await buckets[o.bucket].put(o.key, o.body, o.customMetadata ? { customMetadata: o.customMetadata } : {});
    const kv = (await mf.getKVNamespace("CACHE")) as unknown as Putter;
    for (const e of plan.kv ?? []) await kv.put(e.key, e.value);
    const db = (await mf.getD1Database("DB")) as unknown as { exec(sql: string): Promise<unknown> };
    for (const sql of plan.d1 ?? []) {
      // D1 exec runs one statement per line; plant one statement at a time
      for (const stmt of sql.split(/;\s*/).map((x) => x.trim()).filter(Boolean)) await db.exec(stmt);
    }
    return { r2: plan.r2?.length ?? 0, kv: plan.kv?.length ?? 0, d1: plan.d1?.length ?? 0 };
  } finally {
    await mf.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/eval-plant.ts <plan.json>");
    process.exit(2);
  }
  const res = await plant(JSON.parse(readFileSync(file, "utf8")) as Plan, ...(process.argv[3] ? [path.resolve(process.argv[3])] : []));
  console.log(JSON.stringify(res));
}
