// Writes .dev.vars with exactly the names in wrangler.jsonc `secrets.required`: a local RS256 key pair standing
// in for the Cloudflare Access team keys, a pseudonym master key and a shim token. GCP_GATEWAY_SA_KEY is a
// production-only secret and is written empty. Existing values are kept unless --force is given.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { REPO_ROOT } from "./lib/run.ts";

export const REQUIRED_SECRETS = ["DEV_ACCESS_JWKS", "DEV_ACCESS_PRIVATE_JWK", "PV_PSEUDONYM_MASTER_KEY", "WAREHOUSE_SHIM_TOKEN", "GCP_GATEWAY_SA_KEY"] as const;

export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export async function buildDevVars(existing: Record<string, string>, force: boolean, today = new Date()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const keep = (name: string) => !force && existing[name] !== undefined && existing[name] !== "";
  if (keep("DEV_ACCESS_JWKS") && keep("DEV_ACCESS_PRIVATE_JWK")) {
    out.DEV_ACCESS_JWKS = existing.DEV_ACCESS_JWKS!;
    out.DEV_ACCESS_PRIVATE_JWK = existing.DEV_ACCESS_PRIVATE_JWK!;
  } else {
    const kid = `dev-${today.toISOString().slice(0, 10)}`;
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pub = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
    const priv = { ...(await exportJWK(privateKey)), kid, alg: "RS256", use: "sig" };
    out.DEV_ACCESS_JWKS = JSON.stringify({ keys: [pub] });
    out.DEV_ACCESS_PRIVATE_JWK = JSON.stringify(priv);
  }
  out.PV_PSEUDONYM_MASTER_KEY = keep("PV_PSEUDONYM_MASTER_KEY") ? existing.PV_PSEUDONYM_MASTER_KEY! : randomBytes(32).toString("base64");
  out.WAREHOUSE_SHIM_TOKEN = keep("WAREHOUSE_SHIM_TOKEN") ? existing.WAREHOUSE_SHIM_TOKEN! : randomBytes(24).toString("base64url");
  out.GCP_GATEWAY_SA_KEY = "";
  return out;
}

export function renderDevVars(values: Record<string, string>): string {
  const lines = ["# Written by `npm run dev:keys`. Local development only; never used in production."];
  for (const name of REQUIRED_SECRETS) lines.push(`${name}=${values[name] ?? ""}`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const target = path.join(REPO_ROOT, ".dev.vars");
  const force = process.argv.includes("--force");
  const existing = existsSync(target) ? parseDevVars(readFileSync(target, "utf8")) : {};
  const values = await buildDevVars(existing, force);
  writeFileSync(target, renderDevVars(values), { mode: 0o600 });
  console.log(`dev:keys wrote .dev.vars (${REQUIRED_SECRETS.length} names${force ? ", regenerated" : ""})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
