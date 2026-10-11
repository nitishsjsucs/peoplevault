import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { eraseKvCaches } from "../../src/worker/erase/kv-cache.ts";
import { INSTANCE_BUDGET, STEP_BUDGET } from "../../src/worker/storage/op-budget.ts";
import { probeKv } from "../../src/worker/verify/kv-probe.ts";
import { subjectMatchers } from "../../src/worker/verify/tokens.ts";
import { executorEraseResult, executorIdentityResult, identityOf, seedObjects, seedWorld, subject } from "../fixtures/seed.ts";

const STEPS = [
  "check-legal-hold", "start-and-suppress", "discover-worker-assets", "erase-r2-exports-hris", "erase-r2-exports-payroll", "erase-r2-exports-leave",
  "erase-r2-exports-performance", "erase-r2-extracts", "erase-kv-caches", "enqueue-executor-erase", "record-executor-erase", "verify-r2", "verify-kv",
  "verify-d1", "combine-verdicts", "decide-identity-erasure", "erase-identity-records", "record-executor-identity", "record-residuals", "redact-request", "finalize",
];

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
  // the full population's footprint: 420 KV entries and 47 R2 objects (41 exports + 6 extracts)
  const puts = [];
  for (let i = 0; i < 420 - 0; i++) puts.push(env.CACHE.put(`profile:workforce_analytics:an_budget${String(i).padStart(20, "0")}`, JSON.stringify({ v: 1, profile: { org_unit: "X" }, scope: {} })));
  await Promise.all(puts);
  for (let i = 0; i < 37; i++) await env.EXPORTS.put(`exports/hris/employees/dt=2025-0${(i % 9) + 1}-${String(i).padStart(2, "0")}/employees.jsonl`, '{"employee_id":"E29999"}\n');
  for (let i = 0; i < 5; i++) await env.DERIVED.put(`extracts/workforce_analytics/attrition/month=2026-0${i + 1}/attrition.jsonl`, '{"analytics_id":"an_x"}\n');
});

describe("operation budget (1,000 external operations per invocation; design limits 500 per step, 900 per instance)", () => {
  it("a full deletion at the full population's key and object counts stays within both limits", async () => {
    expect((await env.CACHE.list()).keys.length).toBeGreaterThanOrEqual(420);
    const s = subject("hrbp-02", "in_unit", 0);
    const ident = await identityOf(s.employee_ref);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES ('req-budget', 'dsr', ?, ?, 'received', 'privacy-01', ?)")
      .bind(ident.subject_ref, ident.employee_id, new Date().toISOString())
      .run();
    await using instance = await introspectWorkflowInstance(env.DELETION, "req-budget");
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
      await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
    });
    await env.DELETION.create({ id: "req-budget", params: { requestId: "req-budget" } });
    await instance.waitForStatus("complete");
    let total = 0;
    const perStep: Record<string, number> = {};
    for (const name of STEPS) {
      const out = (await instance.waitForStepResult({ name })) as { ops: number };
      expect(typeof out.ops).toBe("number");
      perStep[name] = out.ops;
      total += out.ops;
      expect(out.ops, name).toBeLessThanOrEqual(STEP_BUDGET);
    }
    expect(total).toBeLessThanOrEqual(INSTANCE_BUDGET);
    // KV probe: one list page, five bulk gets of at most 100 keys, two D1 reads for the subject's tokens (request, identity row)
    expect(perStep["verify-kv"]).toBe(1 + Math.ceil(420 / 100) + 2);
  });

  it("KV bulk reads use chunks of at most 100 keys", async () => {
    const sizes: number[] = [];
    const spy = new Proxy(env.CACHE, {
      get(t, prop) {
        const v = Reflect.get(t, prop);
        if (prop === "get") {
          return (key: string | string[], type?: unknown) => {
            if (Array.isArray(key)) sizes.push(key.length);
            return (v as (...a: unknown[]) => unknown).call(t, key, type);
          };
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ident = await identityOf(subject("hrbp-02", "in_unit", 1).employee_ref);
    const tokens = { employeeId: ident.employee_id, workEmail: ident.work_email, fullName: ident.full_name, employeeRef: ident.employee_ref, warehouseKey: ident.warehouse_key, analyticsId: ident.analytics_id };
    await probeKv(spy, subjectMatchers(tokens, { includeFullName: true }));
    await eraseKvCaches(spy, { ...tokens, subjectRef: ident.subject_ref });
    expect(sizes.length).toBeGreaterThan(4);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  });
});
