import { z } from "zod";

/** Published test-vector master key (policy/test-vectors/pseudonyms.json): bytes 0x00..0x1f. */
export const TEST_VECTOR_MASTER_KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const PURPOSE_SA_VARS = {
  employee_relations: "BQ_PURPOSE_SA_EMPLOYEE_RELATIONS",
  team_management: "BQ_PURPOSE_SA_TEAM_MANAGEMENT",
  workforce_analytics: "BQ_PURPOSE_SA_WORKFORCE_ANALYTICS",
  privacy_compliance: "BQ_PURPOSE_SA_PRIVACY_COMPLIANCE",
  legal_hold_management: "BQ_PURPOSE_SA_LEGAL_HOLD_MANAGEMENT",
} as const;
export type PurposeSaMap = Record<keyof typeof PURPOSE_SA_VARS, string>;

const duration = z.string().regex(/^\d+ (second|minute|hour|day)s?$/, "duration like '70 seconds'");

export interface Config {
  env: "local" | "production";
  authMode: "access" | "local-jwks";
  warehouseMode: "local-shim" | "bigquery";
  kvPropagationWait: string;
  executorWaitTimeout: string;
  retentionAsOf: string | null;
  /** Free plan capacity (SPEC.md section 30.3.4): null means unlimited (local). */
  dailyDeletionStarts: number | null;
  retentionDailyMax: number | null;
  retentionCron: "on" | "off";
  /** Decoded R2 bytes per Workflow step (SPEC.md section 30.3.1). */
  r2EraseStepBytes: number;
  r2ProbeStepBytes: number;
  masterKeyB64: string;
  access: { teamDomain: string; aud: string } | null;
  dev: { issuer: string; aud: string; jwks: string; privateJwk: string | null } | null;
  shim: { url: string; token: string } | null;
  bigquery: { projectId: string; location: string; gatewaySaEmail: string; gatewayKeyJson: string; purposeSa: PurposeSaMap } | null;
  /** Schema-drift triage model (SPEC.md sections 16.3 and 30.3.6). dailyNeurons null means unlimited (local). */
  ai: { mode: "workers-ai" | "llama-server" | "stub"; gatewayId: string | null; dailyNeurons: number | null; llmUrl: string | null };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Empty strings count as unset (wrangler.jsonc declares production-only vars as ""). */
function opt(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function req(env: Record<string, unknown>, name: string, why: string): string {
  const v = opt(env[name]);
  if (v === null) throw new ConfigError(`${name} is required when ${why}`);
  return v;
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A positive integer var; "" means unset (null). */
function positiveInt(env: Record<string, unknown>, name: string): number | null {
  const v = opt(env[name]);
  if (v === null) return null;
  if (!/^[1-9]\d{0,9}$/.test(v)) throw new ConfigError(`${name} must be a positive integer or empty`);
  return Number(v);
}

/** Default byte caps when a var is absent (tests that bind a partial environment). */
export const DEFAULT_R2_ERASE_STEP_BYTES = 4_194_304;
export const DEFAULT_R2_PROBE_STEP_BYTES = 2_097_152;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validates the Worker environment (SPEC.md section 6.4). Throws ConfigError on the first inconsistency. */
export function loadConfig(envIn: Env | Record<string, unknown>): Config {
  const env = envIn as unknown as Record<string, unknown>;
  const pvEnv = z.enum(["local", "production"]).safeParse(env.PV_ENV);
  if (!pvEnv.success) throw new ConfigError("PV_ENV must be local or production");
  const authMode = z.enum(["access", "local-jwks"]).safeParse(env.AUTH_MODE);
  if (!authMode.success) throw new ConfigError("AUTH_MODE must be access or local-jwks");
  const warehouseMode = z.enum(["local-shim", "bigquery"]).safeParse(env.WAREHOUSE_MODE);
  if (!warehouseMode.success) throw new ConfigError("WAREHOUSE_MODE must be local-shim or bigquery");
  const kvWait = duration.safeParse(env.KV_PROPAGATION_WAIT);
  if (!kvWait.success) throw new ConfigError("KV_PROPAGATION_WAIT must be a duration");
  const execWait = duration.safeParse(env.EXECUTOR_WAIT_TIMEOUT);
  if (!execWait.success) throw new ConfigError("EXECUTOR_WAIT_TIMEOUT must be a duration");
  const asOf = opt(env.RETENTION_AS_OF);
  if (asOf !== null && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new ConfigError("RETENTION_AS_OF must be YYYY-MM-DD");
  const dailyDeletionStarts = positiveInt(env, "DAILY_DELETION_STARTS");
  const retentionDailyMax = positiveInt(env, "RETENTION_DAILY_MAX");
  const cron = opt(env.RETENTION_CRON) ?? "on";
  if (cron !== "on" && cron !== "off") throw new ConfigError("RETENTION_CRON must be on or off");
  const r2EraseStepBytes = positiveInt(env, "R2_ERASE_STEP_BYTES") ?? DEFAULT_R2_ERASE_STEP_BYTES;
  const r2ProbeStepBytes = positiveInt(env, "R2_PROBE_STEP_BYTES") ?? DEFAULT_R2_PROBE_STEP_BYTES;

  const masterKeyB64 = req(env, "PV_PSEUDONYM_MASTER_KEY", "the Worker starts");
  let masterKey: Uint8Array;
  try {
    masterKey = decodeBase64(masterKeyB64);
  } catch {
    throw new ConfigError("PV_PSEUDONYM_MASTER_KEY is not valid base64");
  }
  if (pvEnv.data === "production") {
    // a fixed (and possibly future) retention date would move every cutoff; production always uses today's date
    if (asOf !== null) throw new ConfigError("RETENTION_AS_OF must be empty in production (retention uses today's UTC date)");
    if (masterKey.length < 32) throw new ConfigError("PV_PSEUDONYM_MASTER_KEY must decode to at least 32 bytes in production");
    if (hex(masterKey) === TEST_VECTOR_MASTER_KEY_HEX) {
      throw new ConfigError("PV_PSEUDONYM_MASTER_KEY equals the published test-vector key; production refuses it");
    }
  }

  let access: Config["access"] = null;
  let dev: Config["dev"] = null;
  if (authMode.data === "access") {
    const teamDomain = req(env, "ACCESS_TEAM_DOMAIN", "AUTH_MODE=access");
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) {
      throw new ConfigError("ACCESS_TEAM_DOMAIN must look like https://<team>.cloudflareaccess.com");
    }
    const aud = req(env, "ACCESS_AUD", "AUTH_MODE=access");
    if (opt(env.DEV_ACCESS_PRIVATE_JWK) !== null) throw new ConfigError("DEV_ACCESS_PRIVATE_JWK must not be set when AUTH_MODE=access");
    access = { teamDomain, aud };
  } else {
    if (pvEnv.data !== "local") throw new ConfigError("AUTH_MODE=local-jwks requires PV_ENV=local");
    dev = {
      issuer: req(env, "DEV_ACCESS_ISSUER", "AUTH_MODE=local-jwks"),
      aud: req(env, "DEV_ACCESS_AUD", "AUTH_MODE=local-jwks"),
      jwks: req(env, "DEV_ACCESS_JWKS", "AUTH_MODE=local-jwks"),
      privateJwk: opt(env.DEV_ACCESS_PRIVATE_JWK),
    };
  }

  let shim: Config["shim"] = null;
  let bigquery: Config["bigquery"] = null;
  if (warehouseMode.data === "bigquery") {
    const why = "WAREHOUSE_MODE=bigquery";
    const purposeSa = {} as PurposeSaMap;
    for (const [purpose, name] of Object.entries(PURPOSE_SA_VARS)) {
      purposeSa[purpose as keyof PurposeSaMap] = req(env, name, why);
    }
    bigquery = {
      projectId: req(env, "GCP_PROJECT_ID", why),
      location: opt(env.BQ_LOCATION) ?? "US",
      gatewaySaEmail: req(env, "BQ_GATEWAY_SA_EMAIL", why),
      gatewayKeyJson: req(env, "GCP_GATEWAY_SA_KEY", why),
      purposeSa,
    };
  } else {
    shim = { url: req(env, "WAREHOUSE_SHIM_URL", "WAREHOUSE_MODE=local-shim"), token: req(env, "WAREHOUSE_SHIM_TOKEN", "WAREHOUSE_MODE=local-shim") };
  }

  // Schema-drift triage: Workers AI through the AI Gateway in production (with a daily neuron cap), llama-server or a
  // deterministic stub locally. A missing AI_MODE (tests that bind a partial environment) is the stub.
  const aiMode = z.enum(["workers-ai", "llama-server", "stub"]).safeParse(opt(env.AI_MODE) ?? "stub");
  if (!aiMode.success) throw new ConfigError("AI_MODE must be workers-ai, llama-server or stub");
  const ai: Config["ai"] = { mode: aiMode.data, gatewayId: opt(env.AI_GATEWAY_ID), dailyNeurons: positiveInt(env, "AI_DAILY_NEURONS"), llmUrl: opt(env.LLM_URL) };
  if (ai.mode === "workers-ai") {
    req(env, "AI_GATEWAY_ID", "AI_MODE=workers-ai");
    req(env, "AI_DAILY_NEURONS", "AI_MODE=workers-ai");
  }
  if (ai.mode === "llama-server") {
    if (pvEnv.data !== "local") throw new ConfigError("AI_MODE=llama-server requires PV_ENV=local");
    req(env, "LLM_URL", "AI_MODE=llama-server");
  }

  return {
    env: pvEnv.data,
    authMode: authMode.data,
    warehouseMode: warehouseMode.data,
    kvPropagationWait: kvWait.data,
    executorWaitTimeout: execWait.data,
    retentionAsOf: asOf,
    dailyDeletionStarts,
    retentionDailyMax,
    retentionCron: cron,
    r2EraseStepBytes,
    r2ProbeStepBytes,
    masterKeyB64,
    access,
    dev,
    shim,
    bigquery,
    ai,
  };
}
