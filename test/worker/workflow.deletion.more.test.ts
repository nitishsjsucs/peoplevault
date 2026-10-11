// Held subjects, residue (unregistered copy and hold-reference conflict), executor failure and timeout, and
// identifier-free step outputs (SPEC.md 18.1: workflow.deletion.held, .residue, .executor-failure, .pii-free).
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { executorEraseResult, executorIdentityResult, identityOf, seedObjects, seedWorld, subject, type WorldIdentity } from "../fixtures/seed.ts";

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
});

async function start(id: string, employeeRef: string): Promise<WorldIdentity> {
  const ident = await identityOf(employeeRef);
  await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES (?, 'dsr', ?, ?, 'received', 'privacy-01', ?)")
    .bind(id, ident.subject_ref, ident.employee_id, new Date().toISOString())
    .run();
  return ident;
}

const tokensOf = (i: WorldIdentity) => [i.employee_id, i.work_email, i.full_name, i.employee_ref, i.warehouse_key, i.analytics_id];
// the fixture world's objects are small: one erase and one probe cursor step each
const steps = [
  "load-request", "check-legal-hold", "start-and-suppress", "discover-worker-assets", "erase-r2-1", "erase-kv-caches", "enqueue-executor-erase", "record-executor-erase",
  "verify-r2-1", "verify-kv", "verify-d1", "combine-verdicts", "decide-identity-erasure", "erase-identity-records", "verify-d1-identity", "record-executor-identity",
  "record-residuals", "redact-request", "verify-d1-final", "finalize",
];

describe("held subject", () => {
  it("stops after the hold check: status held, nothing erased, 13 held results, no suppression", async () => {
    const held = subject("*", "held", 0);
    const ident = await start("req-held", held.employee_ref);
    const before = await (await env.EXPORTS.get("exports/hris/employees/dt=2026-09-28/employees.jsonl"))!.text();
    await using instance = await introspectWorkflowInstance(env.DELETION, "req-held");
    await instance.modify(async (m) => m.disableSleeps());
    await env.DELETION.create({ id: "req-held", params: { requestId: "req-held" } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ status: "held", steps: 3 });
    const r = await env.DB.prepare("SELECT status, employee_id FROM deletion_requests WHERE id = 'req-held'").first();
    expect(r).toEqual({ status: "held", employee_id: ident.employee_id });
    const rows = await env.DB.prepare("SELECT applicability, action_status, verify_status, COUNT(*) AS n FROM deletion_asset_results WHERE request_id = 'req-held' GROUP BY 1, 2, 3").all();
    expect(rows.results).toEqual([{ applicability: "held", action_status: "skipped_hold", verify_status: "not_applicable", n: 13 }]);
    expect(await (await env.EXPORTS.get("exports/hris/employees/dt=2026-09-28/employees.jsonl"))!.text()).toBe(before);
    expect(await env.DB.prepare("SELECT 1 FROM suppression_list WHERE subject_ref = ?").bind(ident.subject_ref).first()).toBeNull();
  });
});

describe("residue", () => {
  it("an unregistered R2 copy fails the request with an unregistered finding; identity and employee_id are retained", async () => {
    const s = subject("hrbp-02", "in_unit", 0);
    const ident = await start("req-residue", s.employee_ref);
    await env.EXPORTS.put("notes/support-ticket-17.txt", `Customer asked about ${ident.work_email} yesterday.\n`);
    await using instance = await introspectWorkflowInstance(env.DELETION, "req-residue");
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
    });
    await env.DELETION.create({ id: "req-residue", params: { requestId: "req-residue" } });
    await instance.waitForStatus("complete");
    const r = await env.DB.prepare("SELECT status, employee_id FROM deletion_requests WHERE id = 'req-residue'").first();
    expect(r).toEqual({ status: "failed", employee_id: ident.employee_id });
    const un = await env.DB.prepare("SELECT asset_id, category, applicability, verify_status FROM deletion_asset_results WHERE request_id = 'req-residue' AND applicability = 'unregistered'").all();
    expect(un.results).toEqual([{ asset_id: "unregistered:r2:pv-source-exports/notes/support-ticket-17.txt", category: "source_exports", applicability: "unregistered", verify_status: "residue" }]);
    expect(await env.DB.prepare("SELECT 1 AS x FROM identity_map WHERE employee_id = ?").bind(ident.employee_id).first()).toEqual({ x: 1 });
    await env.EXPORTS.delete("notes/support-ticket-17.txt");
  });

  it("a deleted manager referenced in a held subject's rows: the reference is kept and the request fails (conservative)", async () => {
    const mgr = subject("mgr-003", "direct_report", 0); // manages the held subject
    await start("req-conflict", mgr.employee_ref);
    await using instance = await introspectWorkflowInstance(env.DELETION, "req-conflict");
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
    });
    await env.DELETION.create({ id: "req-conflict", params: { requestId: "req-conflict" } });
    await instance.waitForStatus("complete");
    expect((await env.DB.prepare("SELECT status FROM deletion_requests WHERE id = 'req-conflict'").first<{ status: string }>())!.status).toBe("failed");
    const ex = await env.DB.prepare("SELECT verify_status FROM deletion_asset_results WHERE request_id = 'req-conflict' AND asset_id = 'src.r2.exports'").first();
    expect(ex).toEqual({ verify_status: "residue" });
    const held = await identityOf(subject("*", "held", 0).employee_ref);
    const hris = await (await env.EXPORTS.get("exports/hris/employees/dt=2026-09-28/employees.jsonl"))!.text();
    const heldRow = hris.split("\n").find((l) => l.includes(held.employee_id))!;
    expect(JSON.parse(heldRow).manager_employee_id).not.toBe("REDACTED");
  });
});

describe("executor failure", () => {
  it("an ok: false result ends in failed with identity retained", async () => {
    const s = subject("hrbp-02", "in_unit", 1);
    const ident = await start("req-exfail", s.employee_ref);
    await using instance = await introspectWorkflowInstance(env.DELETION, "req-exfail");
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult({ ok: false }) });
    });
    await env.DELETION.create({ id: "req-exfail", params: { requestId: "req-exfail" } });
    await instance.waitForStatus("complete");
    expect(await env.DB.prepare("SELECT status, employee_id FROM deletion_requests WHERE id = 'req-exfail'").first()).toEqual({ status: "failed", employee_id: ident.employee_id });
    const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM deletion_asset_results WHERE request_id = 'req-exfail' AND action_status = 'failed'").first<{ n: number }>();
    expect(failed!.n).toBeGreaterThanOrEqual(6);
  });

  it("a waitForEvent timeout errors the instance and the request becomes failed", async () => {
    const s = subject("hrbp-02", "in_unit", 2);
    await start("req-timeout", s.employee_ref);
    await using instance = await introspectWorkflowInstance(env.DELETION, "req-timeout");
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.forceEventTimeout({ name: "wait-executor-erase" });
    });
    await env.DELETION.create({ id: "req-timeout", params: { requestId: "req-timeout" } });
    await instance.waitForStatus("errored");
    expect((await env.DB.prepare("SELECT status FROM deletion_requests WHERE id = 'req-timeout'").first<{ status: string }>())!.status).toBe("failed");
    const ev = await env.DB.prepare("SELECT reason FROM audit_events WHERE request_id = 'req-timeout' AND action = 'deletion_receipt'").first();
    expect(ev).toEqual({ reason: "failed" });
  });
});

describe("identifier-free step outputs", () => {
  it("no step result and no workflow output contains a token of the subject", async () => {
    const s = subject("hrbp-02", "in_unit", 3);
    const ident = await start("req-pii", s.employee_ref);
    await using instance = await introspectWorkflowInstance(env.DELETION, "req-pii");
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
      await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
    });
    await env.DELETION.create({ id: "req-pii", params: { requestId: "req-pii" } });
    await instance.waitForStatus("complete");
    const outputs = [];
    for (const name of steps) outputs.push(JSON.stringify(await instance.waitForStepResult({ name })));
    outputs.push(JSON.stringify(await instance.getOutput()));
    const all = outputs.join("\n");
    for (const t of tokensOf(ident)) expect(all).not.toContain(t);
    expect(all).not.toMatch(/\bE\d{5}\b/);
  });
});
