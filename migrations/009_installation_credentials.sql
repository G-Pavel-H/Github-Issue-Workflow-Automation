-- Migration: installation_credentials
-- Phase 12: per-installation Anthropic key, encrypted at rest (AES-256-GCM). One row per
-- installation, keyed by installation_id. Only the ciphertext + iv + auth tag are stored —
-- never the plaintext key. Rotation is an upsert on the primary key; uninstall deletes the row.

-- Up Migration
CREATE TABLE installation_credentials (
  installation_id           bigint PRIMARY KEY,
  anthropic_key_ciphertext  bytea NOT NULL,
  anthropic_key_iv          bytea NOT NULL,
  anthropic_key_auth_tag    bytea NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE installation_credentials;
