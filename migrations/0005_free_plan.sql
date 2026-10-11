-- Workers Free daily admission (SPEC.md section 30.3.4): a deletion instance starts only when its request is admitted,
-- at most DAILY_DELETION_STARTS per UTC day (16 in production, unlimited locally). admitted_at is the time of the
-- latest admission: NULL while a request is deferred, and an admitted request still in `received` after 6 hours has
-- lost its instance (Free keeps queue messages 24 hours) and is re-sent by the daily cron.
ALTER TABLE deletion_requests ADD COLUMN admitted_at TEXT;
CREATE INDEX deletion_requests_admitted ON deletion_requests(admitted_at);
