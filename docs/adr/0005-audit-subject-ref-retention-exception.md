# ADR 0005: subject_ref retained in audit records

Status: accepted (2026-10-10)

## Context

Accountability requires showing that a deletion happened, who requested it and what it covered. Re-ingestion of a deleted subject must be prevented. Both need a stable key for the subject after the subject's identifiers are gone. The audit log is a hash chain, so it cannot be scrubbed without breaking verification.

## Decision

- `subject_ref` (an HMAC pseudonym under its own derived key) is retained in audit events, legal holds, the suppression list and deletion receipts after deletion.
- `subject_ref` is never a verification token: finding it in a governance table is expected, not residue.
- Principal ids are opaque (`mgr-007`, never derived from an employee id), so the audit chain never holds an identifier that a later deletion would have to scrub. Tests assert that no audit field contains any identifier token of any employee.

## Consequences

Whoever holds the master key and an employee id can recompute `subject_ref` and link it to audit history. That is the accepted trade-off; the master key lives only in the Worker secret store, the executor environment and the owner's local secrets.
