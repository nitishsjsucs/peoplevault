// npm run seed:prod (SPEC.md section 22.2 step 6). Status: written, not yet executed against Cloudflare or Google Cloud.
// 1. synthesize with the production master key into data/generated-prod (gitignored; the key travels in the child's
//    environment, never in argv); 2. remote D1 seed (only into an empty identity_map); 3. map the persona service
//    tokens and sign-in emails to the seeded principals; 4. the 41 export objects into pv-source-exports; 5. the lake
//    self-test and table; 6. Basin snapshot expiration on hr_history.employee_monthly; 7. `pv load --target prod`
//    (dbt build as peoplevault-executor, controls verified); 8. counts and controls through `pv doctor gcp --json`; 9. (P1) the 6
//    analytics extracts as analyst-01 and the KV entries reachable with the persona service tokens, through Access.
// Re-seeding a project that already has deletion requests is refused: re-uploading exports would resurrect erased data.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PERSONA_ENV } from "./lib/checks.ts";
import { RENDERED_REL, WORKER_SECRETS, prodEnv, readEnvFile } from "./lib/prod-files.ts";
import { REPO_ROOT, parseJsonOutput, pv, wrangler } from "./lib/run.ts";

export const PROD_GENERATED = "data/generated-prod";
export const PERSONA_PRINCIPALS: Record<string, string> = { "pv-persona-hr": "hrbp-01", "pv-persona-manager": "mgr-001", "pv-persona-analyst": "analyst-01", "pv-persona-privacy": "privacy-01" };

const SAFE = /^[A-Za-z0-9._%+@-]+$/;

/** UPDATE statements that map service tokens and sign-in emails to principals; values are validated, never free text. */
export function principalMappingSql(env: Record<string, string>): string[] {
  const out: string[] = [];
  const exec = env[`PV_CF_ACCESS_CLIENT_ID_${PERSONA_ENV["pv-executor"]}`];
  if (!exec || !SAFE.test(exec)) throw new Error("executor service token client id missing from .secrets/prod.env (run npm run setup:prod)");
  out.push(`UPDATE principals SET service_client_id = '${exec}' WHERE system_role = 'executor'`);
  for (const [token, principal] of Object.entries(PERSONA_PRINCIPALS)) {
    const id = env[`PV_CF_ACCESS_CLIENT_ID_${PERSONA_ENV[token]}`];
    if (!id || !SAFE.test(id)) throw new Error(`service token client id for ${token} missing from .secrets/prod.env (run npm run setup:prod)`);
    out.push(`UPDATE principals SET service_client_id = '${id}' WHERE id = '${principal}'`);
  }
  for (const pair of (env.PV_ACCESS_PERSONA_EMAILS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = pair.lastIndexOf("=");
    const email = pair.slice(0, i).trim().toLowerCase();
    const principal = pair.slice(i + 1).trim();
    if (i <= 0 || !SAFE.test(email) || !/^[a-z0-9-]+$/.test(principal)) throw new Error("PV_ACCESS_PERSONA_EMAILS must be email=principalId pairs separated by commas");
    out.push(`UPDATE principals SET email = '${email}' WHERE id = '${principal}'`);
  }
  return out;
}

async function d1Count(sql: string): Promise<number> {
  const out = await wrangler(["d1", "execute", "pv-control", "--remote", "-c", RENDERED_REL, "--json", "--command", sql]);
  return Number(parseJsonOutput<{ results: { n: number }[] }[]>(out.stdout)[0]?.results[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const env = prodEnv();
  const master = readEnvFile(WORKER_SECRETS).PV_PSEUDONYM_MASTER_KEY;
  if (!master) throw new Error("PV_PSEUDONYM_MASTER_KEY missing from .secrets/worker-secrets.env (run npm run setup:prod)");
  const mapping = principalMappingSql(env);

  if ((await d1Count("SELECT COUNT(*) AS n FROM deletion_requests")) > 0) {
    throw new Error("production already has deletion requests; seed:prod refuses to re-upload exports (it would resurrect erased data)");
  }
  console.log("seed:prod 1/9 synthesizing with the production master key");
  await pv(["synth", "--out", PROD_GENERATED], { env: { ...process.env, PV_SYNTH_MASTER_KEY_B64: master } });

  console.log("seed:prod 2/9 remote D1 seed");
  if ((await d1Count("SELECT COUNT(*) AS n FROM identity_map")) === 0) {
    await wrangler(["d1", "execute", "pv-control", "--remote", "-c", RENDERED_REL, "--file", `${PROD_GENERATED}/seed.sql`], { input: "y\n" });
  } else console.log("  identity_map already seeded; skipped");

  console.log("seed:prod 3/9 mapping service tokens and sign-in emails to principals");
  for (const sql of mapping) await wrangler(["d1", "execute", "pv-control", "--remote", "-c", RENDERED_REL, "--command", sql]);

  console.log("seed:prod 4/9 export objects");
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, PROD_GENERATED, "manifest.json"), "utf8")) as { exports: { key: string }[] };
  for (const e of manifest.exports) {
    await wrangler(["r2", "object", "put", `pv-source-exports/${e.key}`, "--remote", "-c", RENDERED_REL, "--file", `${PROD_GENERATED}/${e.key}`], { retries: 2 });
  }
  console.log(`  ${manifest.exports.length} objects`);

  console.log("seed:prod 5/9 lake self-test and table");
  await pv(["lake", "init", "--target", "prod"]);

  console.log("seed:prod 6/9 Basin snapshot expiration");
  const exp = await wrangler(["basin", "catalog", "snapshot-expiration", "enable", "pv-lake", "hr_history", "employee_monthly", "--older-than-days", "1", "--retain-last", "1"], { allowFail: true });
  if (exp.code !== 0) console.log("  snapshot expiration not enabled by this run (already enabled, or see `npx wrangler basin catalog snapshot-expiration --help`)");

  console.log("seed:prod 7/9 pv load --target prod (dbt build as peoplevault-executor; controls verified)");
  await pv(["load", "--target", "prod"]);

  console.log("seed:prod 8/9 counts and controls");
  const checks = parseJsonOutput<{ name: string; status: string; detail: string }[]>((await pv(["doctor", "gcp", "--json"], { allowFail: true })).stdout);
  const bad = checks.filter((c) => (c.name === "data loaded" || c.name === "protected tables intact") && c.status === "missing");
  for (const c of checks.filter((x) => x.name === "data loaded" || x.name === "protected tables intact")) console.log(`  [${c.status}] ${c.name}: ${c.detail}`);
  if (bad.length) process.exit(1);

  console.log("seed:prod 9/9 analytics extracts and cache warm-up through Access (persona service tokens)");
  // The deployed Worker needs the Access application and the AUD (setup:prod's access group); cache entries expire
  // after an hour, so the production eval warms again right before it submits requests.
  const warm = await pv(["warmup", "--target", "prod", "--with-extracts"], { allowFail: true });
  console.log(`  ${warm.stdout.trim() || "warm-up failed; rerun: uv run --project pipelines pv warmup --target prod --with-extracts"}`);
  if (warm.code !== 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
