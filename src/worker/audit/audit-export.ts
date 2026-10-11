// The audit copy's record (SPEC.md section 30.3.3): exactly the 16 fields of infra/lake/audit-events.schema.json, the
// Iceberg schema of `governance.audit_events`, in schema order. detail_json is never copied (it holds counts and enums
// that only the D1 receipts and report need). D1's hash chain stays the source of truth; `pv audit export` pulls pages
// of these records through GET /api/v1/executor/audit-export and appends them exactly once.
import schemaJson from "../../../infra/lake/audit-events.schema.json";
import type { AuditRow } from "./audit-log.ts";

export interface ExportField {
  name: string;
  type: "string" | "int64" | "timestamp";
  required: boolean;
}

export const AUDIT_EXPORT_SCHEMA = schemaJson as { fields: ExportField[] };
export const AUDIT_EXPORT_FIELDS: readonly string[] = AUDIT_EXPORT_SCHEMA.fields.map((f) => f.name);
/** Rows per page: 500 rows (about 256 KB of JSON) measured 0.64 ms to decode and encode. */
export const AUDIT_EXPORT_PAGE_MAX = 500;

export type AuditExportRecord = Omit<AuditRow, "detail_json">;

/** SQL list of the exported columns (names come from the committed schema file and are checked as identifiers). */
export function exportColumns(): string {
  for (const f of AUDIT_EXPORT_FIELDS) if (!/^[a-z_]+$/.test(f)) throw new Error("bad schema field name");
  return AUDIT_EXPORT_FIELDS.join(", ");
}
