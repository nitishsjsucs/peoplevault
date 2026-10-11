# ADR 0006: Merge-only protected BigQuery tables

Status: accepted (2026-10-10)

## Context

BigQuery drops policy tags and row access policies on `CREATE OR REPLACE TABLE` (and `WRITE_TRUNCATE` and table copies remove them too), while DML and `TRUNCATE TABLE` keep them. dbt's default table rebuild replaces the table, then runs post-hooks, then re-applies tags with `persist_docs`, which leaves a window in which masking is off and the restricted population is visible through existing authorized views.

## Decision

- Every core, snapshot and row-level mart model with a tagged column or a row access policy is `materialized: incremental`, `incremental_strategy: merge`, `unique_key` set, `on_schema_change: ignore` and `full_refresh: false`. The snapshot is merge-based after creation.
- `pv dbt` refuses `--full-refresh` on the BigQuery target.
- The only rebuilt table in a protected dataset is `headcount_monthly`, which has no tagged column and no row access policy.
- Schema changes to a protected model need an explicit migration in `infra/bigquery/migrations/`, and a test fails if a protected model's columns differ from `infra/bigquery/protected_schemas.json` without one.
- After every production dbt run, `bq_controls.verify()` checks every protected table still has its tags and both row access policies, and fails the run if not.

## Consequences

Adding a column to a protected model changes nothing in an existing table until a migration runs. Locally the same configuration runs on DuckDB (dbt-duckdb `merge`), and a fresh local seed rebuilds from scratch.
