import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/worker/audit/audit-log.ts";
import { executorEraseResult, executorIdentityResult, identityOf, seedObjects, seedWorld, subject } from "../fixtures/seed.ts";

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
});

async function startRequest(id: string, employeeRef: string) {
  const ident = await identityOf(employeeRef);
  await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES (?, 'dsr', ?, ?, 'received', 'privacy-01', ?)")
    .bind(id, ident.subject_ref, ident.employee_id, new Date().toISOString())
    .run();
  return ident;
}

describe("SubjectDeletionWorkflow happy path", () => {
  it("erases the worker assets, records all 13 assets, suppresses, redacts and appends a receipt", async () => {
    const manager = subject("mgr-003", "direct_report", 1); // a line manager (no held reports): reports reference them
    const ident = await startRequest("req-happy", manager.employee_ref);
    // cache entries: the subject's own profile and roster, and a report's profile that names the subject as manager
    await env.CACHE.put(`profile:employee_relations:${ident.employee_ref}`, JSON.stringify({ v: 1, profile: { employee_ref: ident.employee_ref, full_name: ident.full_name }, scope: { org_unit: "ENG-PRODUCT" } }));
    await env.CACHE.put(`team:${ident.employee_ref}`, JSON.stringify([{ employee_ref: "er_other", full_name: "Someone Else", job_title: "Engineer" }]));
    await env.CACHE.put("profile:team_management:er_report", JSON.stringify({ v: 1, profile: { employee_ref: "er_report" }, scope: { manager_ref: ident.employee_ref } }));
    await env.CACHE.put("profile:employee_relations:er_unrelated", JSON.stringify({ v: 1, profile: { employee_ref: "er_unrelated" }, scope: { org_unit: "FINANCE" } }));

    await using instance = await introspectWorkflowInstance(env.DELETION, "req-happy");
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
      await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
    });
    await env.DELETION.create({ id: "req-happy", params: { requestId: "req-happy" } });
    await instance.waitForStatus("complete");

    const req = await env.DB.prepare("SELECT status, employee_id, summary_json FROM deletion_requests WHERE id = 'req-happy'").first<{ status: string; employee_id: string | null; summary_json: string }>();
    expect(req!.status).toBe("completed_with_residuals");
    expect(req!.employee_id).toBeNull();
    const { results } = await env.DB.prepare("SELECT asset_id, applicability, action_status, verify_status FROM deletion_asset_results WHERE request_id = 'req-happy' ORDER BY asset_id").all<Record<string, string>>();
    expect(results.filter((r) => !r.asset_id!.startsWith("unregistered:"))).toHaveLength(13);
    expect(results.filter((r) => r.asset_id!.startsWith("unregistered:"))).toEqual([]);
    for (const r of results) expect(["clean", "not_applicable"]).toContain(r.verify_status);

    // R2: the subject's rows are gone, references to the subject are scrubbed
    const hris = await (await env.EXPORTS.get("exports/hris/employees/dt=2026-09-28/employees.jsonl"))!.text();
    expect(hris).not.toContain(ident.employee_id);
    expect(hris).toContain('"manager_employee_id":"REDACTED"');
    const perf = await (await env.EXPORTS.get("exports/performance/reviews/cycle=2026H1/reviews.jsonl"))!.text();
    expect(perf).not.toContain(ident.employee_id);
    const payroll = await (await env.EXPORTS.get("exports/payroll/compensation/period=2026-09/compensation.csv"))!.text();
    expect(payroll).not.toContain(ident.employee_id);
    const extract = await env.DERIVED.get("extracts/workforce_analytics/attrition/month=2026-09/attrition.jsonl");
    expect(await extract!.text()).not.toContain(ident.analytics_id);
    expect(extract!.customMetadata?.pv_rewritten_by).toBe("req-happy");

    // KV: own keys and keys mentioning the subject are gone, unrelated keys stay
    expect(await env.CACHE.get(`profile:employee_relations:${ident.employee_ref}`)).toBeNull();
    expect(await env.CACHE.get(`team:${ident.employee_ref}`)).toBeNull();
    expect(await env.CACHE.get("profile:team_management:er_report")).toBeNull();
    expect(await env.CACHE.get("profile:employee_relations:er_unrelated")).not.toBeNull();

    // D1: identity rows gone, references scrubbed, suppression kept, payloads purged
    expect(await env.DB.prepare("SELECT 1 FROM identity_map WHERE employee_id = ?").bind(ident.employee_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM principals WHERE employee_id = ?").bind(ident.employee_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM identity_map WHERE manager_employee_id = ?").bind(ident.employee_id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM suppression_list WHERE subject_ref = ?").bind(ident.subject_ref).first()).toEqual({ x: 1 });
    const tasks = await env.DB.prepare("SELECT id, payload_json FROM executor_tasks WHERE request_id = 'req-happy' ORDER BY id").all<{ id: string; payload_json: string | null }>();
    expect(tasks.results.map((t) => t.id)).toEqual(["req-happy:erase", "req-happy:identity"]);
    for (const t of tasks.results) expect(t.payload_json).toBeNull();

    // receipt hash in the audit chain, chain verifies
    const receipt = JSON.parse(req!.summary_json) as { perCategory: Record<string, { applicable: number; clean: number }> };
    expect(Object.keys(receipt.perCategory)).toHaveLength(6);
    const ev = await env.DB.prepare("SELECT detail_json FROM audit_events WHERE action = 'deletion_receipt' AND request_id = 'req-happy'").first<{ detail_json: string }>();
    expect(JSON.parse(ev!.detail_json).receipt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await createAuditLog(env.DB).verify()).ok).toBe(true);

    // residuals tracked separately
    const res = await env.DB.prepare("SELECT kind, state, evidence FROM residuals WHERE request_id = 'req-happy' ORDER BY kind").all<Record<string, string>>();
    expect(res.results.map((r) => r.kind)).toEqual(["bq_time_travel", "iceberg_snapshots", "kv_propagation"]);
  });
});
