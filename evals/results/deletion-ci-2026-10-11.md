# Deletion eval (ci, local (Miniflare, DuckDB, pyiceberg SqlCatalog))

Command: `npm run eval:deletion:ci`. Date: 2026-10-11.

- Requests: 25 (completed_with_residuals 16, failed 5, held 4)
- Coverage (system verdicts, the 16 requests of cohorts R and D that were not held; planted-fault requests are scored under faults): 100.0% of 157 applicable pairs
  - source_exports: 100.0% of 16
  - warehouse_tables: 100.0% of 32
  - historical_snapshots: 100.0% of 32
  - identity_mappings: 100.0% of 32
  - derived_datasets: 100.0% of 25
  - application_caches: 100.0% of 20
- Deletion report (the product's own, every request, planted faults included): 93.2% of 222 applicable pairs
- Oracle coverage: 100.0%; agreement 1.0; false_clean 0; false_residue 0
- Faults: 5 of 5 planted residues of designed types detected; 0 out-of-design variants undetected by design
- Applicability agreement with ground truth: 192 of 192 pairs
- Holds: 4 held requests for 4 held subjects (4 in the cohorts), held data intact for 4
- Gate: passed {'false_clean_zero': True, 'all_faults_detected': True, 'holds_respected': True, 'held_data_intact': True, 'coverage_100': True, 'every_category_applicable': True}
