# ADR 0007: Production runs on the Workers Free plan

Status: accepted (2026-10-10). Supersedes the Workers Paid requirement in SPEC.md section 16.4 and the Basin Pipelines audit stream (P1). Details, numbers and sources: SPEC.md section 30.

## Context

Nitish chose to keep the Cloudflare account on Workers Free. On his account, creating a Basin Pipelines resource fails with "This feature requires a Workers Paid plan [code: 1021]". Queues, R2 and Basin Catalog work on Free. The design before this ADR needed Paid in five places:

- the audit stream (a Basin Pipelines stream, sink and pipeline);
- `limits.cpu_ms: 300000` in the production template, which the configuration docs restrict to the Standard usage model;
- Workflow steps that needed more than Free's 10 ms of CPU;
- 30-day Workflow instance retention (Free keeps 3 days);
- a 30-day D1 Time Travel residual (Free keeps 7 days).

The 10 ms figure comes from the Workers and Workflows limits pages. The steps that exceed it were measured on 2026-10-10 by bundling the repo's own modules over the full synthetic population (Node 25.9, this Mac, warm median):

| Step or route | Measured |
|---|---|
| `discover-worker-assets` | 19.5 ms |
| `erase-r2-exports-hris` | 13.9 ms |
| retention `expire-r2-exports` | 6.1 ms |
| `GET /api/v1/privacy/audit/verify` over 1,506 events | 19.3 ms |
| the deletion report over about 10,000 result rows | 12.9 ms |

Every Free daily allowance applies per account: Workflow steps (3,000 a day), KV writes (1,000), D1 rows read (5M), Queue operations (10,000) and Workers AI neurons (10,000). One Cloudflare account, and one Google Cloud project (`master-magnet-444903-u4`), serve four repos.

## Decision

1. **No Paid feature anywhere in production.** Remove `limits` and the `pipelines` binding from the production template. Set instance retention to 3 days and the D1 Time Travel residual to 7 days. The doctor's Workers Paid check is removed.
2. **Bounded work per invocation.** Workflow steps that read R2 work through a cursor and stop at a byte cap: 4 MiB of decoded objects for erasure, 2 MiB for probing.
   - The cursor is an index into a key listing whose SHA-256 digest is checked on every step, so step outputs never carry a key and no object is skipped.
   - Erasure parses only lines that contain the subject's id.
   - Plan-time discovery of R2 and KV moves into the erase steps.
   - The D1 probe matches tokens inside SQLite (`instr`), so only candidate rows reach the Worker.
   - No step or request makes more than 40 D1 queries (Free allows 50).
   - Audit chain verification is windowed at 50 events per request (100 in the first redesign; lowered after the committed `npm run bench:cpu` median for 100 events, 2.626 ms, missed the 2.5 ms design target). Report totals are computed with SQL `GROUP BY`.
   - The BigQuery client makes at most 20 polls and 10 pages and sets `maximumBytesBilled`.

   The repo's committed measurement (`evals/results/cpu-2026-10-11.json`, `npm run bench:cpu`, 2026-10-11) puts the largest step-sized path, the probe step at the 2 MiB cap with the subject in every object, at a 1.383 ms warm median on this Mac at a load average of 2.99 (the final gate's run). Allowing three times that for edge hardware and cold isolates (4.15 ms) still leaves 58% of the 10 ms limit unused. The earlier committed run, at a load average of 7.19, measured 1.789 ms for the 50-event audit verification window (5.37 ms at three times, 46% unused): the figures move with the machine's load, and the verdict is the same. (The 1.83 ms figure first written here was the 2026-10-10 scratch measurement of the erase step alone; the first committed run measured the 100-event window at 2.626 ms, which is why the window is now 50.)
3. **The audit copy is pulled, not streamed.** `pv audit export` pages D1 audit rows through a new executor route (`GET /api/v1/executor/audit-export`) and appends them to the Basin Catalog Iceberg table `governance.audit_events` with pyiceberg.
   - Each commit records the last copied `seq` and `hash` in its snapshot summary, and pyiceberg 0.12.0 commits appends with `AssertRefSnapshotId`. So the copy is exactly once: a rerun copies nothing, and a concurrent exporter fails and retries.
   - Before it commits, the export checks that the chain links (`prev_hash` equals the previous `hash`), so a gap is never committed.
   - Replay starts from any `seq`, because D1 stays the source of truth.
   - The same code writes the local SqlCatalog table, which absorbs P1 spec item 31.
4. **Daily admission.** At most 16 deletion instances start per UTC day in production (`DAILY_DELETION_STARTS`), and retention adds at most 8 subjects a day (`RETENTION_DAILY_MAX`).
   - DSRs over the cap are accepted as `received` and deferred.
   - The daily cron re-admits deferred requests, and orphaned ones (no instance 6 hours after admission), before it starts the retention sweep. This covers Free's fixed 24-hour Queue retention, including dead-letter messages that expire.
   - The retention cron stays off until the production eval result is committed.
   - A Workflow instance for a request that is already terminal, or that belongs to another instance, changes nothing.
5. **Planning share.** On its worst-case day this repo may use at most 25% of each per-account allowance. A budget test enforces the share, and doctor lines report usage.
6. **Shared Google Cloud project.**
   - Every BigQuery and IAM name this repo creates starts with `peoplevault`. Grants are dataset- or resource-scoped; the only project-level role is `roles/bigquery.jobUser`.
   - The executor no longer holds project-level `dataViewer` or `metadataViewer`, so its verifier scans only this repo's datasets.
   - Every query sets `maximum_bytes_billed`.

## Alternatives considered

- **Workers Paid.** Rejected by the owner.
- **A Queue in place of Basin Pipelines.** Delivery takes 3 operations per message. On the eval day about 1,000 audit events would cost about 3,000 operations, which is 30% of the account's daily Queue allowance and more than this repo's 25% share. It would also be at-least-once with possible drops, where the pull export is exactly once.
- **One Workflow step per R2 object.** About 100 steps per deletion would allow about 7 deletions a day within this repo's share of 3,000 steps a day.
- **Moving R2 erasure into the Python executor over the S3 API.** Miniflare exposes no S3 endpoint, so the local and CI path would use different code from production.

## Consequences

- A completed deletion takes 30 steps (23 when verification fails, 3 when held), against 25 before. The worst-case day uses 489 steps: 65% of this repo's share and 16% of the account's 3,000.
- Deletions beyond 16 a day wait for the next day. The retention backlog of 70 subjects drains over 9 days after the cron is turned on.
- The audit copy lags D1 by up to a day. The doctor reports the lag.
- D1 Time Travel keeps deleted identity rows for 7 days, not 30.
- The CPU estimates rest on Mac measurements times 3. The first production deletion is a canary, submitted alone before the other eval requests. Its step outcomes, plus Workers CPU percentiles once the token has Account Analytics Read, confirm or lower the byte caps. The caps are variables, so a change needs no code change.
- The 50-queries-per-invocation limit on the D1 limits page may apply per Workflow instance rather than per step; the docs do not say. If it does, this design fails on the canary deletion, fail-closed: the request becomes `failed`, and nothing is reported clean.
- The verifier no longer sees copies placed in datasets outside this repo's prefix in the shared project. The README states this scope.
