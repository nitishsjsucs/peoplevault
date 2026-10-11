-- Deletion requests, per-asset results, legal holds, suppression list, residuals and retention runs.
CREATE TABLE deletion_requests (
  id TEXT PRIMARY KEY,                       -- uuid, also the workflow instance id
  kind TEXT NOT NULL CHECK (kind IN ('dsr','retention')),
  subject_ref TEXT NOT NULL,
  employee_id TEXT,                          -- set to NULL by redact-request
  status TEXT NOT NULL CHECK (status IN ('received','held','running','completed','completed_with_residuals','failed')),
  requested_by TEXT NOT NULL,                -- principal id
  workflow_instance_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  summary_json TEXT                          -- counts only (the receipt)
);
-- One active request per subject: a concurrent DSR for the same subject gets 409 active_request_exists;
-- the retention sweep skips subjects that already have one (counted as already_active).
CREATE UNIQUE INDEX deletion_requests_one_active ON deletion_requests(subject_ref)
  WHERE status IN ('received','held','running');
CREATE INDEX deletion_requests_status ON deletion_requests(status, created_at);

CREATE TABLE deletion_asset_results (
  request_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  category TEXT NOT NULL,
  applicability TEXT NOT NULL CHECK (applicability IN ('present','not_present','aggregate_recompute','held','unregistered')),
  rows_before INTEGER,
  rows_erased INTEGER,
  references_scrubbed INTEGER,
  action_status TEXT NOT NULL CHECK (action_status IN ('pending','erased','recomputed','skipped_hold','failed')),
  verify_status TEXT NOT NULL CHECK (verify_status IN ('pending','clean','residue','error','not_applicable')),
  verify_matches INTEGER,
  finding_json TEXT,
  verified_at TEXT,
  PRIMARY KEY (request_id, asset_id)
);

CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  placed_by TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT
);
CREATE INDEX legal_holds_active ON legal_holds(subject_ref) WHERE released_at IS NULL;

CREATE TABLE suppression_list (
  subject_ref TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE residuals (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('iceberg_snapshots','iceberg_orphan_files','bq_time_travel','bq_fail_safe','d1_time_travel','kv_propagation')),
  state TEXT NOT NULL CHECK (state IN ('pending','cleared','modeled','error')),   -- error: the check itself failed; never read as cleared
  evidence TEXT NOT NULL CHECK (evidence IN ('observed','modeled')),
  expected_clear_at TEXT,
  cleared_at TEXT,
  detail_json TEXT
);
CREATE INDEX residuals_request ON residuals(request_id);
CREATE INDEX residuals_state ON residuals(state);

CREATE TABLE retention_runs (
  id TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary_json TEXT
);
