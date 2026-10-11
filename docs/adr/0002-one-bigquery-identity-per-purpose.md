# ADR 0002: One BigQuery identity per purpose

Status: accepted (2026-10-10)

## Context

The Worker enforces persona to purpose binding and per-user row scope. A bug or compromise in the Worker should not be able to read a column class or population that a purpose must never see.

## Decision

Each of the five purposes has its own BigQuery service account (`pv-er-reader`, `pv-tm-reader`, `pv-wa-reader`, `pv-pc-reader`, `pv-lh-reader`) with read access only to its own dataset of authorized views and table functions, policy tag grants matching the visibility matrix, and membership in the row access policies its purpose allows. The Worker holds a key for `pv-gateway`, whose only permission is Token Creator on the five purpose accounts, and mints a short-lived token for the purpose of each query.

## Consequences

- BigQuery enforces a per-purpose ceiling independently of the Worker. A compromised Worker can read what the five purposes can read, never more.
- The ceiling holds only while tags and row access policies stay attached (ADR 0006), and is tested directly by 37 ceiling probes in production.
- Locally, DuckDB has no IAM, so the ceiling is emulated in generated view SQL and by the shim's purpose-to-schema allowlist. The README says so.
