// npm run seed:local [-- --fresh]: seeds the local stand-ins (SPEC.md section 6.7).
//   1. --fresh: delete .wrangler/state, pipelines/.data and data/generated
//   2. pv synth (master key from .dev.vars)
//   3. D1 migrations and seed (principals, identity_map, legal_holds)
//   4. R2 source exports (41 objects) with `wrangler r2 object put --local`
//   5. pv load --target local (warehouse, identity xref, snapshot replay, dbt build, Iceberg)
//   6. KV warm-up and analytics extracts through the API (wrangler dev + pv serve)
//   7. verify counts against data/expected_counts.json; exit 1 on any mismatch
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { busyStackPorts, startLocalStack } from "./dev.ts";
import { stopAll } from "./lib/pids.ts";
import { REPO_ROOT, parseJsonOutput, pv, wrangler } from "./lib/run.ts";

export const STEPS_IMPLEMENTED = [1, 2, 3, 4, 5, 6, 7] as const;

interface Manifest {
  exports: { key: string; family: string; rows: number }[];
}

function log(msg: string): void {
  console.log(`[seed:local] ${msg}`);
}

export async function d1Count(table: string): Promise<number> {
  const res = await wrangler(["d1", "execute", "pv-control", "--local", "--json", "--command", `SELECT COUNT(*) AS n FROM ${table}`]);
  const parsed = parseJsonOutput<{ results: { n: number }[] }[]>(res.stdout);
  return parsed[0]?.results[0]?.n ?? -1;
}

export async function seedD1(): Promise<void> {
  await wrangler(["d1", "migrations", "apply", "pv-control", "--local"]);
  await wrangler(["d1", "execute", "pv-control", "--local", "--file", "data/generated/seed.sql"]);
}

export async function seedR2(): Promise<number> {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "data/generated/manifest.json"), "utf8")) as Manifest;
  let n = 0;
  for (const obj of manifest.exports) {
    const file = path.join("data/generated", obj.key);
    const contentType = obj.key.endsWith(".csv") ? "text/csv" : "application/x-ndjson";
    await wrangler(["r2", "object", "put", `pv-source-exports/${obj.key}`, "--local", "--file", file, "--content-type", contentType], { retries: 2 });
    n++;
  }
  return n;
}

export async function verifyD1(expected: { d1: { principals: number; identity_map: number; legal_holds: number } }): Promise<string[]> {
  const problems: string[] = [];
  for (const [table, want] of Object.entries(expected.d1)) {
    const got = await d1Count(table);
    if (got !== want) problems.push(`d1.${table}: expected ${want}, found ${got}`);
  }
  return problems;
}

async function main(): Promise<void> {
  const fresh = process.argv.includes("--fresh");
  if (!existsSync(path.join(REPO_ROOT, ".dev.vars"))) {
    console.error("[seed:local] .dev.vars is missing; run `npm run dev:keys` first");
    process.exit(1);
  }
  // Step 6 starts its own stack, so a running one (npm run dev) would stop this run minutes later, after the state it
  // serves had been rebuilt underneath it. Refuse before touching anything.
  const busy = await busyStackPorts();
  if (busy.length) {
    console.error(`[seed:local] ${busy.join(", ")} in use: a local stack is running; stop it (Ctrl+C in npm run dev, or npm run stop:local) first`);
    process.exit(1);
  }
  if (fresh) {
    for (const p of [".wrangler/state", "pipelines/.data", "data/generated"]) rmSync(path.join(REPO_ROOT, p), { recursive: true, force: true });
    log("step 1: removed local state");
  }
  await pv(["synth"]);
  log("step 2: pv synth done");
  await seedD1();
  log("step 3: D1 migrated and seeded");
  const objects = await seedR2();
  log(`step 4: ${objects} export objects in R2 pv-source-exports`);
  await pv(["load", "--target", "local", "--from-r2"]);
  log("step 5: warehouse, identity xref, snapshot replay, dbt build and Iceberg loaded (read back from local R2)");
  try {
    await startLocalStack({ executor: false });
    const warm = await pv(["warmup", "--with-extracts"]);
    log(`step 6: ${warm.stdout.trim()}`);
  } finally {
    await stopAll();
  }
  const expected = JSON.parse(readFileSync(path.join(REPO_ROOT, "data/expected_counts.json"), "utf8"));
  const problems = await verifyD1(expected);
  if (objects !== expected.export_objects) problems.push(`r2 export objects: expected ${expected.export_objects}, put ${objects}`);
  const kvKeys = parseJsonOutput<{ name: string }[]>((await wrangler(["kv", "key", "list", "--binding", "CACHE", "--local"])).stdout);
  const profile = kvKeys.filter((k) => k.name.startsWith("profile:")).length;
  const team = kvKeys.filter((k) => k.name.startsWith("team:")).length;
  if (profile !== expected.kv.profile || team !== expected.kv.team) problems.push(`kv: expected ${expected.kv.profile} profile and ${expected.kv.team} team entries, found ${profile} and ${team}`);
  const counts = await pv(["counts", "--target", "local"], { allowFail: true });
  if (counts.code !== 0) problems.push(...counts.stderr.split("\n").filter((l) => l.startsWith("MISMATCH")));
  if (problems.length > 0) {
    for (const p of problems) console.error(`[seed:local] MISMATCH ${p}`);
    process.exit(1);
  }
  log("step 7: counts match data/expected_counts.json (D1, R2, KV, warehouse, lake)");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
