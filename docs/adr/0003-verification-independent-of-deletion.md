# ADR 0003: Verification independent of deletion

Status: accepted (2026-10-10)

## Context

A deletion system that reports its own success with the same code that performed the deletion cannot detect its own blind spots, such as a copy in a table nobody registered.

## Decision

- Verification code shares no code with erasure: `src/worker/verify/` must not import from `erase/` or `workflows/`, and `peoplevault.verify` must not import from `executor`, `load` or `lake.ops`. Tests enforce both.
- Probes scan whole stores (every R2 object and its metadata, every KV key and value, every D1 table, every warehouse schema and table, every Iceberg namespace and table) rather than registered locations. A finding outside the registry is `unregistered_residue` and fails the request.
- Matching is boundary-aware so one employee's tokens never match another employee's values.
- The eval adds an oracle that computes tokens from ground truth with its own code and reads every store directly, including Miniflare's state files.

## Consequences

Probes cost more operations than targeted checks, which is why each store is probed in its own Workflow step under an operation budget. Copies in spellings outside the design (uppercased emails, "Last, First", base64) are not matched; the eval plants three such variants and reports them as `undetected_by_design`.
