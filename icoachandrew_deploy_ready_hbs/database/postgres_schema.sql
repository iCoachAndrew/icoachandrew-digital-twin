-- =============================================================================
-- iCoachAndrew Digital Twin — PostgreSQL Enterprise Database Schema
-- Implements: Digital Twin Ring Protocol v0.3 & Developer Spec v0.2
-- Features:
--   1. Strict 4-Ring Isolation (Ring 0..3) via PostgreSQL Row-Level Security (RLS)
--   2. Hybrid Retrieval: pgvector (semantic embeddings) + tsvector (full-text BM25/GIN)
--   3. Zero Real Identity on Ring 1 (code names, credential hashes, and channel refs only)
--   4. Append-Only Privacy-Safe Audit Log (enforced via BEFORE UPDATE/DELETE trigger)
--   5. Indonesia PDP Law (UU No. 27 Tahun 2022) data minimization for Ring 2 members
-- =============================================================================

BEGIN;

-- Required PostgreSQL Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Helper function: reads the authenticated session's Ring level from the transaction context.
-- Fail-closed principle: if 'app.asker_ring' is not set or invalid, defaults to Ring 3 (Public).
CREATE OR REPLACE FUNCTION current_asker_ring() RETURNS SMALLINT AS $$
DECLARE
  r TEXT;
  val SMALLINT;
BEGIN
  r := current_setting('app.asker_ring', true);
  IF r IS NULL OR r = '' THEN
    RETURN 3;
  END IF;
  val := r::SMALLINT;
  IF val < 0 OR val > 3 THEN
    RETURN 3;
  END IF;
  RETURN val;
EXCEPTION WHEN OTHERS THEN
  RETURN 3; -- Fail closed to Public Ring 3
END;
$$ LANGUAGE plpgsql STABLE;

-- =============================================================================
-- 1. KNOWLEDGE STORES & PASSAGES (RING 0..3)
-- Rule: An asker in Ring R may read content tagged Ring N iff R <= N.
-- =============================================================================

CREATE TABLE IF NOT EXISTS knowledge_passages (
  id              TEXT PRIMARY KEY,
  ring            SMALLINT NOT NULL CHECK (ring BETWEEN 0 AND 3),
  title           TEXT NOT NULL,
  text            TEXT NOT NULL,
  lang            TEXT NOT NULL DEFAULT 'id' CHECK (lang IN ('id', 'en')),
  source          TEXT NOT NULL DEFAULT 'upload',
  embedding       vector(1536),
  search_tsv      tsvector GENERATED ALWAYS AS (
                    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(text, ''))
                  ) STORED,
  tag_history     JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  moved_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY LIST (ring);

-- Physically separate partitions per Ring (can be placed on distinct tablespaces)
CREATE TABLE IF NOT EXISTS knowledge_passages_ring0 PARTITION OF knowledge_passages FOR VALUES IN (0);
CREATE TABLE IF NOT EXISTS knowledge_passages_ring1 PARTITION OF knowledge_passages FOR VALUES IN (1);
CREATE TABLE IF NOT EXISTS knowledge_passages_ring2 PARTITION OF knowledge_passages FOR VALUES IN (2);
CREATE TABLE IF NOT EXISTS knowledge_passages_ring3 PARTITION OF knowledge_passages FOR VALUES IN (3);

CREATE INDEX IF NOT EXISTS idx_kp_search_tsv ON knowledge_passages USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_kp_ring_approved ON knowledge_passages (ring, approved_at DESC);

-- Enable Row-Level Security (RLS) so a query from Ring R can NEVER read Ring < R
ALTER TABLE knowledge_passages ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_passages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policy_knowledge_ring_isolation ON knowledge_passages;
CREATE POLICY policy_knowledge_ring_isolation ON knowledge_passages
  FOR SELECT
  USING (current_asker_ring() <= ring);

DROP POLICY IF EXISTS policy_knowledge_ring0_write ON knowledge_passages;
CREATE POLICY policy_knowledge_ring0_write ON knowledge_passages
  FOR ALL
  USING (current_asker_ring() = 0)
  WITH CHECK (current_asker_ring() = 0);

-- =============================================================================
-- 2. INGESTION PIPELINE & TAGGING PRECEDENTS (RING 0 ONLY)
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_ingestions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  text            TEXT NOT NULL,
  lang            TEXT NOT NULL DEFAULT 'id' CHECK (lang IN ('id', 'en')),
  intended_ring   SMALLINT NOT NULL CHECK (intended_ring BETWEEN 0 AND 3),
  proposed_ring   SMALLINT NOT NULL CHECK (proposed_ring BETWEEN 0 AND 3),
  flagged_terms   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'awaiting_approval'
                    CHECK (status IN ('awaiting_approval', 'approved', 'rejected')),
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_stricter_proposal CHECK (proposed_ring <= intended_ring)
);

CREATE TABLE IF NOT EXISTS tagging_precedents (
  seq             BIGSERIAL PRIMARY KEY,
  passage_id      TEXT NOT NULL,
  title           TEXT NOT NULL,
  proposed_ring   SMALLINT NOT NULL CHECK (proposed_ring BETWEEN 0 AND 3),
  approved_ring   SMALLINT NOT NULL CHECK (approved_ring BETWEEN 0 AND 3),
  flagged_terms   JSONB NOT NULL DEFAULT '[]'::jsonb,
  note            TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'admin',
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pending_ingestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tagging_precedents ENABLE ROW LEVEL SECURITY;

CREATE POLICY policy_pending_ring0_only ON pending_ingestions
  FOR ALL USING (current_asker_ring() = 0) WITH CHECK (current_asker_ring() = 0);

CREATE POLICY policy_precedents_ring0_only ON tagging_precedents
  FOR ALL USING (current_asker_ring() = 0) WITH CHECK (current_asker_ring() = 0);

-- =============================================================================
-- 3. IDENTITY & ACCESS (RINGS 1 & 2)
-- Protocol Rule: Ring 1 stores Code Name, credential hashes, and channel status ONLY.
-- Real names, emails, or phone numbers are NEVER stored for Ring 1 executors.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ring1_codenames (
  code_name         TEXT PRIMARY KEY,
  ring              SMALLINT NOT NULL DEFAULT 1 CHECK (ring = 1),
  passphrase_hash   TEXT NOT NULL,
  otp_code          TEXT NOT NULL,
  passkey_cred_id   TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  channel           JSONB, -- { provider: 'signal'|'whatsapp'|'telegram'|'airterm', linkedAt, ref, label }
  added_at          TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ring2_members (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  corporate_holding TEXT NOT NULL DEFAULT '',
  credential_hash   TEXT NOT NULL,
  entitlement       TEXT NOT NULL DEFAULT 'active'
                      CHECK (entitlement IN ('active', 'lapsed', 'pending_payment', 'suspended')),
  plan_id           TEXT,
  used_messages     INTEGER NOT NULL DEFAULT 0 CHECK (used_messages >= 0),
  message_cap       INTEGER NOT NULL DEFAULT 50 CHECK (message_cap >= 0),
  renews_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ring2_members_email ON ring2_members (LOWER(email));

CREATE TABLE IF NOT EXISTS member_conversations (
  seq               BIGSERIAL PRIMARY KEY,
  member_id         TEXT NOT NULL REFERENCES ring2_members(id) ON DELETE CASCADE,
  ring              SMALLINT NOT NULL DEFAULT 2 CHECK (ring = 2),
  title             TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_member_conv_member ON member_conversations (member_id, created_at DESC);

-- =============================================================================
-- 4. PROTOCOL MEMORY (CORE IDENTITY + RING 0..3 DIRECTIVES & MEMORIES)
-- =============================================================================

CREATE TABLE IF NOT EXISTS protocol_memory_core (
  id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  identity          TEXT NOT NULL,
  voice             TEXT NOT NULL,
  language_style    TEXT NOT NULL DEFAULT '',
  values_json       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS protocol_memory_rings (
  ring              SMALLINT PRIMARY KEY CHECK (ring BETWEEN 0 AND 3),
  label             TEXT NOT NULL,
  audience          TEXT NOT NULL,
  tone              TEXT NOT NULL,
  directives        TEXT NOT NULL,
  blocked_topics    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS protocol_memory_entries (
  id                TEXT PRIMARY KEY,
  ring              SMALLINT NOT NULL CHECK (ring BETWEEN 0 AND 3) REFERENCES protocol_memory_rings(ring),
  text              TEXT NOT NULL,
  tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
  pinned            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE protocol_memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE protocol_memory_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY policy_memory_entries_ring_isolation ON protocol_memory_entries
  FOR SELECT USING (current_asker_ring() <= ring);

CREATE POLICY policy_memory_entries_ring0_write ON protocol_memory_entries
  FOR ALL USING (current_asker_ring() = 0) WITH CHECK (current_asker_ring() = 0);

CREATE TABLE IF NOT EXISTS protocol_memory_versions (
  id                TEXT PRIMARY KEY,
  note              TEXT NOT NULL,
  snapshot_json     JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 5. WORKS REPOSITORY (BOOKS, ESSAYS, MODULES, HYMNS — RING 0..3)
-- =============================================================================

CREATE TABLE IF NOT EXISTS works_repository (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  subtitle          TEXT NOT NULL DEFAULT '',
  type              TEXT NOT NULL DEFAULT 'buku',
  ring              SMALLINT NOT NULL CHECK (ring BETWEEN 0 AND 3),
  year              INTEGER,
  summary           TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL DEFAULT '',
  cover_url         TEXT NOT NULL DEFAULT '',
  link              TEXT NOT NULL DEFAULT '',
  tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  featured          BOOLEAN NOT NULL DEFAULT FALSE,
  sync_knowledge    BOOLEAN NOT NULL DEFAULT FALSE,
  lang              TEXT NOT NULL DEFAULT 'id' CHECK (lang IN ('id', 'en')),
  sensitive_ack     TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  ring_history      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE works_repository ENABLE ROW LEVEL SECURITY;
ALTER TABLE works_repository FORCE ROW LEVEL SECURITY;

CREATE POLICY policy_works_ring_isolation ON works_repository
  FOR SELECT USING (
    current_asker_ring() = 0
    OR (status = 'published' AND current_asker_ring() <= ring)
  );

CREATE POLICY policy_works_ring0_write ON works_repository
  FOR ALL USING (current_asker_ring() = 0) WITH CHECK (current_asker_ring() = 0);

-- =============================================================================
-- 6. VISUAL WEBSITE CMS & MEDIA LIBRARY
-- =============================================================================

CREATE TABLE IF NOT EXISTS cms_site_state (
  id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  draft_json        JSONB NOT NULL,
  published_json    JSONB NOT NULL,
  published_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cms_site_versions (
  id                TEXT PRIMARY KEY,
  note              TEXT NOT NULL,
  snapshot_json     JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media_assets (
  id                TEXT PRIMARY KEY,
  file_name         TEXT NOT NULL UNIQUE,
  url               TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  byte_size         INTEGER NOT NULL CHECK (byte_size > 0),
  display_name      TEXT NOT NULL,
  alt_text          TEXT NOT NULL DEFAULT '',
  tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
  width             INTEGER,
  height            INTEGER,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 7. COMMERCE, SUBSCRIPTION PLANS, COUPONS & TRANSACTIONS
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscription_plans (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  tagline           TEXT NOT NULL DEFAULT '',
  ring              SMALLINT NOT NULL CHECK (ring BETWEEN 1 AND 3),
  price_monthly     BIGINT NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  price_yearly      BIGINT NOT NULL DEFAULT 0 CHECK (price_yearly >= 0),
  message_cap       INTEGER NOT NULL DEFAULT 0 CHECK (message_cap >= 0),
  features          JSONB NOT NULL DEFAULT '[]'::jsonb,
  highlight         BOOLEAN NOT NULL DEFAULT FALSE,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  purchasable       BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  cta_label         TEXT NOT NULL DEFAULT 'Pilih Paket',
  badge             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS discount_coupons (
  code              TEXT PRIMARY KEY,
  percent_off       INTEGER NOT NULL DEFAULT 0 CHECK (percent_off BETWEEN 0 AND 100),
  amount_off        BIGINT NOT NULL DEFAULT 0 CHECK (amount_off >= 0),
  expires_at        TIMESTAMPTZ,
  max_redemptions   INTEGER NOT NULL DEFAULT 0,
  redeemed          INTEGER NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                TEXT PRIMARY KEY, -- e.g. ICA-20261110-XXXXXX
  member_id         TEXT REFERENCES ring2_members(id) ON DELETE SET NULL,
  email             TEXT,
  plan_id           TEXT NOT NULL,
  plan_name         TEXT NOT NULL DEFAULT '',
  cycle             TEXT NOT NULL CHECK (cycle IN ('monthly', 'yearly')),
  gateway           TEXT NOT NULL CHECK (gateway IN ('midtrans', 'xendit', 'stripe', 'manual')),
  amount            BIGINT NOT NULL CHECK (amount >= 0),
  base_amount       BIGINT NOT NULL DEFAULT 0,
  discount          BIGINT NOT NULL DEFAULT 0,
  tax               BIGINT NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'IDR',
  coupon_code       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded')),
  provider_ref      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_tx_member ON payment_transactions (member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_tx_status ON payment_transactions (status, created_at DESC);

-- =============================================================================
-- 8. CLAUDE AI VAULT & TOKEN TELEMETRY (NO QUESTION OR ANSWER TEXT STORED)
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_api_keys (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  sealed_secret     JSONB NOT NULL, -- AES-256-GCM { v, iv, tag, data, hint }
  disabled          BOOLEAN NOT NULL DEFAULT FALSE,
  priority_order    INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at      TIMESTAMPTZ,
  last_status       TEXT,
  last_tested_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day               DATE PRIMARY KEY,
  calls             INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 0,
  errors            INTEGER NOT NULL DEFAULT 0,
  extractive        INTEGER NOT NULL DEFAULT 0,
  in_tok            BIGINT NOT NULL DEFAULT 0,
  out_tok           BIGINT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(12, 6) NOT NULL DEFAULT 0,
  latency_ms        BIGINT NOT NULL DEFAULT 0,
  by_ring           JSONB NOT NULL DEFAULT '{}'::jsonb,
  by_model          JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- =============================================================================
-- 9. APPEND-ONLY PRIVACY-SAFE AUDIT LOG
-- Rule: Never stores raw user questions or answers. Immutable (no UPDATE/DELETE).
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event             TEXT NOT NULL,
  site              TEXT,
  ring              SMALLINT CHECK (ring IS NULL OR ring BETWEEN 0 AND 3),
  asker_ring        SMALLINT CHECK (asker_ring IS NULL OR asker_ring BETWEEN 0 AND 3),
  session_id        TEXT,
  topic             TEXT,
  outcome           TEXT,
  model             TEXT,
  refused           BOOLEAN,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_ts ON audit_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ring_event ON audit_logs (COALESCE(ring, asker_ring), event, ts DESC);

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is strictly append-only under the Digital Twin Ring Protocol v0.3';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

COMMIT;
