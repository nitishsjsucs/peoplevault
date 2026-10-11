# PeopleVault domain glossary

Terms used across the code, tests, docs and reports. When code and this file disagree, fix one of them in the same commit.

| Term | Meaning |
|---|---|
| Subject | One synthetic employee whose data is accessed, retained or deleted. Identified internally by `employee_id` (`E00001` to `E01200`). |
| subject_ref | Keyed HMAC pseudonym of a subject (`sr_` prefix). The only subject key kept in audit events, holds, suppression and receipts after deletion (ADR 0005). Never a verification token. |
| Pseudonym kinds | `warehouse_key` (`wk_`, warehouse join key), `employee_ref` (`er_`, identified purposes), `analytics_id` (`an_`, workforce analytics only), `subject_ref` (`sr_`). Each uses its own HKDF-derived key, so they cannot be joined without the master key. |
| Persona | One of four stakeholder roles: `hr_partner`, `manager`, `people_analyst`, `privacy_officer`. |
| Purpose | A named reason for reading data (`employee_relations`, `team_management`, `workforce_analytics`, `privacy_compliance`, `legal_hold_management`). Every read names one. Each purpose has its own column visibility, row scope and BigQuery identity. |
| Principal | A row in D1 `principals`: a human with a persona, or a system principal (the executor). Ids are opaque (`hrbp-01`, `mgr-007`, `analyst-01`, `privacy-01`, `pv-executor-local`) and never derived from employee data. |
| Asset | A registered store location that can hold subject data, with an erase method, a verification probe and a retention rule. There are exactly 13. |
| Asset part | One table or prefix inside a multi-part asset (for example the HRIS family of `src.r2.exports`). An asset is clean only when every part is clean. |
| Asset category | One of six: `source_exports`, `warehouse_tables`, `historical_snapshots`, `identity_mappings`, `derived_datasets`, `application_caches`. |
| Applicability | Per request and asset: `present` (subject rows or references at plan time), `not_present`, `aggregate_recompute` (the headcount aggregate only), `held`, or `unregistered` (residue found outside the registry). |
| Applicable pair | A (request, asset or location) pair that counts in coverage: present pairs, not-present pairs where residue was found, and unregistered residue locations. |
| Coverage | `clean_pairs / applicable_pairs`, always printed with its denominator. A category with no applicable pairs prints `n/a`, never 100%. |
| Residual | Data that deletion does not remove from active stores but that persists in a recovery mechanism: Iceberg snapshots and orphan files, BigQuery time travel and fail-safe, D1 Time Travel, KV propagation. Each has a kind, a state (`pending`, `cleared`, `modeled`, `error`) and evidence (`observed` or `modeled`). Never counted in coverage. |
| Legal hold | A hold on one subject under a matter. While active, deletion stops at the hold check and retention skips the subject. Released holds resubmit held requests. |
| Minimization | Rewriting an object past retention so it keeps only rows of held subjects, instead of deleting it. |
| Suppression | The list of `subject_ref`s whose deletion has started. Loaders skip them and the data API refuses to serve or cache them. |
| Executor | The Python process that claims D1 tasks over HTTPS, erases warehouse and Iceberg data, runs the independent scanners and resumes the Workflow with an event. |
| Probe | A verifier that scans a whole store (R2 buckets, KV namespace, D1 tables, warehouse schemas, Iceberg namespaces) for a subject's tokens. Shares no code with erasure. |
| Token matcher | Exact equality on known identifier columns, boundary-aware RE2 regex elsewhere, for each identifier token of a subject (`employee_id`, `work_email`, `full_name`, `employee_ref`, `warehouse_key`, `analytics_id`). |
| Oracle | The eval's own checker, which computes tokens from ground truth and reads every store directly (including Miniflare state files), sharing no code with the product probes. |
| Protected table | A BigQuery table with policy-tagged columns or row access policies. Created once, then changed only by `MERGE` and DML (ADR 0006). |
| Conditional rewrite | An R2 object rewrite that reads the etag, transforms the body and writes with `onlyIf.etagMatches`, retrying on conflict, so concurrent rewrites never lose each other's changes. |
| Ceiling probe | A production-only BigQuery check that bypasses the purpose views to prove policy tags, masking, row access policies and dataset IAM enforce each purpose's ceiling. Reported separately from the 100 authorization cases. |
