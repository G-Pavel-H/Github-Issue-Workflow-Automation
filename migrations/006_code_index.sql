-- Migration: code_index
-- Phase 6: the code index. AST-aware chunks + embeddings live here, namespaced per
-- run so retrieval is scoped and cannot leak across repos. Per-run only for the MVP
-- (no incrementality, no persistent state) — rows are dropped at the end of a run.

-- Up Migration
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE code_chunks (
  id          bigserial PRIMARY KEY,
  -- Per-repo/run scope (e.g. `acme/widgets/run-42`). Retrieval always filters on this.
  namespace   text NOT NULL,
  path        text NOT NULL,
  start_line  integer NOT NULL,
  end_line    integer NOT NULL,
  content     text NOT NULL,
  -- all-MiniLM-L6-v2 → 384 dims; query + document embeddings share this model/space.
  embedding   vector(384) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX code_chunks_namespace_idx ON code_chunks (namespace);
CREATE INDEX code_chunks_embedding_idx ON code_chunks USING hnsw (embedding vector_cosine_ops);

-- Down Migration
DROP TABLE code_chunks;
DROP EXTENSION IF EXISTS vector;
