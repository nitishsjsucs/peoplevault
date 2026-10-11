# ADR 0001: Python executor bridged by Workflow events

Status: accepted (2026-10-10)

## Context

Subject deletion spans stores that a Worker can reach natively (R2, KV, D1) and stores it cannot (the DuckDB or BigQuery warehouse through dbt, and the Iceberg archive through pyiceberg). Workers cannot run DuckDB, dbt or pyiceberg.

## Decision

Python-native erasure runs in a Python executor. The deletion Workflow writes a task row to D1 (`executor_tasks`) and waits with `step.waitForEvent`. The executor claims tasks over HTTPS with a lease, performs warehouse DML, the one aggregate rebuild and the Iceberg transaction, runs its independent scanners, and completes the task. The completion route calls `instance.sendEvent` so the Workflow resumes.

## Consequences

- The same protocol works locally (`pv serve` polls `wrangler dev`) and in production (the executor authenticates through Access with a service token).
- Task payloads hold identifiers only until the `redact-request` step nulls them; results are validated so they carry counts and enums only.
- If the executor does not run, the Workflow waits until `EXECUTOR_WAIT_TIMEOUT` and the request fails; it can be retried.
