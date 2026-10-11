// Subject identifiers, loaded inside each Workflow step from D1 and never returned from a step (SPEC.md 12.1).
// While the subject's identity_map row exists it is the source; after identity erasure (step 14) and until
// redact-request purges it, the same fields come from this request's own `<requestId>:erase` task payload.
// Only the subject's own identifiers: the object is written into executor task payloads, so any other person's
// identifier here (for example a manager's direct reports) would sit in D1 while that person's own deletion verifies.

export interface SubjectIdentifiers {
  employeeId: string;
  workEmail: string;
  fullName: string;
  employeeRef: string;
  warehouseKey: string;
  analyticsId: string;
  subjectRef: string;
}

interface IdentityRow {
  employee_id: string;
  work_email: string;
  full_name: string;
  employee_ref: string;
  warehouse_key: string;
  analytics_id: string;
  subject_ref: string;
}

export class SubjectUnavailable extends Error {
  override name = "SubjectUnavailable";
}

export async function loadSubject(db: D1Database, requestId: string): Promise<SubjectIdentifiers> {
  const req = await db.prepare("SELECT employee_id, subject_ref FROM deletion_requests WHERE id = ?").bind(requestId).first<{ employee_id: string | null; subject_ref: string }>();
  if (!req) throw new SubjectUnavailable("request not found");
  if (req.employee_id) {
    const row = await db.prepare("SELECT employee_id, work_email, full_name, employee_ref, warehouse_key, analytics_id, subject_ref FROM identity_map WHERE employee_id = ?").bind(req.employee_id).first<IdentityRow>();
    if (row) {
      return {
        employeeId: row.employee_id,
        workEmail: row.work_email,
        fullName: row.full_name,
        employeeRef: row.employee_ref,
        warehouseKey: row.warehouse_key,
        analyticsId: row.analytics_id,
        subjectRef: row.subject_ref,
      };
    }
  }
  const task = await db
    .prepare("SELECT payload_json FROM executor_tasks WHERE request_id = ? AND phase = 'erase' AND payload_json IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    .bind(requestId)
    .first<{ payload_json: string | null }>();
  if (task?.payload_json) {
    const payload = JSON.parse(task.payload_json) as { subject: SubjectIdentifiers };
    return payload.subject;
  }
  throw new SubjectUnavailable("subject identifiers unavailable");
}
