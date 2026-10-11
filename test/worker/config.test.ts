import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import vectors from "../../policy/test-vectors/pseudonyms.json";
import { buildApp } from "../../src/worker/app.ts";
import { ConfigError, TEST_VECTOR_MASTER_KEY_HEX, loadConfig } from "../../src/worker/env.ts";
import { ACCESS_AUD, ACCESS_TEAM_DOMAIN } from "../fixtures/tokens.ts";

const base = { ...env } as unknown as Record<string, unknown>;
const realKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)));
const prod = {
  ...base,
  PV_ENV: "production",
  AUTH_MODE: "access",
  WAREHOUSE_MODE: "bigquery",
  ACCESS_TEAM_DOMAIN,
  ACCESS_AUD,
  DEV_ACCESS_PRIVATE_JWK: "",
  PV_PSEUDONYM_MASTER_KEY: realKey,
  GCP_PROJECT_ID: "pv-test",
  BQ_LOCATION: "US",
  BQ_GATEWAY_SA_EMAIL: "pv-gateway@pv-test.iam.gserviceaccount.com",
  GCP_GATEWAY_SA_KEY: '{"type":"service_account"}',
  BQ_PURPOSE_SA_EMPLOYEE_RELATIONS: "pv-er-reader@pv-test.iam.gserviceaccount.com",
  BQ_PURPOSE_SA_TEAM_MANAGEMENT: "pv-tm-reader@pv-test.iam.gserviceaccount.com",
  BQ_PURPOSE_SA_WORKFORCE_ANALYTICS: "pv-wa-reader@pv-test.iam.gserviceaccount.com",
  BQ_PURPOSE_SA_PRIVACY_COMPLIANCE: "pv-pc-reader@pv-test.iam.gserviceaccount.com",
  BQ_PURPOSE_SA_LEGAL_HOLD_MANAGEMENT: "pv-lh-reader@pv-test.iam.gserviceaccount.com",
  KV_PROPAGATION_WAIT: "70 seconds",
  EXECUTOR_WAIT_TIMEOUT: "24 hours",
  RETENTION_AS_OF: "",
};

describe("loadConfig", () => {
  it("accepts the local configuration", () => {
    const cfg = loadConfig(env);
    expect(cfg).toMatchObject({ env: "local", authMode: "local-jwks", warehouseMode: "local-shim", retentionAsOf: "2026-09-30" });
    expect(cfg).not.toHaveProperty("auditStreamMode");
  });
  it("reads the Free plan capacity vars: unlimited locally, capped in production (SPEC.md 30.3.4)", () => {
    expect(loadConfig(env)).toMatchObject({ dailyDeletionStarts: null, retentionDailyMax: null, retentionCron: "on", r2EraseStepBytes: 4194304, r2ProbeStepBytes: 2097152 });
    const capped = loadConfig({ ...prod, DAILY_DELETION_STARTS: "16", RETENTION_DAILY_MAX: "8", RETENTION_CRON: "off", R2_ERASE_STEP_BYTES: "1048576", R2_PROBE_STEP_BYTES: "524288" });
    expect(capped).toMatchObject({ dailyDeletionStarts: 16, retentionDailyMax: 8, retentionCron: "off", r2EraseStepBytes: 1048576, r2ProbeStepBytes: 524288 });
    for (const bad of [{ DAILY_DELETION_STARTS: "0" }, { RETENTION_DAILY_MAX: "-1" }, { R2_PROBE_STEP_BYTES: "2 MiB" }, { RETENTION_CRON: "yes" }]) {
      expect(() => loadConfig({ ...prod, ...bad }), JSON.stringify(bad)).toThrow(ConfigError);
    }
  });
  it("accepts a complete production configuration and treats empty strings as unset", () => {
    const cfg = loadConfig(prod);
    expect(cfg.bigquery?.purposeSa.team_management).toBe("pv-tm-reader@pv-test.iam.gserviceaccount.com");
    expect(cfg.retentionAsOf).toBeNull();
    expect(cfg.dev).toBeNull();
  });
  it.each([
    ["access needs a team domain", { ACCESS_TEAM_DOMAIN: "" }, /ACCESS_TEAM_DOMAIN/],
    ["team domain must be cloudflareaccess.com", { ACCESS_TEAM_DOMAIN: "https://evil.example.com" }, /cloudflareaccess/],
    ["access needs an audience", { ACCESS_AUD: "" }, /ACCESS_AUD/],
    ["access forbids the dev private key", { DEV_ACCESS_PRIVATE_JWK: '{"d":"x"}' }, /DEV_ACCESS_PRIVATE_JWK/],
    ["bigquery needs every purpose SA", { BQ_PURPOSE_SA_TEAM_MANAGEMENT: "" }, /BQ_PURPOSE_SA_TEAM_MANAGEMENT/],
    ["bigquery needs the gateway key", { GCP_GATEWAY_SA_KEY: "" }, /GCP_GATEWAY_SA_KEY/],
    ["production rejects the test-vector master key", { PV_PSEUDONYM_MASTER_KEY: vectors.master_key_b64 }, /test-vector/],
    ["production rejects a short master key", { PV_PSEUDONYM_MASTER_KEY: btoa("short-key-16byte") }, /32 bytes/],
    ["local-jwks requires PV_ENV=local", { AUTH_MODE: "local-jwks" }, /PV_ENV=local/],
  ])("%s", (_name, patch, msg) => {
    expect(() => loadConfig({ ...prod, ...patch })).toThrow(ConfigError);
    expect(() => loadConfig({ ...prod, ...patch })).toThrow(msg);
  });
  it("the published test-vector key is the one env.ts refuses", () => {
    expect(vectors.master_key_hex).toBe(TEST_VECTOR_MASTER_KEY_HEX);
  });
  it("tests run with the test master key and test JWKS, not a developer's .dev.vars", () => {
    expect(env.PV_PSEUDONYM_MASTER_KEY).toBe(vectors.master_key_b64);
    expect(JSON.parse(env.DEV_ACCESS_JWKS).keys[0].kid).toBe("test-primary");
  });
});

describe("/dev routes", () => {
  it("answer locally on loopback hosts only", async () => {
    const app = buildApp();
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const res = await app.request(`http://${host}:8793/dev/principals`, {}, env);
      expect(res.status).toBe(200);
    }
    const remote = await app.request("http://peoplevault.example.com/dev/principals", {}, env);
    expect(remote.status).toBe(404);
  });
  it("return 404 when AUTH_MODE=access", async () => {
    const app = buildApp();
    const res = await app.request("http://127.0.0.1/dev/login?principal=privacy-01", {}, { ...env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN, ACCESS_AUD, DEV_ACCESS_PRIVATE_JWK: "" });
    expect(res.status).toBe(404);
  });
  it("/dev/login sets a CF_Authorization cookie that /api/v1/me accepts", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO principals (id, kind, persona, email, org_units, status, created_at) VALUES ('analyst-01', 'human', 'people_analyst', 'an@peoplevault.test', '[]', 'active', 'x')",
    ).run();
    const app = buildApp();
    const login = await app.request("http://127.0.0.1/dev/login?principal=analyst-01", {}, env);
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^CF_Authorization=/);
    expect(cookie).toMatch(/HttpOnly/);
    const token = cookie.split(";")[0]!.split("=")[1]!;
    const me = await app.request("http://127.0.0.1/api/v1/me", { headers: { cookie: `CF_Authorization=${token}` } }, env);
    expect(await me.json()).toMatchObject({ principalId: "analyst-01", persona: "people_analyst" });
    const unknown = await app.request("http://127.0.0.1/dev/login?principal=nobody", {}, env);
    expect(unknown.status).toBe(404);
  });
});

describe("request hygiene", () => {
  it("mutating requests without X-PV-Requested-With are 403 csrf", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO principals (id, kind, persona, email, org_units, status, created_at) VALUES ('privacy-02', 'human', 'privacy_officer', 'p2@peoplevault.test', '[]', 'active', 'x')",
    ).run();
    const { userToken } = await import("../fixtures/tokens.ts");
    const app = buildApp();
    const res = await app.request("http://127.0.0.1/api/v1/me", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await userToken("p2@peoplevault.test") } }, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", code: "csrf" });
  });
});
