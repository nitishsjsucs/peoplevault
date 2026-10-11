// D1 identity lookups by pseudonymous ref, joined to the suppression list (SPEC.md section 14.6). One query per
// response: a suppressed subject is never served or cached by the purpose data API.
export type RefKind = "employee_ref" | "analytics_id";

export interface RefIdentity {
  employeeId: string;
  subjectRef: string;
  managerEmployeeId: string | null;
  employmentStatus: string;
  suppressed: boolean;
}

export async function identityByRef(db: D1Database, kind: RefKind, ref: string): Promise<RefIdentity | null> {
  const col = kind === "employee_ref" ? "employee_ref" : "analytics_id";
  const row = await db
    .prepare(
      `SELECT i.employee_id, i.subject_ref, i.manager_employee_id, i.employment_status, s.subject_ref AS suppressed_ref
       FROM identity_map i LEFT JOIN suppression_list s ON s.subject_ref = i.subject_ref WHERE i.${col} = ?`,
    )
    .bind(ref)
    .first<{ employee_id: string; subject_ref: string; manager_employee_id: string | null; employment_status: string; suppressed_ref: string | null }>();
  if (!row) return null;
  return {
    employeeId: row.employee_id,
    subjectRef: row.subject_ref,
    managerEmployeeId: row.manager_employee_id,
    employmentStatus: row.employment_status,
    suppressed: row.suppressed_ref !== null,
  };
}

/** Refs (of one kind) that belong to suppressed subjects. */
export async function suppressedRefs(db: D1Database, kind: RefKind): Promise<Set<string>> {
  const col = kind === "employee_ref" ? "employee_ref" : "analytics_id";
  const { results } = await db
    .prepare(`SELECT i.${col} AS ref FROM suppression_list s JOIN identity_map i ON i.subject_ref = s.subject_ref`)
    .all<{ ref: string }>();
  return new Set(results.map((r) => r.ref));
}

export async function isSubjectSuppressed(db: D1Database, subjectRef: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM suppression_list WHERE subject_ref = ?").bind(subjectRef).first();
  return row !== null;
}
