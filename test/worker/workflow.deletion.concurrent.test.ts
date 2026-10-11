import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, executorEraseResult, executorIdentityResult, seedObjects, seedWorld, SUBJECTS, worldApp } from "../fixtures/seed.ts";

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
});

describe("concurrent deletions", () => {
  it("10 fixture deletions created together all end clean; a second DSR for one subject is 409", async () => {
    await using introspector = await introspectWorkflow(env.DELETION);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.mockEvent({ type: "executor_result_erase", payload: executorEraseResult() });
      await m.mockEvent({ type: "executor_result_identity", payload: executorIdentityResult() });
    });
    const { app } = worldApp();
    // non-managers who are not held and not deleted
    const subjects = SUBJECTS["*"]!.active!;
    const candidates = [];
    for (const s of subjects) {
      const reports = await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_map i JOIN identity_map m ON m.manager_employee_id = i.employee_id WHERE i.employee_ref = ?").bind(s.employee_ref).first<{ n: number }>();
      if (reports!.n === 0) candidates.push(s);
      if (candidates.length === 10) break;
    }
    expect(candidates).toHaveLength(10);
    // a subject with an in-flight request cannot get a second one
    const inflight = SUBJECTS["*"]!.terminated![0]!;
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, status, requested_by, created_at) VALUES ('req-inflight', 'dsr', ?, 'running', 'privacy-01', '2026-10-01T00:00:00Z')").bind(inflight.subject_ref).run();
    const dup = await call(app, "privacy-01", "POST", "/api/v1/privacy/deletion-requests", { employee_ref: inflight.employee_ref, reason: "data subject request" });
    expect(dup.status).toBe(409);
    await env.DB.prepare("DELETE FROM deletion_requests WHERE id = 'req-inflight'").run();
    const responses = await Promise.all(candidates.map((s) => call(app, "privacy-01", "POST", "/api/v1/privacy/deletion-requests", { employee_ref: s.employee_ref, reason: "data subject request" })));
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(202));
    const instances = await introspector.get();
    expect(instances).toHaveLength(10);
    for (const i of instances) await i.waitForStatus("complete");
    const statuses = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM deletion_requests GROUP BY status").all();
    expect(statuses.results).toEqual([{ status: "completed_with_residuals", n: 10 }]);
    const notClean = await env.DB.prepare("SELECT COUNT(*) AS n FROM deletion_asset_results WHERE verify_status NOT IN ('clean', 'not_applicable')").first<{ n: number }>();
    expect(notClean!.n).toBe(0);
    const hris = await (await env.EXPORTS.get("exports/hris/employees/dt=2026-09-28/employees.jsonl"))!.text();
    for (const s of candidates) expect(hris).not.toContain(String(s.truth.work_email));
  });
});
