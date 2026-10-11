// zod request schemas for the HTTP API (SPEC.md section 13). Bodies are validated before any decision runs.
import { z } from "zod";

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
