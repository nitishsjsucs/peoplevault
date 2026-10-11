import { createExecutionContext, createMessageBatch, createScheduledController, getQueueResult, introspectWorkflow, introspectWorkflowInstance, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../../src/worker/index.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { identityOf, seedWorld, subject } from "../fixtures/seed.ts";

const OLD = "exports/hris/employees/dt=2026-07-06/employees.jsonl"; // past 56 days of 2026-09-30
const OLD2 = "exports/hris/employees/dt=2026-07-13/employees.jsonl";
const NEW = "exports/hris/employees/dt=2026-09-28/employees.jsonl";
const PAY_OLD = "exports/payroll/compensation/period=2025-10/compensation.csv";
const EXTRACT_OLD = "extracts/workforce_analytics/attrition/month=2026-04/attrition.jsonl";
const EXTRACT_NEW = "extracts/workforce_analytics/attrition/month=2026-09/attrition.jsonl";

beforeAll(async () => {
  await seedWorld();
  const held = await identityOf(subject("*", "held", 0).employee_ref);
  const other = await identityOf(subject("*", "active", 0).employee_ref);
  const row = (id: string) => JSON.stringify({ employee_id: id, full_name: "x" });
  await env.EXPORTS.put(OLD, `${row(held.employee_id)}\n${row(other.employee_id)}\n`);
  await env.EXPORTS.put(OLD2, `${row(other.employee_id)}\n`);
  await env.EXPORTS.put(NEW, `${row(other.employee_id)}\n`);
  await env.EXPORTS.put(PAY_OLD, `employee_id,pay_period_end,base_salary,bonus_target_pct,currency\n${other.employee_id},2025-10-31,1,1,USD\n`);
  await env.DERIVED.put(EXTRACT_OLD, `{"analytics_id":"${other.analytics_id}"}\n`, { customMetadata: { month: "2026-04" } });
  await env.DERIVED.put(EXTRACT_NEW, `{"analytics_id":"${other.analytics_id}"}\n`, { customMetadata: { month: "2026-09" } });
});

describe("RetentionSweepWorkflow", () => {
  it("deletes or minimizes objects past retention, expires extracts, and turns old terminations into queued requests", async () => {
    await using deletions = await introspectWorkflow(env.DELETION);
    await deletions.modifyAll(async (m) => m.disableSleeps());
    await using run = await introspectWorkflowInstance(env.RETENTION, "retention-2026-09-30");
    await run.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_retention", payload: { taskId: "t", ok: true, result: { assets: [], findings: [], residuals: [], counts: { raw_rows_expired_hris_employees: 3 } } } });
    });
    await env.RETENTION.create({ id: "retention-2026-09-30", params: { asOf: "2026-09-30" } });
    await run.waitForStatus("complete");
    const out = (await run.getOutput()) as Record<string, number | string>;
    expect(out).toMatchObject({ status: "completed", exportObjectsDeleted: 2, exportObjectsMinimized: 1, extractsDeleted: 1, retentionRequests: 1, retentionHeld: 0 });
    const held = await identityOf(subject("*", "held", 0).employee_ref);
    const minimized = await env.EXPORTS.get(OLD);
    expect((await minimized!.text()).trim().split("\n").map((l) => JSON.parse(l).employee_id)).toEqual([held.employee_id]);
    expect(minimized!.customMetadata?.pv_minimized_by).toBe("retention-2026-09-30");
    expect(await env.EXPORTS.get(OLD2)).toBeNull();
    expect(await env.EXPORTS.get(PAY_OLD)).toBeNull();
    expect(await env.EXPORTS.get(NEW)).not.toBeNull();
    expect(await env.DERIVED.get(EXTRACT_OLD)).toBeNull();
    expect(await env.DERIVED.get(EXTRACT_NEW)).not.toBeNull();
    const reqs = await env.DB.prepare("SELECT kind, status FROM deletion_requests WHERE id LIKE 'retention-2026-09-30-%'").all();
    expect(reqs.results).toEqual([{ kind: "retention", status: "received" }]);
    const runRow = await env.DB.prepare("SELECT status, summary_json FROM retention_runs WHERE id = 'retention-2026-09-30'").first<{ status: string; summary_json: string }>();
    expect(runRow!.status).toBe("completed");
    expect(JSON.parse(runRow!.summary_json).executorCounts).toEqual({ raw_rows_expired_hris_employees: 3 });
  });

  it("records held subjects as held requests instead of queueing them", async () => {
    const termHeld = await env.DB.prepare("SELECT subject_ref FROM identity_map WHERE employee_id = 'E10015'").first<{ subject_ref: string }>();
    await env.DB.prepare("INSERT INTO legal_holds (id, matter_id, subject_ref, reason, placed_by, placed_at) VALUES ('hold-r1', 'LH-2026-005', ?, 'x', 'privacy-01', '2026-09-01T00:00:00Z')").bind(termHeld!.subject_ref).run();
    await env.DB.prepare("DELETE FROM deletion_requests WHERE subject_ref = ?").bind(termHeld!.subject_ref).run();
    await using run = await introspectWorkflowInstance(env.RETENTION, "retention-2026-09-30-max5");
    await run.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_retention", payload: { taskId: "t", ok: true, result: { assets: [], findings: [], residuals: [], counts: {} } } });
    });
    await env.RETENTION.create({ id: "retention-2026-09-30-max5", params: { asOf: "2026-09-30", maxSubjects: 5 } });
    await run.waitForStatus("complete");
    expect(await run.getOutput()).toMatchObject({ retentionRequests: 0, retentionHeld: 1 });
    const r = await env.DB.prepare("SELECT status FROM deletion_requests WHERE subject_ref = ?").bind(termHeld!.subject_ref).first();
    expect(r).toEqual({ status: "held" });
  });
});

describe("queue consumer", () => {
  it("creates instances with createBatch (object form), acks existing ids and retries other errors", async () => {
    await using deletions = await introspectWorkflow(env.DELETION);
    await deletions.modifyAll(async (m) => m.disableSleeps());
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, status, requested_by, created_at) VALUES ('rq-a', 'retention', 'sr_qa', 'received', 'retention-sweep', 'x')").run();
    await env.DELETION.create({ id: "rq-existing", params: { requestId: "rq-existing" } });
    const batch = createMessageBatch("pv-retention-sweep", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { requestId: "rq-a" } },
      { id: "m2", timestamp: new Date(), attempts: 1, body: { requestId: "rq-existing" } },
      { id: "m3", timestamp: new Date(), attempts: 1, body: { requestId: "bad id with spaces and a very long suffix ".repeat(4) } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["m1", "m2"]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m3"]);
  });
});

describe("cron", () => {
  it("creates retention-<as_of> once and ignores an existing instance", async () => {
    await using runs = await introspectWorkflow(env.RETENTION);
    await runs.modifyAll(async (m) => m.disableSleeps());
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 3 * * *", scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    const ctx2 = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 3 * * *", scheduledTime: Date.now() }), env, ctx2);
    await waitOnExecutionContext(ctx2);
    const instances = await runs.get();
    expect(instances).toHaveLength(1);
    const status = await (await env.RETENTION.get("retention-2026-09-30")).status();
    expect(status.status).not.toBe("unknown");
  });
});
