// Recorded-response contract tests for the Cloudflare REST calls of setup:prod and doctor. The fixtures were
// constructed from the API reference (each file says so in `_note`); replace them with captured responses after the
// first production run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CF_API, CfApi, CfApiError, isWorkersPaid } from "../../scripts/lib/cf-api.ts";
import { REPO_ROOT } from "../../scripts/lib/run.ts";

function fixture(name: string): { status: number; body: unknown } {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "test", "fixtures", "contracts", "cloudflare", `${name}.json`), "utf8"));
}

function recorder(routes: Record<string, string>) {
  const calls: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const name = routes[`${method} ${url.replace(CF_API, "")}`];
    if (!name) return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: "no route" }], result: null }), { status: 404 });
    const f = fixture(name);
    return new Response(JSON.stringify(f.body), { status: f.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Cloudflare API client", () => {
  it("reads Access apps, service tokens and the Zero Trust organization with the bearer token", async () => {
    const { calls, fetchImpl } = recorder({
      "GET /accounts/acct/access/apps": "access_apps",
      "GET /accounts/acct/access/service_tokens": "service_tokens",
      "GET /accounts/acct/access/organizations": "organizations",
    });
    const api = new CfApi("acct", "tok", fetchImpl);
    expect((await api.accessApps())[0]).toMatchObject({ name: "PeopleVault", aud: "aud-tag-123", destinations: [{ type: "worker" }] });
    expect((await api.serviceTokens()).map((t) => t.name)).toEqual(["pv-executor", "pv-persona-hr"]);
    expect((await api.organization()).auth_domain).toBe("nitish-pv.cloudflareaccess.com");
    expect(calls.every((c) => c.auth === "Bearer tok" && c.method === "GET")).toBe(true);
  });

  it("maps error 10007 on the workers.dev subdomain to null and returns the name when registered", async () => {
    const missing = new CfApi("acct", "tok", recorder({ "GET /accounts/acct/workers/subdomain": "workers_subdomain_missing" }).fetchImpl);
    expect(await missing.workersSubdomain()).toBeNull();
    const present = new CfApi("acct", "tok", recorder({ "GET /accounts/acct/workers/subdomain": "workers_subdomain" }).fetchImpl);
    expect(await present.workersSubdomain()).toBe("nitish-pv");
  });

  it("raises CfApiError with status and codes for other failures (never the token)", async () => {
    const api = new CfApi("acct", "tok-value-zq", recorder({}).fetchImpl);
    const err = await api.accessApps().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CfApiError);
    expect((err as CfApiError).status).toBe(404);
    expect((err as CfApiError).codes).toEqual([7003]);
    expect(String((err as Error).message)).not.toContain("tok-value-zq");
  });

  it("creates service tokens for a year and registers the subdomain with the documented bodies", async () => {
    const { calls, fetchImpl } = recorder({});
    const api = new CfApi("acct", "tok", fetchImpl);
    await api.createServiceToken("pv-executor").catch(() => null);
    await api.registerWorkersSubdomain("nitish-pv").catch(() => null);
    expect(calls.map((c) => [c.method, c.url.replace(CF_API, ""), c.body])).toEqual([
      ["POST", "/accounts/acct/access/service_tokens", { name: "pv-executor", duration: "8760h" }],
      ["PUT", "/accounts/acct/workers/subdomain", { subdomain: "nitish-pv" }],
    ]);
  });

  it("recognizes Workers Paid by plan name and paid state; anything else is not matched", () => {
    const subs = (fixture("subscriptions").body as { result: never[] }).result;
    expect(isWorkersPaid(subs)).toBe(true);
    expect(isWorkersPaid([{ id: "s", state: "Paid", rate_plan: { id: "free", public_name: "Workers Free" } }])).toBe(false);
    expect(isWorkersPaid([{ id: "s", state: "Cancelled", rate_plan: { id: "workers_paid", public_name: "Workers Paid" } }])).toBe(false);
  });
});
