// Production files under .secrets/ (gitignored, mode 600) and the rendered Wrangler config. Values written here are
// never printed; callers print names only.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./run.ts";

export const SECRETS_DIR = path.join(REPO_ROOT, ".secrets");
export const PROD_ENV = path.join(SECRETS_DIR, "prod.env");
export const WORKER_SECRETS = path.join(SECRETS_DIR, "worker-secrets.env");
export const RESOURCES = path.join(SECRETS_DIR, "prod-resources.json");
export const TEMPLATE = path.join(REPO_ROOT, "infra", "cloudflare", "wrangler.production.template.jsonc");
export const RENDERED = path.join(REPO_ROOT, "infra", "cloudflare", "wrangler.production.jsonc");
export const RENDERED_REL = "infra/cloudflare/wrangler.production.jsonc";
export const ACCESS_TEMPLATE = path.join(REPO_ROOT, "infra", "cloudflare", "access-app.template.json");

/** Values written by setup:prod (Access client secrets, catalog URI and warehouse) and edited by hand (the rest). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

export function readEnvFile(file: string): Record<string, string> {
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

/** Sets keys in an env file, keeping other lines and comments; creates .secrets/ (700) and the file (600). */
export function upsertEnvFile(file: string, values: Record<string, string>): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const i = line.indexOf("=");
    const key = i > 0 && !line.trim().startsWith("#") ? line.slice(0, i).trim() : null;
    if (key && key in values) {
      seen.add(key);
      return `${key}=${values[key]}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(file, out.join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Process environment over .secrets/prod.env (the process wins, like the Python side). */
export function prodEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const merged: Record<string, string> = { ...readEnvFile(PROD_ENV) };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (k.startsWith("PV_") || k === "CLOUDFLARE_ACCOUNT_ID")) merged[k] = v;
  return merged;
}

export interface ProdResources {
  d1_id?: string;
  kv_id?: string;
  worker_id?: string;
  access_app_id?: string;
  access_aud?: string;
  access_team_domain?: string;
  catalog_uri?: string;
  catalog_warehouse?: string;
  audit_stream_id?: string;
  service_tokens?: Record<string, { id: string; client_id: string }>;
  policy_tags?: Record<string, string>;
  taxonomy?: string;
  [k: string]: unknown;
}

export function readResources(file = RESOURCES): ProdResources {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ProdResources) : {};
}

export function writeResources(update: Partial<ProdResources>, file = RESOURCES): ProdResources {
  const next = { ...readResources(file), ...update };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return next;
}

export interface RenderValues {
  d1Id: string;
  kvId: string;
  accessTeamDomain: string;
  accessAud: string;
  gcpProject: string;
  /** Basin Pipelines stream pv_audit_events (P1 audit stream) */
  streamId: string;
}

/** Template with every placeholder replaced; throws if a value is empty or a placeholder is left. */
export function renderConfig(template: string, v: RenderValues): string {
  const map: Record<string, string> = {
    __D1_ID__: v.d1Id,
    __KV_ID__: v.kvId,
    __ACCESS_TEAM_DOMAIN__: v.accessTeamDomain,
    __ACCESS_AUD__: v.accessAud,
    __GCP_PROJECT_ID__: v.gcpProject,
    __STREAM_ID__: v.streamId,
  };
  for (const [k, val] of Object.entries(map)) if (!val) throw new Error(`no value for ${k}`);
  let out = template;
  for (const [k, val] of Object.entries(map)) out = out.split(k).join(val);
  const left = out.match(/__[A-Z0-9_]+__/g);
  if (left) throw new Error(`placeholders left: ${[...new Set(left)].join(", ")}`);
  return out;
}

/** Value used for ACCESS_AUD before the Access application exists: the Worker rejects every token (fail closed). */
export const AUD_PENDING = "pending-access-application";
