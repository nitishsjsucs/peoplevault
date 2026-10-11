// zod request schemas for the HTTP API (SPEC.md section 13). Bodies are validated before any decision runs.
import { z } from "zod";
import { AUDIT_VERIFY_WINDOW } from "./limits.ts";

const ref = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z2-7]{26}$`));

export const IdentityLookupBody = z.object({ q: z.string().trim().min(3).max(100) }).strict();
export const ExtractBody = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();
export const DeletionRequestBody = z.object({ employee_ref: ref("er"), reason: z.string().trim().min(3).max(200) }).strict();
export const LegalHoldBody = z
  .object({ matter_id: z.string().regex(/^[A-Z]{2}-\d{4}-\d{3}$/), employee_ref: ref("er"), reason: z.string().trim().min(3).max(200) })
  .strict();
export const RetentionRunBody = z
  .object({ as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), max_subjects: z.number().int().positive().max(10000).optional() })
  .strict();
export const ClaimBody = z.object({ phases: z.array(z.enum(["erase", "identity", "retention"])).min(1), max: z.number().int().min(1).max(25).default(25), lease_seconds: z.number().int().min(30).max(3600).default(600) }).strict();
/** GET /api/v1/privacy/audit/verify?after_seq&limit (SPEC.md section 30.3.2) */
export const AuditVerifyQuery = z.object({ after_seq: z.coerce.number().int().min(0), limit: z.coerce.number().int().min(1).max(AUDIT_VERIFY_WINDOW) }).strict();
/** GET /api/v1/privacy/reports/deletion?from&to&limit&cursor: failures are paged, at most 100 per page */
export const ReportQuery = z
  .object({
    from: z.string().max(40).nullable(),
    to: z.string().max(40).nullable(),
    limit: z.coerce.number().int().min(1).max(100),
    cursor: z.string().regex(/^[A-Za-z0-9_-]{1,600}$/).nullable(),
  })
  .strict();
/** GET /api/v1/executor/audit-export?after_seq&limit (SPEC.md section 30.3.3) */
export const AuditExportQuery = z.object({ after_seq: z.coerce.number().int().min(0), limit: z.coerce.number().int().min(1).max(500) }).strict();
/** Schema-drift triage (SPEC.md sections 16.3 and 30.3.6): a column name and at most 5 sample values. */
const columnName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_ .-]{0,63}$/);
export const DriftClassifyBody = z.object({ column: columnName, samples: z.array(z.string().max(200)).max(5) }).strict();
export const DriftSuggestBody = z.object({ column: columnName }).strict();
