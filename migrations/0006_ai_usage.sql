-- Workers AI neuron meter for the schema-drift triage (SPEC.md sections 16.3 and 30.3.6). One row per UTC day and
-- model: the route reserves the worst case of a call before making it and settles the measured neurons afterwards, so
-- a day never passes AI_DAILY_NEURONS. Counts and model names only: no prompt, column name or sample value is stored.
CREATE TABLE ai_usage (
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  neurons REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model)
);
