// npm run deploy [-- --dry-run]: builds the privacy console (dist/web, the template's static assets), then `wrangler
// deploy -c infra/cloudflare/wrangler.production.jsonc --secrets-file .secrets/worker-secrets.env`, so every deploy
// uploads both production secrets with the code. Refuses an unrendered config (placeholders left, invocation logs on)
// and a secrets file without exactly the two secrets.required names.
// Status: written, not yet executed against Cloudflare.
import { existsSync, readFileSync } from "node:fs";
import { RENDERED, RENDERED_REL, WORKER_SECRETS, readEnvFile } from "./lib/prod-files.ts";
import { wrangler } from "./lib/run.ts";
import { buildWeb } from "./lib/web-build.ts";

export const PROD_SECRETS = ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"];

/** Problems that block a deploy; empty when the config and the secrets file are ready. */
export function deployProblems(configText: string | null, secretNames: string[]): string[] {
  const out: string[] = [];
  if (configText === null) out.push(`${RENDERED_REL} is missing (run npm run setup:prod)`);
  else {
    const left = configText.match(/__[A-Z0-9_]+__/g);
    if (left) out.push(`placeholders left in ${RENDERED_REL}: ${[...new Set(left)].join(", ")}`);
    if (!/"invocation_logs"\s*:\s*false/.test(configText)) out.push("observability.logs.invocation_logs must be false");
  }
  const names = [...secretNames].sort();
  if (names.join(",") !== [...PROD_SECRETS].sort().join(",")) out.push(`.secrets/worker-secrets.env must hold exactly ${PROD_SECRETS.join(" and ")} (has: ${names.join(", ") || "nothing"})`);
  return out;
}

export function deployArgs(): string[] {
  return ["deploy", "-c", RENDERED_REL, "--secrets-file", ".secrets/worker-secrets.env"];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const secrets = readEnvFile(WORKER_SECRETS);
  const problems = deployProblems(existsSync(RENDERED) ? readFileSync(RENDERED, "utf8") : null, Object.keys(secrets).filter((k) => secrets[k]));
  if (dryRun) {
    console.log("npm run build:web");
    console.log(`npx wrangler ${deployArgs().join(" ")}`);
    for (const p of problems) console.log(`blocked: ${p}`);
    return;
  }
  if (problems.length) {
    for (const p of problems) console.error(`deploy refused: ${p}`);
    process.exit(1);
  }
  await buildWeb();
  const out = await wrangler(deployArgs());
  // wrangler prints the deployed URL and the version id; no secret values appear in its output
  process.stdout.write(out.stdout.split("\n").filter((l) => /workers\.dev|Current Version ID|Uploaded|Deployed/i.test(l)).join("\n") + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
