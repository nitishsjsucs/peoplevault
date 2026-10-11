-- Principals (opaque ids, never derived from employee data) and the identity map.
CREATE TABLE principals (
  id TEXT PRIMARY KEY,                       -- hrbp-01, mgr-007, analyst-01, privacy-01, pv-executor-local
  kind TEXT NOT NULL CHECK (kind IN ('human','system')),
  persona TEXT CHECK (persona IN ('hr_partner','manager','people_analyst','privacy_officer')),
  system_role TEXT CHECK (system_role IN ('executor')),
  email TEXT UNIQUE,                         -- human principals (Access email claim)
  service_client_id TEXT UNIQUE,             -- system or service-token principals (Access common_name)
  employee_id TEXT,                          -- link to identity_map for humans
  org_units TEXT NOT NULL DEFAULT '[]',      -- JSON array, hr_partner only
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'human' AND persona IS NOT NULL AND system_role IS NULL)
      OR (kind = 'system' AND system_role IS NOT NULL AND persona IS NULL)),
  CHECK (email IS NOT NULL OR service_client_id IS NOT NULL)
  -- production persona service-token principals are kind 'human' with persona set, email NULL, service_client_id set
);

CREATE TABLE identity_map (
  employee_id TEXT PRIMARY KEY,
  work_email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  employee_ref TEXT NOT NULL UNIQUE,
  warehouse_key TEXT NOT NULL UNIQUE,
  analytics_id TEXT NOT NULL UNIQUE,
  subject_ref TEXT NOT NULL UNIQUE,
  manager_employee_id TEXT,
  employment_status TEXT NOT NULL,
  termination_date TEXT
);
CREATE INDEX identity_map_manager ON identity_map(manager_employee_id);
