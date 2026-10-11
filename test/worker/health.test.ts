import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/worker/app.ts";

describe("GET /api/health", () => {
  it("reports mode without secrets or counts", async () => {
    const res = await exports.default.fetch("http://127.0.0.1/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, env: "local", authMode: "local-jwks", warehouse: "local-shim", auditCopy: "executor_export" });
    const text = JSON.stringify(body);
    expect(text).not.toContain(env.PV_PSEUDONYM_MASTER_KEY);
    expect(text).not.toContain("test-shim-token");
  });

  it("returns 500 misconfigured when the config is inconsistent", async () => {
    const app = buildApp();
    const res = await app.request("/api/health", {}, { ...env, AUTH_MODE: "access" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "misconfigured" });
  });

  it("unknown routes are 404", async () => {
    const res = await exports.default.fetch("http://127.0.0.1/nope");
    expect(res.status).toBe(404);
  });
});
