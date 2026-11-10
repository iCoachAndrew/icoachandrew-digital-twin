-- =============================================================================
-- iCoachAndrew Digital Twin — SQLite Multi-File Physical Isolation Schema
-- Implements: Digital Twin Ring Protocol v0.3 & Developer Spec v0.2
--
-- Architecture:
--   1. FOUR PHYSICALLY SEPARATE RING DATABASES:
--        data/rings/ring0/store.sqlite  (CHECK ring = 0)
--        data/rings/ring1/store.sqlite  (CHECK ring = 1)
--        data/rings/ring2/store.sqlite  (CHECK ring = 2)
--        data/rings/ring3/store.sqlite  (CHECK ring = 3)
--      Each Ring database has its own FTS5 Full-Text Search index (passages_fts)
--      and its own ring-scoped protocol memories (ring_memories, ring_policy).
--
--   2. ONE CORE APPLICATION DATABASE:
--        data/core.sqlite
--      Stores pending ingestions, tagging precedents, Ring 1 code names (zero PII),
--      Ring 2 members & fair-use counters, works, media, commerce, AI telemetry,
--      and the immutable append-only audit_logs table.
-- =============================================================================

-- =============================================================================
-- PART A: PER-RING STORE SCHEMA (data/rings/ring{R}/store.sqlite, R in 0..3)
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS passages (
  id                TEXT PRIMARY KEY,
  ring              INTEGER NOT NULL CHECK (ring BETWEEN 0 AND 3),
  title             TEXT NOT NULL,
  text              TEXT NOT NULL,
  lang              TEXT NOT NULL DEFAULT 'id',
  source            TEXT NOT NULL DEFAULT 'upload',
  approved_at       TEXT NOT NULL,
  moved_at          TEXT,
  tag_history_json  TEXT NOT NULL DEFAULT '[]',
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- Dedicated FTS5 Full-Text Search index inside this Ring's physical database
CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
  id UNINDEXED,
  title,
  text,
  tokenize = 'unicode61'
);

-- Triggers to keep passages_fts automatically synchronized with passages
CREATE TRIGGER IF NOT EXISTS trg_passages_ai AFTER INSERT ON passages BEGIN
  INSERT INTO passages_fts(id, title, text) VALUES (new.id, new.title, new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_passages_ad AFTER DELETE ON passages BEGIN
  DELETE FROM passages_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_passages_au AFTER UPDATE ON passages BEGIN
  DELETE FROM passages_fts WHERE id = old.id;
  INSERT INTO passages_fts(id, title, text) VALUES (new.id, new.title, new.text);
END;

-- Ring-specific Protocol Memory entries stored physically inside Ring R's DB
CREATE TABLE IF NOT EXISTS ring_policy (
  ring                INTEGER PRIMARY KEY CHECK (ring BETWEEN 0 AND 3),
  label               TEXT NOT NULL,
  audience            TEXT NOT NULL,
  tone                TEXT NOT NULL,
  directives          TEXT NOT NULL,
  blocked_topics_json TEXT NOT NULL DEFAULT '[]',
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ring_memories (
  id                  TEXT PRIMARY KEY,
  ring                INTEGER NOT NULL CHECK (ring BETWEEN 0 AND 3),
  text                TEXT NOT NULL,
  tags_json           TEXT NOT NULL DEFAULT '[]',
  pinned              INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  sort_order          INTEGER NOT NULL DEFAULT 0
);

-- =============================================================================
-- PART B: CORE RELATIONAL SCHEMA (data/core.sqlite)
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_ingestions (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  text              TEXT NOT NULL,
  lang              TEXT NOT NULL DEFAULT 'en',
  intended_ring     INTEGER NOT NULL CHECK (intended_ring BETWEEN 0 AND 3),
  proposed_ring     INTEGER NOT NULL CHECK (proposed_ring BETWEEN 0 AND 3),
  flagged_json      TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'awaiting_approval',
  added_at          TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tagging_precedents (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL,
  title             TEXT NOT NULL,
  proposed_ring     INTEGER NOT NULL CHECK (proposed_ring BETWEEN 0 AND 3),
  approved_ring     INTEGER NOT NULL CHECK (approved_ring BETWEEN 0 AND 3),
  flagged_json      TEXT NOT NULL DEFAULT '[]',
  note              TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT 'admin',
  decided_at        TEXT NOT NULL
);

-- Ring 1 Register: Code names & credentials ONLY. No real identity columns exist.
CREATE TABLE IF NOT EXISTS ring1_codenames (
  code_name         TEXT PRIMARY KEY,
  ring              INTEGER NOT NULL DEFAULT 1 CHECK (ring = 1),
  passphrase_hash   TEXT NOT NULL,
  otp_code          TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  channel_json      TEXT,
  added_at          TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- Ring 2 Members & Fair-Use Allowance
CREATE TABLE IF NOT EXISTS ring2_members (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  corporate_holding TEXT NOT NULL DEFAULT '',
  credential_hash   TEXT NOT NULL,
  entitlement       TEXT NOT NULL CHECK (entitlement IN ('active', 'lapsed', 'pending_payment', 'suspended')),
  plan_id           TEXT,
  used              INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  cap               INTEGER NOT NULL DEFAULT 50 CHECK (cap >= 0),
  renews_at         TEXT,
  created_at        TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_conversations (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id         TEXT NOT NULL REFERENCES ring2_members(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  at                TEXT NOT NULL
);

-- Works Repository (Books, Essays, Modules, Hymns — Ring 0..3)
CREATE TABLE IF NOT EXISTS works (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  subtitle          TEXT NOT NULL DEFAULT '',
  type              TEXT NOT NULL DEFAULT 'buku',
  ring              INTEGER NOT NULL CHECK (ring BETWEEN 0 AND 3),
  year              INTEGER,
  summary           TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL DEFAULT '',
  cover_url         TEXT NOT NULL DEFAULT '',
  link              TEXT NOT NULL DEFAULT '',
  tags_json         TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'draft',
  featured          INTEGER NOT NULL DEFAULT 0,
  sync_knowledge    INTEGER NOT NULL DEFAULT 0,
  lang              TEXT NOT NULL DEFAULT 'id',
  sensitive_ack     TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  ring_history_json TEXT NOT NULL DEFAULT '[]'
);

-- Media Assets Library
CREATE TABLE IF NOT EXISTS media_assets (
  id                TEXT PRIMARY KEY,
  file              TEXT NOT NULL,
  url               TEXT NOT NULL,
  mime              TEXT NOT NULL,
  size              INTEGER NOT NULL,
  name              TEXT NOT NULL,
  alt               TEXT NOT NULL DEFAULT '',
  tags_json         TEXT NOT NULL DEFAULT '[]',
  width             INTEGER,
  height            INTEGER,
  uploaded_at       TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- Subscription Plans, Discount Coupons & Payment Transactions
CREATE TABLE IF NOT EXISTS subscription_plans (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  tagline           TEXT NOT NULL DEFAULT '',
  ring              INTEGER NOT NULL CHECK (ring BETWEEN 1 AND 3),
  price_monthly     INTEGER NOT NULL DEFAULT 0,
  price_yearly      INTEGER NOT NULL DEFAULT 0,
  message_cap       INTEGER NOT NULL DEFAULT 0,
  features_json     TEXT NOT NULL DEFAULT '[]',
  highlight         INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  purchasable       INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  cta_label         TEXT NOT NULL DEFAULT '',
  badge             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS discount_coupons (
  code              TEXT PRIMARY KEY,
  percent_off       INTEGER NOT NULL DEFAULT 0,
  amount_off        INTEGER NOT NULL DEFAULT 0,
  expires_at        TEXT,
  max_redemptions   INTEGER NOT NULL DEFAULT 0,
  redeemed          INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                TEXT PRIMARY KEY,
  member_id         TEXT,
  email             TEXT,
  plan_id           TEXT NOT NULL,
  plan_name         TEXT NOT NULL DEFAULT '',
  cycle             TEXT NOT NULL,
  gateway           TEXT NOT NULL,
  amount            INTEGER NOT NULL DEFAULT 0,
  base_amount       INTEGER NOT NULL DEFAULT 0,
  discount          INTEGER NOT NULL DEFAULT 0,
  tax               INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'IDR',
  coupon            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  provider_ref      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT,
  paid_at           TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- Claude AI Sealed Keys & Daily Telemetry
CREATE TABLE IF NOT EXISTS ai_api_keys (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  sealed_json       TEXT NOT NULL,
  disabled          INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT,
  last_status       TEXT,
  last_tested_at    TEXT
);

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day               TEXT PRIMARY KEY,
  calls             INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 0,
  errors            INTEGER NOT NULL DEFAULT 0,
  extractive        INTEGER NOT NULL DEFAULT 0,
  in_tok            INTEGER NOT NULL DEFAULT 0,
  out_tok           INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  by_ring_json      TEXT NOT NULL DEFAULT '{}',
  by_model_json     TEXT NOT NULL DEFAULT '{}'
);

-- Structured Studio Documents (CMS draft/published/versions, Memory core/versions, AI/Commerce settings)
CREATE TABLE IF NOT EXISTS studio_documents (
  doc_key           TEXT PRIMARY KEY,
  payload_json      TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Append-Only Privacy-Safe Audit Log
CREATE TABLE IF NOT EXISTS audit_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  event             TEXT NOT NULL,
  site              TEXT,
  ring              INTEGER,
  asker_ring        INTEGER,
  session_id        TEXT,
  topic             TEXT,
  outcome           TEXT,
  model             TEXT,
  refused           INTEGER,
  payload_json      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_ts ON audit_logs(ts);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ring ON audit_logs(ring, asker_ring);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event);

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only: UPDATE is prohibited by Digital Twin Ring Protocol');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only: DELETE is prohibited by Digital Twin Ring Protocol');
END;
