import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, call, seedWorld, subject, tokenFor, worldApp } from "../fixtures/seed.ts";
import { createFakeWarehouse } from "../fixtures/fake-warehouse.ts";
import { buildApp } from "../../src/worker/app.ts";

beforeAll(seedWorld);

const auditCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events").first<{ n: number }>())!.n;

describe("purpose data routes", () => {
  it("lists HR employees in the principal's org units with column visibilities", async () => {
    const { app } = worldApp();
    const res = await call(app, "hrbp-01", "GET", "/api/v1/purposes/employee_relations/employees");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Record<string, unknown>[]; columns: Record<string, string>; nextCursor: string | null };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) expect(["ENG-PRODUCT", "SALES-NA"]).toContain(r.org_unit);
    expect(body.columns.full_name).toBe("allow");
    expect(body.nextCursor).toBeNull();
  });

  it("pages with a cursor of 100 rows", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ analytics_id: `an_${String(i).padStart(26, "0")}`, org_unit: "X", job_level: "IC1" }));
    const wh = createFakeWarehouse({ views: { "workforce_analytics.employees": many } });
    const app = buildApp({ warehouseFactory: () => wh });
    const first = (await (await call(app, "analyst-01", "GET", "/api/v1/purposes/workforce_analytics/employees")).json()) as { rows: unknown[]; nextCursor: string };
    expect(first.rows).toHaveLength(100);
    expect(first.nextCursor).toBe(many[99]!.analytics_id);
    const second = (await (await call(app, "analyst-01", "GET", `/api/v1/purposes/workforce_analytics/employees?cursor=${first.nextCursor}`)).json()) as { rows: unknown[]; nextCursor: string | null };
    expect(second.rows).toHaveLength(50);
    expect(second.nextCursor).toBeNull();
  });

  it("drops deny columns even when the warehouse returns them, and masks again", async () => {
    const { app } = worldApp({ extraColumns: { gender: "female", birth_date: "1990-04-05", employee_id: "E10004", base_salary: 123456 } });
    const s = subject("mgr-001", "direct_report", 0);
    const res = await call(app, "mgr-001", "GET", `/api/v1/purposes/team_management/employees/${s.employee_ref}`);
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as { profile: Record<string, unknown> };
    expect(profile).not.toHaveProperty("gender");
    expect(profile).not.toHaveProperty("birth_date");
    expect(profile).not.toHaveProperty("employee_id");
    expect(profile.base_salary).toBeNull();
    expect(profile.full_name).toBe(s.truth.full_name);
  });

  it("serves a KV cache hit without the warehouse, and the cache key holds no raw identifier", async () => {
    const { app, wh } = worldApp();
    const s = subject("hrbp-01", "in_unit", 1);
    const path = `/api/v1/purposes/employee_relations/employees/${s.employee_ref}`;
    expect((await call(app, "hrbp-01", "GET", path)).status).toBe(200);
    const callsAfterMiss = wh.calls.length;
    expect((await call(app, "hrbp-01", "GET", path)).status).toBe(200);
    expect(wh.calls.length).toBe(callsAfterMiss);
    const keys = (await env.CACHE.list({ prefix: "profile:employee_relations:" })).keys.map((k) => k.name);
    expect(keys).toContain(`profile:employee_relations:${s.employee_ref}`);
    // another HR partner cannot read the cached profile of a unit they do not hold
    expect((await call(app, "hrbp-02", "GET", path)).status).toBe(404);
  });

  it("a manager principal without an employee link never reads a cached team profile", async () => {
    const { app } = worldApp();
    const s = subject("mgr-001", "direct_report", 0);
    const path = `/api/v1/purposes/team_management/employees/${s.employee_ref}`;
    expect((await call(app, "mgr-001", "GET", path)).status).toBe(200);
    expect(await env.CACHE.get(`profile:team_management:${s.employee_ref}`)).not.toBeNull();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO principals (id, kind, persona, system_role, email, service_client_id, employee_id, org_units, status, created_at) VALUES ('mgr-unlinked', 'human', 'manager', NULL, 'unlinked.manager@peoplevault.test', NULL, NULL, '[]', 'active', '2026-09-01T00:00:00Z')",
    ).run();
    const res = await call(app, "mgr-unlinked", "GET", path);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(String(s.truth.full_name));
    const last = await env.DB.prepare("SELECT actor, decision, reason FROM audit_events ORDER BY seq DESC LIMIT 1").first();
    expect(last).toEqual({ actor: "mgr-unlinked", decision: "deny", reason: "action_not_permitted" });
  });

  it("audits a warehouse refusal of an allowed read as a deny with the error code", async () => {
    const { WarehouseError } = await import("../../src/worker/warehouse/client.ts");
    const app = buildApp({ warehouseFactory: () => ({ run: async () => { throw new WarehouseError("access_denied"); } }) });
    const res = await call(app, "hrbp-01", "GET", "/api/v1/purposes/employee_relations/employees");
    expect(res.status).toBe(502);
    const last = await env.DB.prepare("SELECT actor, purpose, action, decision, reason FROM audit_events ORDER BY seq DESC LIMIT 1").first();
    expect(last).toEqual({ actor: "hrbp-01", purpose: "employee_relations", action: "list_employees", decision: "deny", reason: "warehouse_access_denied" });
  });

  it("returns 404 for out-of-scope, unknown and wrong-kind refs (no existence oracle)", async () => {
    const { app } = worldApp();
    const outside = subject("hrbp-01", "outside_unit", 0);
    expect((await call(app, "hrbp-01", "GET", `/api/v1/purposes/employee_relations/employees/${outside.employee_ref}`)).status).toBe(404);
    expect((await call(app, "hrbp-01", "GET", `/api/v1/purposes/employee_relations/employees/er_${"a".repeat(26)}`)).status).toBe(404);
    expect((await call(app, "hrbp-01", "GET", `/api/v1/purposes/employee_relations/employees/${outside.analytics_id}`)).status).toBe(404);
  });

  it("writes exactly one audit event per request", async () => {
    const { app } = worldApp();
    const before = await auditCount();
    await call(app, "hrbp-01", "GET", "/api/v1/purposes/employee_relations/employees");
    await call(app, "mgr-001", "GET", "/api/v1/purposes/employee_relations/employees");
    expect(await auditCount()).toBe(before + 2);
  });

  it("identity lookup is POST only and requires at least 3 characters", async () => {
    const { app } = worldApp();
    const s = subject("*", "terminated", 0);
    const get = await app.request(`${BASE}/api/v1/purposes/privacy_compliance/identity-lookup?q=abc`, { headers: { "Cf-Access-Jwt-Assertion": await tokenFor("privacy-01") } }, env);
    expect(get.status).toBe(404);
    const short = await call(app, "privacy-01", "POST", "/api/v1/purposes/privacy_compliance/identity-lookup", { q: "ab" });
    expect(short.status).toBe(400);
    const ok = await call(app, "privacy-01", "POST", "/api/v1/purposes/privacy_compliance/identity-lookup", { q: String(s.truth.full_name).slice(0, 5) });
    const body = (await ok.json()) as { rows: { employee_ref: string }[] };
    expect(body.rows.map((r) => r.employee_ref)).toContain(s.employee_ref);
    const noCsrf = await app.request(`${BASE}/api/v1/purposes/privacy_compliance/identity-lookup`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await tokenFor("privacy-01") }, body: JSON.stringify({ q: "abc" }) }, env);
    expect(noCsrf.status).toBe(403);
  });

  it("analyst datasets and extracts", async () => {
    const { app } = worldApp();
    const hc = await call(app, "analyst-01", "GET", "/api/v1/purposes/workforce_analytics/datasets/headcount_monthly");
    expect(hc.status).toBe(200);
    const af = await call(app, "analyst-01", "GET", "/api/v1/purposes/workforce_analytics/datasets/attrition_features?month=2026-09-01");
    expect(((await af.json()) as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    expect((await call(app, "analyst-01", "GET", "/api/v1/purposes/workforce_analytics/datasets/attrition_features")).status).toBe(400);
    expect((await call(app, "analyst-01", "GET", "/api/v1/purposes/workforce_analytics/datasets/raw_dump")).status).toBe(404);
    const ex = await call(app, "analyst-01", "POST", "/api/v1/purposes/workforce_analytics/extracts", { month: "2026-09" });
    expect(ex.status).toBe(201);
    const { key, rows } = (await ex.json()) as { key: string; rows: number };
    const obj = await env.DERIVED.get(key);
    expect(obj?.customMetadata).toMatchObject({ purpose: "workforce_analytics", subject_key: "analytics_id", created_by: "analyst-01", month: "2026-09" });
    expect((await obj!.text()).trim().split("\n")).toHaveLength(rows);
  });

  it("caches each manager's team roster once", async () => {
    const { app, wh } = worldApp();
    const r1 = await call(app, "mgr-001", "GET", "/api/v1/purposes/team_management/team");
    const roster = ((await r1.json()) as { rows: { employee_ref: string }[] }).rows;
    const expected = [subject("mgr-001", "held_direct_report", 0), ...[0, 1, 2, 3].map((i) => subject("mgr-001", "direct_report", i))].map((x) => x.employee_ref);
    expect(roster.map((r) => r.employee_ref).sort()).toEqual(expected.sort());
    const n = wh.calls.length;
    await call(app, "mgr-001", "GET", "/api/v1/purposes/team_management/team");
    expect(wh.calls.length).toBe(n);
  });
});
