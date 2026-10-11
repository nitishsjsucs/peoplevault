import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { call, executorEraseResult, executorIdentityResult, identityOf, seedObjects, seedWorld, subject, worldApp } from "../fixtures/seed.ts";

const lines: string[] = [];
const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
  vi.spyOn(console, k).mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }),
);

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
});
afterAll(() => spies.forEach((s) => s.mockRestore()));

describe("console output carries no identifiers", () => {
  it("during an identity lookup, a failing warehouse call and a full deletion workflow", async () => {
    const target = await identityOf(subject("hrbp-02", "in_unit", 0).employee_ref);
    const { app } = worldApp();
    await call(app, "privacy-01", "POST", "/api/v1/purposes/privacy_compliance/identity-lookup", { q: target.full_name.slice(0, 6) });
    const broken = (await import("../../src/worker/app.ts")).buildApp({
      warehouseFactory: () => ({
        run: async () => {
          throw new (await import("../../src/worker/warehouse/client.ts")).WarehouseError("backend_error");
        },
      }),
    });
    expect((await call(broken, "privacy-01", "POST", "/api/v1/purposes/privacy_compliance/identity-lookup", { q: target.full_name.slice(0, 6) })).status).toBe(502);
    const res = await call(app, "privacy-01", "POST", "/api/v1/privacy/deletion-requests", { employee_ref: target.employee_ref, reason: "data subject request" });
    const { requestId } = (await res.json()) as { requestId: string };
    await using instance = await introspectWorkflowInstance(env.DELETION, requestId);
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
      await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
    });
    await instance.waitForStatus("complete");
    expect(lines.length).toBeGreaterThan(0); // the warehouse failure logs an error code
    const all = lines.join("\n");
    for (const t of [target.employee_id, target.work_email, target.full_name, target.employee_ref, target.warehouse_key, target.analytics_id, target.subject_ref]) {
      expect(all).not.toContain(t);
    }
    expect(all).not.toMatch(/\bE\d{5}\b/);
  });
});
