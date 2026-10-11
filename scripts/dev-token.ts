// npm run dev:token -- <principal-id>: prints a dev JWT for a seeded principal, signed with the local dev key
// (.dev.vars), for curl use against `npm run dev`:
//   curl -H "Cf-Access-Jwt-Assertion: $(npm run -s dev:token -- privacy-01)" http://127.0.0.1:8793/api/v1/me
import { readFileSync } from "node:fs";
import path from "node:path";
import { SignJWT, importJWK, type JWK } from "jose";
import { parseDevVars } from "./dev-keys.ts";
import { REPO_ROOT, parseJsonOutput, wrangler } from "./lib/run.ts";

function stripJsonc(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

export async function mintToken(privateJwk: JWK, issuer: string, aud: string, p: { id: string; kind: string; email: string | null; service_client_id: string | null }, ttlSeconds = 3600): Promise<string> {
  const key = await importJWK(privateJwk, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const service = p.kind === "system";
  return new SignJWT(service ? { common_name: p.service_client_id } : { email: p.email, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: privateJwk.kid ?? "dev", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience([aud])
    .setSubject(service ? "" : `dev-${p.id}`)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key);
}

export function devSettings(): { privateJwk: JWK; issuer: string; aud: string } {
  const vars = parseDevVars(readFileSync(path.join(REPO_ROOT, ".dev.vars"), "utf8"));
  const cfg = JSON.parse(stripJsonc(readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf8")));
  if (!vars.DEV_ACCESS_PRIVATE_JWK) throw new Error("DEV_ACCESS_PRIVATE_JWK missing; run `npm run dev:keys`");
  return { privateJwk: JSON.parse(vars.DEV_ACCESS_PRIVATE_JWK), issuer: cfg.vars.DEV_ACCESS_ISSUER, aud: cfg.vars.DEV_ACCESS_AUD };
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    console.error("usage: npm run dev:token -- <principal-id>   (for example privacy-01, mgr-001, analyst-01, hrbp-01)");
    process.exit(2);
  }
  const res = await wrangler(["d1", "execute", "pv-control", "--local", "--json", "--command", `SELECT id, kind, email, service_client_id FROM principals WHERE id = '${id}'`]);
  const rows = parseJsonOutput<{ results: { id: string; kind: string; email: string | null; service_client_id: string | null }[] }[]>(res.stdout)[0]?.results ?? [];
  if (rows.length === 0) {
    console.error(`unknown principal ${id}; run \`npm run seed:local\``);
    process.exit(1);
  }
  const s = devSettings();
  process.stdout.write((await mintToken(s.privateJwk, s.issuer, s.aud, rows[0]!)) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
