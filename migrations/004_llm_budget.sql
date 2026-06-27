-- Migration: llm_budget
-- Phase 3: per-run budget + per-call LLM cost/usage logging (nano-USD = 1e-9 USD).

-- Up Migration
ALTER TABLE runs
  ADD COLUMN budget_nano_usd bigint NOT NULL DEFAULT 1000000000,
  ADD COLUMN spent_nano_usd  bigint NOT NULL DEFAULT 0;

CREATE TABLE llm_calls (
  id                     bigserial PRIMARY KEY,
  run_id                 bigint NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  role                   text NOT NULL,
  model                  text NOT NULL,
  input_tokens           integer NOT NULL,
  output_tokens          integer NOT NULL,
  cache_creation_tokens  integer NOT NULL DEFAULT 0,
  cache_read_tokens      integer NOT NULL DEFAULT 0,
  cost_nano_usd          bigint NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_calls_run_id_idx ON llm_calls (run_id);

-- Down Migration
DROP TABLE llm_calls;
ALTER TABLE runs DROP COLUMN spent_nano_usd, DROP COLUMN budget_nano_usd;
