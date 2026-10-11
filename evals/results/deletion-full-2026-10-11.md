# Deletion eval (full, local (Miniflare, DuckDB, pyiceberg SqlCatalog))

Command: `npm run eval:deletion`. Date: 2026-10-11.

- Requests: 136 (completed_with_residuals 110, failed 20, held 6)
- Coverage (system verdicts, the 110 requests of cohorts R and D that were not held; planted-fault requests are scored under faults): 100.0% of 1055 applicable pairs
  - source_exports: 100.0% of 110
  - warehouse_tables: 100.0% of 220
  - historical_snapshots: 100.0% of 216
  - identity_mappings: 100.0% of 220
  - derived_datasets: 100.0% of 169
  - application_caches: 100.0% of 120
- Deletion report (the product's own, every request, planted faults included): 95.4% of 1309 applicable pairs
- Oracle coverage: 100.0%; agreement 1.0; false_clean 0; false_residue 0
- Faults: 20 of 20 planted residues of designed types detected; 3 out-of-design variants undetected by design
- Applicability agreement with ground truth: 1318 of 1320 pairs; cache.kv.team_rosters system not_present, truth present; cache.kv.team_rosters system not_present, truth present
- Holds: 6 held requests for 6 held subjects (6 in the cohorts), held data intact for 6
- Gate: passed {'false_clean_zero': True, 'all_faults_detected': True, 'holds_respected': True, 'held_data_intact': True, 'coverage_100': True, 'every_category_applicable': True}
