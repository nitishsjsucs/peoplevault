-- Hash-chained audit log. Fields never hold an employee identifier token: actor is an opaque principal id,
-- subjects appear only as subject_ref, route is a template, detail_json holds counts and enums.
CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  persona TEXT,
  purpose TEXT,
  action TEXT NOT NULL,
  route TEXT,                                -- route template, never a concrete ref
  subject_ref TEXT,
  request_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny','info')),
  reason TEXT NOT NULL,
  row_count INTEGER,
  detail_json TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
