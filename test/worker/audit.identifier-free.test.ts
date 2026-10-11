import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/worker/audit/audit-log.ts";
import { call, executorEraseResult, executorIdentityResult, identityOf, seedObjects, seedWorld, subject, worldApp, type WorldIdentity } from "../fixtures/seed.ts";

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
});

describe("identifier-free audit log", () => {
  it("after reads and the deletion of a manager, no audit field contains any token of any fixture employee", async () => {
    const everyone = (await env.DB.prepare("SELECT * FROM identity_map").all<WorldIdentity>()).results;
    const { app } = worldApp();
    // reads by several personas (allow and deny decisions)
    await call(app, "mgr-002", "GET", "/api/v1/purposes/team_management/team");
    await call(app, "hrbp-01", "GET", `/api/v1/purposes/employee_relations/employees/${subject("hrbp-01", "in_unit", 0).employee_ref}`);
    await call(app, "analyst-01", "GET", "/api/v1/purposes/employee_relations/employees");
    await call(app, "privacy-01", "POST", "/api/v1/purposes/privacy_compliance/identity-lookup", { q: "Gabriel" });
    const mgr = await identityOf(subject("mgr-003", "direct_report", 1).employee_ref);
    const res = await call(app, "privacy-01", "POST", "/api/v1/privacy/deletion-requests", { employee_ref: mgr.employee_ref, reason: "data subject request" });
    const { requestId } = (await res.json()) as { requestId: string };
    await using instance = await introspectWorkflowInstance(env.DELETION, requestId);
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
      await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
    });
    await instance.waitForStatus("complete");
    const events = (await env.DB.prepare("SELECT * FROM audit_events").all<Record<string, unknown>>()).results;
    expect(events.length).toBeGreaterThan(5);
    const flat = events.map((e) => Object.values(e).map(String).join("\u0001")).join("\n");
    for (const p of everyone) for (const t of [p.employee_id, p.work_email, p.full_name, p.employee_ref, p.warehouse_key, p.analytics_id]) expect(flat).not.toContain(t);
    expect(flat).toContain(mgr.subject_ref);
    expect((await createAuditLog(env.DB).verify()).ok).toBe(true);
  });
});
