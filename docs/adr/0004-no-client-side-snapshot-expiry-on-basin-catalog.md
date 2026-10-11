# ADR 0004: No client-side snapshot expiry on Basin Catalog

Status: accepted (2026-10-10)

## Context

After an Iceberg delete, older snapshots still reference data files that contain the subject. pyiceberg's `expire_snapshots` removes snapshot metadata but not data files. Basin Catalog (formerly R2 Data Catalog) offers managed snapshot expiration, which removes old snapshots and unreferenced data files.

## Decision

- Locally (pyiceberg SqlCatalog), `pv lake expire` expires snapshots with timezone-aware cutoffs and then purges orphaned data files explicitly.
- In production, client-side expiry is refused (`--target prod` raises). Basin's managed expiration is configured per table (`--older-than-days 1 --retain-last 1`).

## Consequences

Files of snapshots removed by a client would look, to the managed job, like files never referenced by a snapshot, and might never be cleaned. Production residuals therefore depend on Basin's maintenance schedule: `iceberg_snapshots` is observed by scanning retained snapshots, and `iceberg_orphan_files` is modeled until R2 S3 credentials allow observed scanning (P1).
