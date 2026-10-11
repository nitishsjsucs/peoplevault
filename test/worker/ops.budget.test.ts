// Workers Free budgets per Workflow step and instance (SPEC.md sections 14.1, 18.5 and 30.3.1), at the full
// population's sizes: 41 export objects of the generated sizes (9.25 MiB) and 6 extracts (1.21 MiB), built here as
// filler around the fixture world's rows (the worker project reads no generated file), plus 420 KV entries.
// Per step: decoded R2 bytes within the step's cap, at most 40 D1 statements (batch statements counted one by one),
// at most 500 KV, R2 and D1 calls; per instance at most 900 calls; and exact step counts for a completed deletion,
// a deletion that fails verification and a held request.
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { eraseKvCaches } from "../../src/worker/erase/kv-cache.ts";
import { INSTANCE_BUDGET, STEP_BUDGET, STEP_D1_STATEMENTS } from "../../src/worker/storage/op-budget.ts";
import { probeKv } from "../../src/worker/verify/kv-probe.ts";
import { subjectMatchers } from "../../src/worker/verify/tokens.ts";
import { executorEraseResult, executorIdentityResult, identityOf, seedObjects, seedWorld, subject } from "../fixtures/seed.ts";

const ERASE_CAP = 4_194_304;
const PROBE_CAP = 2_097_152;

// Object sizes of `pv synth` (seed 20261010), rounded: HRIS 13 x 632,360; payroll 12 x 33,320; leave 12 x 12,750;
// performance 4 x 230,480; extracts 6 x 211,185.
const HRIS_DATES = ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"];
const MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const FULL_EXPORTS: [string, number, "jsonl" | "csv"][] = [
  ...HRIS_DATES.map((d) => [`exports/hris/employees/dt=${d}/employees.jsonl`, 632_360, "jsonl"] as [string, number, "jsonl"]),
  ...MONTHS.map((m) => [`exports/payroll/compensation/period=${m}/compensation.csv`, 33_320, "csv"] as [string, number, "csv"]),
  ...MONTHS.map((m) => [`exports/leave/requests/month=${m}/requests.jsonl`, 12_750, "jsonl"] as [string, number, "jsonl"]),
  ...["2024H2", "2025H1", "2025H2", "2026H1"].map((c) => [`exports/performance/reviews/cycle=${c}/reviews.jsonl`, 230_480, "jsonl"] as [string, number, "jsonl"]),
];
const FULL_EXTRACTS = MONTHS.slice(6).map((m) => `extracts/workforce_analytics/attrition/month=${m}/attrition.jsonl`);

function filler(format: "jsonl" | "csv", bytes: number): string {
  const lines: string[] = [];
  let n = 0;
  let size = 0;
  while (size < bytes) {
    const id = `F${String(n++).padStart(5, "0")}`;
    const line = format === "csv" ? `${id},2026-09-30,100000.0,10.0,USD` : JSON.stringify({ employee_id: id, full_name: "Filler Row", note: "x".repeat(420) });
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n") + "\n";
}

async function fill(bucket: R2Bucket, key: string, bytes: number, format: "jsonl" | "csv", meta?: Record<string, string>): Promise<void> {
  const existing = await bucket.get(key);
  const head = existing ? await existing.text() : format === "csv" ? "employee_id,pay_period_end,base_salary,bonus_target_pct,currency\n" : "";
  const body = head + filler(format, Math.max(0, bytes - head.length)).split("\n").filter(Boolean).join("\n") + "\n";
  await bucket.put(key, body, meta ? { customMetadata: meta } : {});
}

interface StepOut {
  ops: number;
  d1Statements: number;
  r2Bytes: number;
  done?: boolean;
}

async function run(id: string, employeeRef: string, events: boolean): Promise<{ steps: number; status: string; instance: Awaited<ReturnType<typeof introspectWorkflowInstance>> }> {
  const ident = await identityOf(employeeRef);
  await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES (?, 'dsr', ?, ?, 'received', 'privacy-01', ?)")
    .bind(id, ident.subject_ref, ident.employee_id, new Date().toISOString())
    .run();
  const instance = await introspectWorkflowInstance(env.DELETION, id);
  await instance.modify(async (m) => {
    await m.disableSleeps();
    if (events) {
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
      await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
    }
  });
  await env.DELETION.create({ id, params: { requestId: id } });
  await instance.waitForStatus("complete");
  const out = (await instance.getOutput()) as { status: string; steps: number };
  return { ...out, instance };
}

async function cursorSteps(instance: Awaited<ReturnType<typeof introspectWorkflowInstance>>, prefix: string): Promise<StepOut[]> {
  const outs: StepOut[] = [];
  for (let n = 1; ; n++) {
    const out = (await instance.waitForStepResult({ name: `${prefix}-${n}` })) as StepOut;
    outs.push(out);
    if (out.done) return outs;
  }
}

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
  for (const [key, bytes, format] of FULL_EXPORTS) await fill(env.EXPORTS, key, bytes, format);
  for (const key of FULL_EXTRACTS) await fill(env.DERIVED, key, 211_185, "jsonl", { purpose: "workforce_analytics", subject_key: "analytics_id", created_by: "analyst-01", month: key.slice(-23, -16) });
  const puts = [];
  for (let i = 0; i < 420; i++) puts.push(env.CACHE.put(`profile:workforce_analytics:an_budget${String(i).padStart(20, "0")}`, JSON.stringify({ v: 1, profile: { org_unit: "X" }, scope: {} })));
  await Promise.all(puts);
});

describe("Workers Free budgets at the full population's sizes", () => {
  it("the R2 fixtures have the generated sizes: 41 export objects of 9.25 MiB and 6 extracts of 1.21 MiB", async () => {
    const exportsList = await env.EXPORTS.list({ prefix: "exports/", limit: 1000 });
    const extractList = await env.DERIVED.list({ prefix: "extracts/", limit: 1000 });
    expect(exportsList.objects).toHaveLength(41);
    expect(extractList.objects).toHaveLength(6);
    expect(exportsList.objects.reduce((n, o) => n + o.size, 0) / 1_048_576).toBeCloseTo(9.25, 1);
    expect(extractList.objects.reduce((n, o) => n + o.size, 0) / 1_048_576).toBeCloseTo(1.21, 1);
  });

  it("a completed deletion: 28 steps (3 erase and 6 probe cursor steps), every step within its caps, the instance within 900 calls", async () => {
    const s = subject("hrbp-02", "in_unit", 0);
    const { steps, status, instance } = await run("req-budget", s.employee_ref, true);
    expect(status).toMatch(/^completed/);
    expect(steps).toBe(28);
    const erase = await cursorSteps(instance, "erase-r2");
    const probe = await cursorSteps(instance, "verify-r2");
    expect([erase.length, probe.length]).toEqual([3, 6]);
    for (const o of erase) expect(o.r2Bytes).toBeLessThanOrEqual(ERASE_CAP);
    for (const o of probe) expect(o.r2Bytes).toBeLessThanOrEqual(PROBE_CAP);
    const names = [
      "load-request", "check-legal-hold", "start-and-suppress", "discover-worker-assets", "erase-kv-caches", "enqueue-executor-erase", "record-executor-erase",
      "verify-kv", "verify-d1", "combine-verdicts", "decide-identity-erasure", "erase-identity-records", "record-executor-identity", "record-residuals", "redact-request", "finalize",
    ];
    let total = 0;
    for (const o of [...erase, ...probe]) {
      expect(o.ops).toBeLessThanOrEqual(STEP_BUDGET);
      expect(o.d1Statements).toBeLessThanOrEqual(STEP_D1_STATEMENTS);
      total += o.ops;
    }
    for (const name of names.slice(1)) {
      const o = (await instance.waitForStepResult({ name })) as StepOut;
      expect(o.ops, name).toBeLessThanOrEqual(STEP_BUDGET);
      expect(o.d1Statements, name).toBeLessThanOrEqual(STEP_D1_STATEMENTS);
      expect(o.r2Bytes, name).toBe(0);
      total += o.ops;
    }
    expect(total).toBeLessThanOrEqual(INSTANCE_BUDGET);
    // KV probe: one list page, five bulk gets of at most 100 keys, two D1 reads for the subject's tokens
    expect(((await instance.waitForStepResult({ name: "verify-kv" })) as StepOut).ops).toBe(1 + Math.ceil(420 / 100) + 2 + 0);
    await instance.dispose();
  });

  it("a deletion that fails verification ends after decide-identity-erasure: 23 steps", async () => {
    const s = subject("hrbp-02", "in_unit", 2);
    const ident = await identityOf(s.employee_ref);
    await env.EXPORTS.put("notes/budget-residue.txt", `ticket mentions ${ident.work_email}\n`);
    const { steps, status, instance } = await run("req-budget-fail", s.employee_ref, true);
    expect(status).toBe("failed");
    expect(steps).toBe(23);
    await instance.dispose();
    await env.EXPORTS.delete("notes/budget-residue.txt");
  });

  it("a held request: 3 steps", async () => {
    const { steps, status, instance } = await run("req-budget-held", subject("*", "held", 0).employee_ref, false);
    expect([status, steps]).toEqual(["held", 3]);
    await instance.dispose();
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
