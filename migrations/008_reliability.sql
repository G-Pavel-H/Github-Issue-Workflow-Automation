-- Migration: reliability
-- Phase 11: backoff scheduling for job retries, and stale-run ping tracking.

-- Up Migration
ALTER TABLE jobs ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();

-- The claim query selects queued jobs that are due, plus leased-out in_progress jobs
-- whose worker died (locked_at older than the lease).
DROP INDEX IF EXISTS jobs_status_id_idx;
CREATE INDEX jobs_claim_idx ON jobs (status, available_at, id);
CREATE INDEX jobs_locked_idx ON jobs (status, locked_at);

-- When a parked run was last pinged about inactivity (kept separate from updated_at so a
-- ping doesn't reset the staleness clock).
ALTER TABLE runs ADD COLUMN stale_pinged_at timestamptz;

-- Down Migration
ALTER TABLE runs DROP COLUMN stale_pinged_at;
DROP INDEX IF EXISTS jobs_locked_idx;
DROP INDEX IF EXISTS jobs_claim_idx;
CREATE INDEX jobs_status_id_idx ON jobs (status, id);
ALTER TABLE jobs DROP COLUMN available_at;
