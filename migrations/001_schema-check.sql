-- Migration: schema-check
-- Proves the migration harness works. Will be replaced by real schema in Phase 1.

-- Up
CREATE TABLE IF NOT EXISTS schema_check (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down
-- DROP TABLE IF EXISTS schema_check;
