-- Migration: artifacts
-- Phase 4: committed artifacts (spec, later plan) — the source of truth, re-read by
-- downstream phases. One row per (run, kind); upserted on regeneration.

-- Up Migration
CREATE TABLE artifacts (
  id          bigserial PRIMARY KEY,
  run_id      bigint NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  kind        text NOT NULL,
  path        text NOT NULL,
  content     text NOT NULL,
  commit_sha  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, kind)
);

-- Down Migration
DROP TABLE artifacts;
