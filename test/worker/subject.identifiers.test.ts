import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "../../src/worker/assets/subject.ts";
import { seedWorld } from "../fixtures/seed.ts";

beforeAll(async () => {
  await seedWorld();
});

describe("subject identifiers", () => {
  // Regression (full deletion eval, 2026-10-10): a manager's identifiers used to carry the employee ids of the
  // manager's direct reports. They are copied into the manager's executor task payload, so a report deleted at the
  // same time found its own employee id in D1 (executor_tasks) during its final probe and failed verification.
  it("hold only the subject's own identifiers, never a direct report's", async () => {
    const mgr = await env.DB.prepare(
      "SELECT m.employee_id, m.subject_ref FROM identity_map m WHERE EXISTS (SELECT 1 FROM identity_map r WHERE r.manager_employee_id = m.employee_id) ORDER BY m.employee_id LIMIT 1",
    ).first<{ employee_id: string; subject_ref: string }>();
    expect(mgr).not.toBeNull();
    const reports = await env.DB.prepare("SELECT employee_id, work_email, full_name, employee_ref, warehouse_key, analytics_id, subject_ref FROM identity_map WHERE manager_employee_id = ?")
      .bind(mgr!.employee_id)
      .all<Record<string, string>>();
    expect(reports.results.length).toBeGreaterThan(0);
    await env.DB.prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES ('req-mgr', 'dsr', ?, ?, 'running', 'privacy-01', '2026-10-01T00:00:00Z')")
      .bind(mgr!.subject_ref, mgr!.employee_id)
      .run();
    const s = await loadSubject(env.DB, "req-mgr");
    expect(s.employeeId).toBe(mgr!.employee_id);
    expect(Object.keys(s).sort()).toEqual(["analyticsId", "employeeId", "employeeRef", "fullName", "subjectRef", "warehouseKey", "workEmail"]);
    const text = JSON.stringify(s);
    for (const r of reports.results) for (const v of Object.values(r)) expect(text).not.toContain(v);
  });
});
