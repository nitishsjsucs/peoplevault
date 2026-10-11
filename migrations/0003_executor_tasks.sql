-- Tasks the Workflows hand to the Python executor (ADR 0001).
CREATE TABLE executor_tasks (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  run_id TEXT,
  workflow TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('erase','identity','retention')),
  event_type TEXT NOT NULL,                  -- executor_result_erase | executor_result_identity | executor_result_retention
  payload_json TEXT,                         -- identifiers; NULLed by redact-request
  status TEXT NOT NULL CHECK (status IN ('pending','leased','done','failed')),
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX executor_tasks_pending ON executor_tasks(status, phase, created_at);
