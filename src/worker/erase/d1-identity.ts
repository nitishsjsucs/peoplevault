// Identity records in D1 (asset id.d1.identity_records): the subject's identity_map and principals rows, and
// references to the subject as a manager in identity_map (scrubbed to REDACTED).
import type { SubjectIdentifiers } from "../assets/subject.ts";
import { REDACTED, type EraseOutcome } from "./jsonl-objects.ts";

export async function countIdentityRecords(db: D1Database, s: SubjectIdentifiers): Promise<{ rows: number; refs: number }> {
  const r = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM identity_map WHERE employee_id = ?1) + (SELECT COUNT(*) FROM principals WHERE employee_id = ?1) AS rows_n,
              (SELECT COUNT(*) FROM identity_map WHERE manager_employee_id = ?1) AS refs_n`,
    )
    .bind(s.employeeId)
    .first<{ rows_n: number; refs_n: number }>();
  return { rows: r?.rows_n ?? 0, refs: r?.refs_n ?? 0 };
}

export async function eraseIdentityRecords(db: D1Database, s: SubjectIdentifiers): Promise<EraseOutcome> {
  const res = await db.batch([
    db.prepare("DELETE FROM identity_map WHERE employee_id = ?").bind(s.employeeId),
    db.prepare("DELETE FROM principals WHERE employee_id = ?").bind(s.employeeId),
    db.prepare("UPDATE identity_map SET manager_employee_id = ? WHERE manager_employee_id = ?").bind(REDACTED, s.employeeId),
  ]);
  const [a, b, c] = res.map((r) => r.meta.changes);
  return { assetId: "id.d1.identity_records", rowsBefore: (a ?? 0) + (b ?? 0) + (c ?? 0), rowsErased: (a ?? 0) + (b ?? 0), referencesScrubbed: c ?? 0 };
}
