// Deletion request records and workflow instance creation (SPEC.md sections 9.2, 13 and 14.1).
// Workers Free keeps completed Workflow instances 3 days, and `retention` can only shorten that (SPEC.md section 30.3.5).
// Receipts live in D1, so nothing is lost when an instance disappears.
export const INSTANCE_RETENTION = { successRetention: "3 days", errorRetention: "3 days" } as const;

export interface DeletionRequestRow {
  id: string;
  kind: "dsr" | "retention";
  subject_ref: string;
  employee_id: string | null;
  status: "received" | "held" | "running" | "completed" | "completed_with_residuals" | "failed";
  requested_by: string;
  workflow_instance_id: string | null;
  created_at: string;
  completed_at: string | null;
  summary_json: string | null;
  admitted_at?: string | null;
}

export class ActiveRequestExists extends Error {
  override name = "ActiveRequestExists";
}

/** Inserts a request; the unique partial index allows one active (received, held, running) request per subject. */
export async function insertRequest(
  db: D1Database,
  r: { id: string; kind: "dsr" | "retention"; subjectRef: string; employeeId: string; requestedBy: string; status?: "received" | "held" },
): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO deletion_requests (id, kind, subject_ref, employee_id, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(r.id, r.kind, r.subjectRef, r.employeeId, r.status ?? "received", r.requestedBy, new Date().toISOString())
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new ActiveRequestExists("active_request_exists");
    throw e;
  }
}

/** `<id>` -> `<id>-r1` -> `<id>-r2` ... */
export function nextInstanceId(requestId: string, current: string | null): string {
  if (!current || current === requestId) return `${requestId}-r1`;
  const m = /-r(\d+)$/.exec(current);
  return `${requestId}-r${m ? Number(m[1]) + 1 : 1}`;
}

export async function getRequest(db: D1Database, id: string): Promise<DeletionRequestRow | null> {
  return db.prepare("SELECT * FROM deletion_requests WHERE id = ?").bind(id).first<DeletionRequestRow>();
}

/** Request fields safe to return: never employee_id. */
export function publicRequest(r: DeletionRequestRow) {
  return {
    id: r.id,
    kind: r.kind,
    subjectRef: r.subject_ref,
    status: r.status,
    requestedBy: r.requested_by,
    workflowInstanceId: r.workflow_instance_id,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    admittedAt: r.admitted_at ?? null,
    summary: r.summary_json ? JSON.parse(r.summary_json) : null,
  };
}
