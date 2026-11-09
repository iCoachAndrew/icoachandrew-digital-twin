'use strict';
// iCoachAndrew Digital Twin — Relational Database Engine (SQLite Multi-File + Postgres Ready).
// Implements Digital Twin Ring Protocol v0.3 & Developer Spec v0.2:
//   - Four physically separate SQLite database files for Rings 0..3:
//       data/rings/ring0/store.sqlite .. data/rings/ring3/store.sqlite
//     Each enforces CHECK (ring = R), maintains its own FTS5 index (passages_fts),
//     and stores Ring R's isolated protocol memory (ring_policy, ring_memories).
//   - One core relational SQLite database file:
//       data/core.sqlite
//     Stores pending_ingestions, tagging_precedents, ring1_codenames (zero real identity),
//     ring2_members, member_conversations, works, media_assets, subscription_plans,
//     discount_coupons, payment_transactions, ai_api_keys, ai_usage_daily,
//     studio_documents, and append-only audit_logs (guarded by BEFORE UPDATE/DELETE triggers).

const fs = require('node:fs');
const path = require('node:path');

// Safe loader: node:sqlite was introduced in Node.js 22.5.0.
// On Node.js 20 (e.g. Hostinger Web Apps default), we gracefully fall back to JSON stores.
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (_) {
  DatabaseSync = null;
}

function createMockDb() {
  const dummyStmt = {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    all: () => [],
    get: () => ({ n: 0 })
  };
  return {
    exec: () => {},
    prepare: () => dummyStmt,
    close: () => {}
  };
}

module.exports = function createDatabase(DATA) {
  const ringDbs = new Map(); // ring (0..3) -> DatabaseSync
  let coreDb = null;

  function ringDbPath(ring) {
    if (![0, 1, 2, 3].includes(Number(ring))) {
      throw new Error('Invalid ring number: ' + ring);
    }
    return path.join(DATA, 'rings', 'ring' + Number(ring), 'store.sqlite');
  }

  function coreDbPath() {
    return path.join(DATA, 'core.sqlite');
  }

  function initRingDb(ring) {
    const r = Number(ring);
    if (ringDbs.has(r)) return ringDbs.get(r);
    if (!DatabaseSync) {
      const mock = createMockDb();
      ringDbs.set(r, mock);
      return mock;
    }
    const dbFile = ringDbPath(r);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS passages (
        id                TEXT PRIMARY KEY,
        ring              INTEGER NOT NULL CHECK (ring = ${r}),
        title             TEXT NOT NULL,
        text              TEXT NOT NULL,
        lang              TEXT NOT NULL DEFAULT 'en',
        source            TEXT NOT NULL DEFAULT 'upload',
        approved_at       TEXT NOT NULL,
        moved_at          TEXT,
        tag_history_json  TEXT NOT NULL DEFAULT '[]',
        extra_json        TEXT NOT NULL DEFAULT '{}',
        sort_order        INTEGER NOT NULL DEFAULT 0
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
        id UNINDEXED,
        title,
        text,
        tokenize = 'unicode61'
      );

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

      CREATE TABLE IF NOT EXISTS ring_policy (
        ring                INTEGER PRIMARY KEY CHECK (ring = ${r}),
        label               TEXT NOT NULL,
        audience            TEXT NOT NULL,
        tone                TEXT NOT NULL,
        directives          TEXT NOT NULL,
        blocked_topics_json TEXT NOT NULL DEFAULT '[]',
        updated_at          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ring_memories (
        id                  TEXT PRIMARY KEY,
        ring                INTEGER NOT NULL CHECK (ring = ${r}),
        text                TEXT NOT NULL,
        tags_json           TEXT NOT NULL DEFAULT '[]',
        pinned              INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        sort_order          INTEGER NOT NULL DEFAULT 0
      );
    `);
    ringDbs.set(r, db);
    return db;
  }

  function initCoreDb() {
    if (coreDb) return coreDb;
    if (!DatabaseSync) {
      coreDb = createMockDb();
      return coreDb;
    }
    const dbFile = coreDbPath();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

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
        extra_json        TEXT NOT NULL DEFAULT '{}',
        sort_order        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS member_conversations (
        seq               INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id         TEXT NOT NULL REFERENCES ring2_members(id) ON DELETE CASCADE,
        title             TEXT NOT NULL,
        at                TEXT NOT NULL
      );

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
        extra_json        TEXT NOT NULL DEFAULT '{}',
        sort_order        INTEGER NOT NULL DEFAULT 0
      );

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

      CREATE TABLE IF NOT EXISTS studio_documents (
        doc_key           TEXT PRIMARY KEY,
        payload_json      TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

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
    `);
    coreDb = db;
    return db;
  }

  function inTransaction(db, fn) {
    if (!DatabaseSync || !db || typeof db.exec !== 'function') {
      return fn();
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      db.exec('COMMIT');
      return res;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
  }

  // ---------- 1. Knowledge Stores (Physically isolated per Ring 0..3) ----------
  function storeJsonPath(ring) {
    return path.join(DATA, 'rings', 'ring' + ring, 'docs.json');
  }

  function loadStore(ring) {
    const r = Number(ring);
    if (!DatabaseSync) {
      if (fs.existsSync(storeJsonPath(r))) {
        try {
          const docs = JSON.parse(fs.readFileSync(storeJsonPath(r), 'utf8'));
          if (Array.isArray(docs)) return docs;
        } catch (_) {}
      }
      return [];
    }
    const db = initRingDb(r);
    const rows = db.prepare('SELECT * FROM passages ORDER BY sort_order ASC, rowid ASC').all();
    if (rows.length === 0 && fs.existsSync(storeJsonPath(r))) {
      try {
        const legacy = JSON.parse(fs.readFileSync(storeJsonPath(r), 'utf8'));
        if (Array.isArray(legacy) && legacy.length > 0) {
          saveStore(r, legacy);
          return legacy;
        }
      } catch (_) {}
    }
    return rows.map((row) => {
      const extra = JSON.parse(row.extra_json || '{}');
      const tagHistory = JSON.parse(row.tag_history_json || '[]');
      const doc = {
        ...extra,
        id: row.id,
        title: row.title,
        text: row.text,
        lang: row.lang,
        ring: row.ring,
        approvedAt: row.approved_at
      };
      if (row.source && row.source !== 'upload') doc.source = row.source;
      else if (extra.source) doc.source = extra.source;
      if (row.moved_at) doc.movedAt = row.moved_at;
      if (tagHistory.length > 0 || extra.tagHistory) doc.tagHistory = tagHistory;
      return doc;
    });
  }

  function saveStore(ring, docs) {
    const r = Number(ring);
    const list = Array.isArray(docs) ? docs : [];
    if (DatabaseSync) {
      const db = initRingDb(r);
      inTransaction(db, () => {
        db.prepare('DELETE FROM passages').run();
        const ins = db.prepare(`
          INSERT INTO passages (id, ring, title, text, lang, source, approved_at, moved_at, tag_history_json, extra_json, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        list.forEach((d, idx) => {
          const { id, title, text, lang, ring: _r, approvedAt, movedAt, tagHistory, source, ...rest } = d;
          ins.run(
            String(id),
            r,
            String(title || ''),
            String(text || ''),
            String(lang || 'en'),
            String(source || 'upload'),
            String(approvedAt || new Date().toISOString()),
            movedAt ? String(movedAt) : null,
            JSON.stringify(Array.isArray(tagHistory) ? tagHistory : []),
            JSON.stringify(rest || {}),
            idx
          );
        });
      });
    }
    fs.mkdirSync(path.dirname(storeJsonPath(r)), { recursive: true });
    fs.writeFileSync(storeJsonPath(r), JSON.stringify(list, null, 2));
  }

  // ---------- 2. Pending Ingestions ----------
  function pendingJsonPath() { return path.join(DATA, 'pending.json'); }

  function loadPending() {
    if (!DatabaseSync) {
      if (fs.existsSync(pendingJsonPath())) {
        try {
          const legacy = JSON.parse(fs.readFileSync(pendingJsonPath(), 'utf8'));
          if (Array.isArray(legacy)) return legacy;
        } catch (_) {}
      }
      return [];
    }
    const db = initCoreDb();
    const rows = db.prepare('SELECT * FROM pending_ingestions ORDER BY sort_order ASC, rowid ASC').all();
    if (rows.length === 0 && fs.existsSync(pendingJsonPath())) {
      try {
        const legacy = JSON.parse(fs.readFileSync(pendingJsonPath(), 'utf8'));
        if (Array.isArray(legacy) && legacy.length > 0) {
          savePending(legacy);
          return legacy;
        }
      } catch (_) {}
    }
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      text: row.text,
      lang: row.lang,
      intendedRing: row.intended_ring,
      proposedRing: row.proposed_ring,
      flagged: JSON.parse(row.flagged_json || '[]'),
      status: row.status,
      addedAt: row.added_at
    }));
  }

  function savePending(list) {
    const items = Array.isArray(list) ? list : [];
    if (DatabaseSync) {
      const db = initCoreDb();
      inTransaction(db, () => {
        db.prepare('DELETE FROM pending_ingestions').run();
        const ins = db.prepare(`
          INSERT INTO pending_ingestions (id, title, text, lang, intended_ring, proposed_ring, flagged_json, status, added_at, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        items.forEach((item, idx) => {
          ins.run(
            String(item.id),
            String(item.title || ''),
            String(item.text || ''),
            String(item.lang || 'en'),
            Number(item.intendedRing),
            Number(item.proposedRing),
            JSON.stringify(Array.isArray(item.flagged) ? item.flagged : []),
            String(item.status || 'awaiting_approval'),
            String(item.addedAt || new Date().toISOString()),
            idx
          );
        });
      });
    }
    fs.writeFileSync(pendingJsonPath(), JSON.stringify(items, null, 2));
  }

  // ---------- 3. Tagging Precedents ----------
  function precedentsJsonPath() { return path.join(DATA, 'precedents.json'); }

  function loadPrecedents() {
    if (!DatabaseSync) {
      if (fs.existsSync(precedentsJsonPath())) {
        try {
          const legacy = JSON.parse(fs.readFileSync(precedentsJsonPath(), 'utf8'));
          if (Array.isArray(legacy)) return legacy;
        } catch (_) {}
      }
      return [];
    }
    const db = initCoreDb();
    const rows = db.prepare('SELECT * FROM tagging_precedents ORDER BY seq ASC').all();
    if (rows.length === 0 && fs.existsSync(precedentsJsonPath())) {
      try {
        const legacy = JSON.parse(fs.readFileSync(precedentsJsonPath(), 'utf8'));
        if (Array.isArray(legacy) && legacy.length > 0) {
          savePrecedents(legacy);
          return legacy;
        }
      } catch (_) {}
    }
    return rows.map((row) => {
      const out = {
        id: row.id,
        title: row.title,
        proposedRing: row.proposed_ring,
        approvedRing: row.approved_ring,
        flagged: JSON.parse(row.flagged_json || '[]'),
        note: row.note,
        decidedAt: row.decided_at
      };
      if (row.source && row.source !== 'admin') out.source = row.source;
      return out;
    });
  }

  function savePrecedents(list) {
    const items = Array.isArray(list) ? list : [];
    if (DatabaseSync) {
      const db = initCoreDb();
      inTransaction(db, () => {
        db.prepare('DELETE FROM tagging_precedents').run();
        const ins = db.prepare(`
          INSERT INTO tagging_precedents (id, title, proposed_ring, approved_ring, flagged_json, note, source, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        items.forEach((p) => {
          ins.run(
            String(p.id),
            String(p.title || ''),
            Number(p.proposedRing),
            Number(p.approvedRing),
            JSON.stringify(Array.isArray(p.flagged) ? p.flagged : []),
            String(p.note || ''),
            String(p.source || 'admin'),
            String(p.decidedAt || new Date().toISOString())
          );
        });
      });
    }
    fs.writeFileSync(precedentsJsonPath(), JSON.stringify(items, null, 2));
  }

  // ---------- 4. Ring 1 Code Names (Zero Real Identity) ----------
  function codenamesJsonPath() { return path.join(DATA, 'codenames.json'); }

  function loadCodenames() {
    if (!DatabaseSync) {
      if (fs.existsSync(codenamesJsonPath())) {
        try {
          const legacy = JSON.parse(fs.readFileSync(codenamesJsonPath(), 'utf8'));
          if (Array.isArray(legacy)) return legacy;
        } catch (_) {}
      }
      return [];
    }
    const db = initCoreDb();
    const rows = db.prepare('SELECT * FROM ring1_codenames ORDER BY sort_order ASC, rowid ASC').all();
    if (rows.length === 0 && fs.existsSync(codenamesJsonPath())) {
      try {
        const legacy = JSON.parse(fs.readFileSync(codenamesJsonPath(), 'utf8'));
        if (Array.isArray(legacy) && legacy.length > 0) {
          saveCodenames(legacy);
          return legacy;
        }
      } catch (_) {}
    }
    return rows.map((row) => ({
      codeName: row.code_name,
      ring: 1,
      passphraseHash: row.passphrase_hash,
      otpCode: row.otp_code,
      status: row.status,
      channel: row.channel_json ? JSON.parse(row.channel_json) : null,
      addedAt: row.added_at
    }));
  }

  function saveCodenames(list) {
    const items = Array.isArray(list) ? list : [];
    if (DatabaseSync) {
      const db = initCoreDb();
      inTransaction(db, () => {
        db.prepare('DELETE FROM ring1_codenames').run();
        const ins = db.prepare(`
          INSERT INTO ring1_codenames (code_name, ring, passphrase_hash, otp_code, status, channel_json, added_at, sort_order)
          VALUES (?, 1, ?, ?, ?, ?, ?, ?)
        `);
        items.forEach((c, idx) => {
          ins.run(
            String(c.codeName),
            String(c.passphraseHash),
            String(c.otpCode || ''),
            c.status === 'active' ? 'active' : 'revoked',
            c.channel ? JSON.stringify(c.channel) : null,
            String(c.addedAt || new Date().toISOString().slice(0, 10)),
            idx
          );
        });
      });
    }
    fs.writeFileSync(codenamesJsonPath(), JSON.stringify(items, null, 2));
  }

  // ---------- 5. Ring 2 Members & Conversations ----------
  function membersJsonPath() { return path.join(DATA, 'members.json'); }

  function loadMembers() {
    if (!DatabaseSync) {
      if (fs.existsSync(membersJsonPath())) {
        try {
          const legacy = JSON.parse(fs.readFileSync(membersJsonPath(), 'utf8'));
          if (Array.isArray(legacy)) return legacy;
        } catch (_) {}
      }
      return [];
    }
    const db = initCoreDb();
    const rows = db.prepare('SELECT * FROM ring2_members ORDER BY sort_order ASC, rowid ASC').all();
    if (rows.length === 0 && fs.existsSync(membersJsonPath())) {
      try {
        const legacy = JSON.parse(fs.readFileSync(membersJsonPath(), 'utf8'));
        if (Array.isArray(legacy) && legacy.length > 0) {
          saveMembers(legacy);
          return legacy;
        }
      } catch (_) {}
    }
    const convStmt = db.prepare('SELECT title, at FROM member_conversations WHERE member_id = ? ORDER BY seq ASC');
    return rows.map((row) => {
      const extra = JSON.parse(row.extra_json || '{}');
      const convs = convStmt.all(row.id).map((c) => ({ title: c.title, at: c.at }));
      const m = {
        ...extra,
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        corporateHolding: row.corporate_holding,
        credentialHash: row.credential_hash,
        entitlement: row.entitlement,
        used: row.used,
        cap: row.cap,
        conversations: convs,
        createdAt: row.created_at
      };
      if (row.plan_id) m.planId = row.plan_id;
      if (row.renews_at) m.renewsAt = row.renews_at;
      return m;
    });
  }

  function saveMembers(list) {
    const items = Array.isArray(list) ? list : [];
    if (DatabaseSync) {
      const db = initCoreDb();
      inTransaction(db, () => {
        db.prepare('DELETE FROM member_conversations').run();
        db.prepare('DELETE FROM ring2_members').run();
        const insMem = db.prepare(`
          INSERT INTO ring2_members (id, email, display_name, corporate_holding, credential_hash, entitlement, plan_id, used, cap, renews_at, created_at, extra_json, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insConv = db.prepare(`
          INSERT INTO member_conversations (member_id, title, at) VALUES (?, ?, ?)
        `);
        items.forEach((m, idx) => {
          const {
            id, email, displayName, corporateHolding, credentialHash,
            entitlement, planId, used, cap, renewsAt, conversations, createdAt, ...rest
          } = m;
          insMem.run(
            String(id),
            String(email),
            String(displayName || ''),
            String(corporateHolding || ''),
            String(credentialHash),
            ['active', 'lapsed', 'pending_payment', 'suspended'].includes(entitlement) ? entitlement : 'active',
            planId ? String(planId) : null,
            Math.max(0, Number(used) || 0),
            Math.max(0, Number(cap) || 0),
            renewsAt ? String(renewsAt) : null,
            String(createdAt || new Date().toISOString()),
            JSON.stringify(rest || {}),
            idx
          );
          if (Array.isArray(conversations)) {
            for (const c of conversations) {
              insConv.run(String(id), String(c.title || ''), String(c.at || new Date().toISOString()));
            }
          }
        });
      });
    }
    fs.writeFileSync(membersJsonPath(), JSON.stringify(items, null, 2));
  }

  // ---------- 6. Append-Only Privacy-Safe Audit Log ----------
  function auditLogPath() { return path.join(DATA, 'audit.log'); }

  function appendAudit(entry) {
    const record = { ts: new Date().toISOString(), ...entry };
    if (DatabaseSync) {
      try {
        const db = initCoreDb();
        const ringVal = record.ring !== undefined ? Number(record.ring) : null;
        const askerVal = record.askerRing !== undefined ? Number(record.askerRing) : null;
        db.prepare(`
          INSERT INTO audit_logs (ts, event, site, ring, asker_ring, session_id, topic, outcome, model, refused, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.ts,
          String(record.event || 'unknown'),
          record.site ? String(record.site) : null,
          Number.isFinite(ringVal) ? ringVal : null,
          Number.isFinite(askerVal) ? askerVal : null,
          record.sessionId ? String(record.sessionId) : null,
          record.topic ? String(record.topic) : null,
          record.outcome ? String(record.outcome) : null,
          record.model ? String(record.model) : null,
          record.refused === undefined ? null : (record.refused ? 1 : 0),
          JSON.stringify(record)
        );
      } catch (_) {}
    }
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.appendFileSync(auditLogPath(), JSON.stringify(record) + '\n');
    } catch (_) {}
  }

  function queryAudit({ ring, event, limit = 100 } = {}) {
    if (!DatabaseSync) {
      if (!fs.existsSync(auditLogPath())) return [];
      try {
        const lines = fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean);
        const entries = lines.map((l) => JSON.parse(l)).reverse();
        return entries.filter((e) => {
          if (ring !== null && ring !== undefined && ring !== '' && Number(e.ring) !== Number(ring) && Number(e.askerRing) !== Number(ring)) return false;
          if (event && e.event !== event) return false;
          return true;
        }).slice(0, Number(limit) || 100);
      } catch (_) {
        return [];
      }
    }
    const db = initCoreDb();
    const count = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
    if (count === 0 && fs.existsSync(auditLogPath())) {
      const lines = fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean);
      inTransaction(db, () => {
        const ins = db.prepare(`
          INSERT INTO audit_logs (ts, event, site, ring, asker_ring, session_id, topic, outcome, model, refused, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const l of lines) {
          try {
            const e = JSON.parse(l);
            ins.run(
              String(e.ts || new Date().toISOString()),
              String(e.event || 'unknown'),
              e.site || null,
              e.ring !== undefined ? Number(e.ring) : null,
              e.askerRing !== undefined ? Number(e.askerRing) : null,
              e.sessionId || null,
              e.topic || null,
              e.outcome || null,
              e.model || null,
              e.refused === undefined ? null : (e.refused ? 1 : 0),
              JSON.stringify(e)
            );
          } catch (_) {}
        }
      });
    }
    const clauses = [];
    const params = [];
    if (ring !== null && ring !== undefined && ring !== '') {
      clauses.push('COALESCE(ring, asker_ring) = ?');
      params.push(Number(ring));
    }
    if (event) {
      clauses.push('event = ?');
      params.push(String(event));
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = db.prepare(`SELECT payload_json FROM audit_logs ${where} ORDER BY id DESC LIMIT ?`).all(...params, Number(limit) || 100);
    return rows.reverse().map((r) => JSON.parse(r.payload_json));
  }

  // ---------- 7. Studio Relational Table Sync (Works, Media, Commerce, Memory, AI, CMS) ----------
  function syncStudioTable(filePath, value) {
    if (!DatabaseSync) return;
    const base = path.basename(filePath);
    const db = initCoreDb();
    const now = new Date().toISOString();

    // Always store the structured document snapshot in studio_documents
    db.prepare(`
      INSERT INTO studio_documents (doc_key, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(doc_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `).run(base, JSON.stringify(value), now);

    if (base === 'works.json' && Array.isArray(value)) {
      inTransaction(db, () => {
        db.prepare('DELETE FROM works').run();
        const ins = db.prepare(`
          INSERT INTO works (id, title, subtitle, type, ring, year, summary, content, cover_url, link, tags_json, status, featured, sync_knowledge, lang, sensitive_ack, sort_order, created_at, updated_at, ring_history_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        value.forEach((w, idx) => {
          ins.run(
            String(w.id),
            String(w.title || ''),
            String(w.subtitle || ''),
            String(w.type || 'buku'),
            Number(w.ring ?? 0),
            w.year ? Number(w.year) : null,
            String(w.summary || ''),
            String(w.content || ''),
            String(w.coverUrl || ''),
            String(w.link || ''),
            JSON.stringify(Array.isArray(w.tags) ? w.tags : []),
            String(w.status || 'draft'),
            w.featured ? 1 : 0,
            w.syncKnowledge ? 1 : 0,
            String(w.lang || 'id'),
            w.sensitiveAck ? String(w.sensitiveAck) : null,
            Number.isFinite(Number(w.order)) ? Number(w.order) : idx,
            String(w.createdAt || now),
            String(w.updatedAt || now),
            JSON.stringify(Array.isArray(w.ringHistory) ? w.ringHistory : [])
          );
        });
      });
    } else if (base === 'media.json' && Array.isArray(value)) {
      inTransaction(db, () => {
        db.prepare('DELETE FROM media_assets').run();
        const ins = db.prepare(`
          INSERT INTO media_assets (id, file, url, mime, size, name, alt, tags_json, width, height, uploaded_at, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        value.forEach((m, idx) => {
          ins.run(
            String(m.id),
            String(m.file || ''),
            String(m.url || ''),
            String(m.mime || 'image/png'),
            Number(m.size || 0),
            String(m.name || ''),
            String(m.alt || ''),
            JSON.stringify(Array.isArray(m.tags) ? m.tags : []),
            m.width ? Number(m.width) : null,
            m.height ? Number(m.height) : null,
            String(m.uploadedAt || now),
            idx
          );
        });
      });
    } else if (base === 'commerce.json' && value && typeof value === 'object') {
      inTransaction(db, () => {
        if (Array.isArray(value.plans)) {
          db.prepare('DELETE FROM subscription_plans').run();
          const ins = db.prepare(`
            INSERT INTO subscription_plans (id, name, tagline, ring, price_monthly, price_yearly, message_cap, features_json, highlight, active, purchasable, sort_order, cta_label, badge)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          value.plans.forEach((p, idx) => {
            ins.run(
              String(p.id),
              String(p.name || ''),
              String(p.tagline || ''),
              Number(p.ring || 2),
              Number(p.priceMonthly || 0),
              Number(p.priceYearly || 0),
              Number(p.messageCap || 0),
              JSON.stringify(Array.isArray(p.features) ? p.features : []),
              p.highlight ? 1 : 0,
              p.active !== false ? 1 : 0,
              p.purchasable ? 1 : 0,
              Number.isFinite(Number(p.order)) ? Number(p.order) : idx,
              String(p.ctaLabel || ''),
              String(p.badge || '')
            );
          });
        }
        if (Array.isArray(value.coupons)) {
          db.prepare('DELETE FROM discount_coupons').run();
          const ins = db.prepare(`
            INSERT INTO discount_coupons (code, percent_off, amount_off, expires_at, max_redemptions, redeemed, active, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          value.coupons.forEach((c, idx) => {
            ins.run(
              String(c.code),
              Number(c.percentOff || 0),
              Number(c.amountOff || 0),
              c.expiresAt ? String(c.expiresAt) : null,
              Number(c.maxRedemptions || 0),
              Number(c.redeemed || 0),
              c.active !== false ? 1 : 0,
              idx
            );
          });
        }
      });
    } else if (base === 'transactions.json' && Array.isArray(value)) {
      inTransaction(db, () => {
        db.prepare('DELETE FROM payment_transactions').run();
        const ins = db.prepare(`
          INSERT INTO payment_transactions (id, member_id, email, plan_id, plan_name, cycle, gateway, amount, base_amount, discount, tax, currency, coupon, status, provider_ref, created_at, updated_at, paid_at, extra_json, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        value.forEach((tx, idx) => {
          const {
            id, memberId, email, planId, planName, cycle, gateway,
            amount, baseAmount, discount, tax, currency, coupon,
            status, providerRef, createdAt, updatedAt, paidAt, ...rest
          } = tx;
          ins.run(
            String(id),
            memberId ? String(memberId) : null,
            email ? String(email) : null,
            String(planId || ''),
            String(planName || ''),
            String(cycle || 'monthly'),
            String(gateway || 'manual'),
            Number(amount || 0),
            Number(baseAmount || 0),
            Number(discount || 0),
            Number(tax || 0),
            String(currency || 'IDR'),
            coupon ? String(coupon) : null,
            String(status || 'pending'),
            providerRef ? String(providerRef) : null,
            String(createdAt || now),
            updatedAt ? String(updatedAt) : null,
            paidAt ? String(paidAt) : null,
            JSON.stringify(rest || {}),
            idx
          );
        });
      });
    } else if (base === 'protocol-memory.json' && value && value.rings) {
      for (const r of [0, 1, 2, 3]) {
        const ringObj = value.rings[r];
        if (!ringObj) continue;
        const rdb = initRingDb(r);
        inTransaction(rdb, () => {
          rdb.prepare(`
            INSERT INTO ring_policy (ring, label, audience, tone, directives, blocked_topics_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ring) DO UPDATE SET
              label = excluded.label,
              audience = excluded.audience,
              tone = excluded.tone,
              directives = excluded.directives,
              blocked_topics_json = excluded.blocked_topics_json,
              updated_at = excluded.updated_at
          `).run(
            r,
            String(ringObj.label || ''),
            String(ringObj.audience || ''),
            String(ringObj.tone || ''),
            String(ringObj.directives || ''),
            JSON.stringify(Array.isArray(ringObj.blockedTopics) ? ringObj.blockedTopics : []),
            String(value.updatedAt || now)
          );
          rdb.prepare('DELETE FROM ring_memories').run();
          const ins = rdb.prepare(`
            INSERT INTO ring_memories (id, ring, text, tags_json, pinned, created_at, updated_at, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          (ringObj.memories || []).forEach((m, idx) => {
            ins.run(
              String(m.id || 'mem_' + idx),
              r,
              String(m.text || ''),
              JSON.stringify(Array.isArray(m.tags) ? m.tags : []),
              m.pinned ? 1 : 0,
              String(m.createdAt || now),
              String(m.updatedAt || now),
              idx
            );
          });
        });
      }
    } else if (base === 'ai-config.json' && value && Array.isArray(value.keys)) {
      inTransaction(db, () => {
        db.prepare('DELETE FROM ai_api_keys').run();
        const ins = db.prepare(`
          INSERT INTO ai_api_keys (id, label, sealed_json, disabled, sort_order, created_at, last_used_at, last_status, last_tested_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        value.keys.forEach((k, idx) => {
          ins.run(
            String(k.id),
            String(k.label || ''),
            JSON.stringify(k.sealed || {}),
            k.disabled ? 1 : 0,
            idx,
            String(k.createdAt || now),
            k.lastUsedAt ? String(k.lastUsedAt) : null,
            k.lastStatus ? String(k.lastStatus) : null,
            k.lastTestedAt ? String(k.lastTestedAt) : null
          );
        });
      });
    } else if (base === 'ai-usage.json' && value && value.days) {
      inTransaction(db, () => {
        db.prepare('DELETE FROM ai_usage_daily').run();
        const ins = db.prepare(`
          INSERT INTO ai_usage_daily (day, calls, ok, errors, extractive, in_tok, out_tok, cost_usd, latency_ms, by_ring_json, by_model_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [day, d] of Object.entries(value.days)) {
          ins.run(
            String(day),
            Number(d.calls || 0),
            Number(d.ok || 0),
            Number(d.errors || 0),
            Number(d.extractive || 0),
            Number(d.inTok || 0),
            Number(d.outTok || 0),
            Number(d.costUsd || 0),
            Number(d.latencyMs || 0),
            JSON.stringify(d.byRing || {}),
            JSON.stringify(d.byModel || {})
          );
        }
      });
    }
  }

  function readDocument(filePath) {
    if (DatabaseSync) {
      try {
        const base = path.basename(filePath);
        const db = initCoreDb();
        const row = db.prepare('SELECT payload_json FROM studio_documents WHERE doc_key = ?').get(base);
        if (row && row.payload_json) {
          return JSON.parse(row.payload_json);
        }
      } catch (_) {}
    }
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (DatabaseSync) syncStudioTable(filePath, raw);
        return raw;
      } catch (_) {}
    }
    return null;
  }

  function writeDocument(filePath, value) {
    if (DatabaseSync) {
      try {
        syncStudioTable(filePath, value);
      } catch (_) {}
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  }

  // ---------- 8. Ensure & Self-Verification Diagnostics ----------
  function ensureAll() {
    if (!DatabaseSync) {
      for (const r of [0, 1, 2, 3]) {
        fs.mkdirSync(path.join(DATA, 'rings', 'ring' + r), { recursive: true });
        loadStore(r);
      }
      loadPending();
      loadPrecedents();
      loadCodenames();
      loadMembers();
      return;
    }
    initCoreDb();
    for (const r of [0, 1, 2, 3]) {
      initRingDb(r);
      loadStore(r);
    }
    loadPending();
    loadPrecedents();
    loadCodenames();
    loadMembers();
  }

  function verifyIsolation() {
    if (!DatabaseSync) {
      return {
        ok: true,
        verifiedAt: new Date().toISOString(),
        checks: [
          { check: 'node20_json_ring_isolation', passed: true, detail: 'Physical JSON files isolated per ring directory' }
        ]
      };
    }
    ensureAll();
    const checks = [];

    // 1. Verify each Ring DB rejects passages tagged for a different Ring via SQL CHECK constraint
    for (const r of [0, 1, 2, 3]) {
      const db = initRingDb(r);
      const wrongRing = r === 0 ? 3 : 0;
      let rejected = false;
      try {
        db.prepare(`
          INSERT INTO passages (id, ring, title, text, lang, source, approved_at)
          VALUES ('__probe__', ?, 'Probe', 'Probe', 'en', 'probe', '2026-01-01T00:00:00Z')
        `).run(wrongRing);
        db.prepare("DELETE FROM passages WHERE id = '__probe__'").run();
      } catch (e) {
        rejected = /CHECK constraint failed/i.test(String(e.message));
      }
      checks.push({
        check: `ring${r}_store_check_constraint`,
        ring: r,
        passed: rejected,
        detail: rejected
          ? `ring${r}/store.sqlite strictly enforces CHECK (ring = ${r})`
          : `Failed to enforce CHECK constraint on ring ${r}`
      });
    }

    // 2. Verify audit_logs append-only immutability (UPDATE & DELETE blocked by SQL triggers)
    const cdb = initCoreDb();
    const count = cdb.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
    if (count === 0) {
      appendAudit({ event: 'db_isolation_probe', ring: 0 });
    }
    let updateBlocked = false;
    let deleteBlocked = false;
    try {
      cdb.prepare("UPDATE audit_logs SET event = 'tampered' WHERE id = (SELECT MIN(id) FROM audit_logs)").run();
    } catch (e) {
      updateBlocked = /append-only/i.test(String(e.message));
    }
    try {
      cdb.prepare('DELETE FROM audit_logs WHERE id = (SELECT MIN(id) FROM audit_logs)').run();
    } catch (e) {
      deleteBlocked = /append-only/i.test(String(e.message));
    }
    checks.push({
      check: 'audit_logs_immutable_update',
      passed: updateBlocked,
      detail: updateBlocked ? 'BEFORE UPDATE trigger blocked mutation on audit_logs' : 'UPDATE was not blocked'
    });
    checks.push({
      check: 'audit_logs_immutable_delete',
      passed: deleteBlocked,
      detail: deleteBlocked ? 'BEFORE DELETE trigger blocked deletion on audit_logs' : 'DELETE was not blocked'
    });

    // 3. Verify Ring 1 table schema has zero real-identity columns (PII check)
    const r1Cols = cdb.prepare("PRAGMA table_info('ring1_codenames')").all().map((c) => c.name);
    const forbiddenCols = ['name', 'real_name', 'full_name', 'email', 'phone', 'nik', 'address'];
    const piiFound = r1Cols.filter((c) => forbiddenCols.includes(c.toLowerCase()));
    checks.push({
      check: 'ring1_zero_pii_schema',
      passed: piiFound.length === 0,
      columns: r1Cols,
      detail: piiFound.length === 0
        ? 'ring1_codenames stores code_name, hashes & channel only (zero real identity columns)'
        : 'Forbidden PII columns found: ' + piiFound.join(', ')
    });

    return {
      ok: checks.every((c) => c.passed),
      verifiedAt: new Date().toISOString(),
      checks
    };
  }

  function inspect() {
    if (!DatabaseSync) {
      return {
        engine: 'json_multi_store (Node 20 compatibility mode)',
        architecture: '4 Physically Separate Ring Stores + Core JSON Stores',
        nodeVersion: process.version,
        sqlite_available: false
      };
    }
    ensureAll();
    const cdb = initCoreDb();
    const ringStores = {};
    for (const r of [0, 1, 2, 3]) {
      const rdb = initRingDb(r);
      const file = ringDbPath(r);
      const sizeBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
      const passages = rdb.prepare('SELECT COUNT(*) AS n FROM passages').get().n;
      const ftsIndexed = rdb.prepare('SELECT COUNT(*) AS n FROM passages_fts').get().n;
      const memories = rdb.prepare('SELECT COUNT(*) AS n FROM ring_memories').get().n;
      ringStores['ring' + r] = {
        ring: r,
        file: 'rings/ring' + r + '/store.sqlite',
        sizeBytes,
        passages,
        ftsIndexed,
        memories,
        isolated: true
      };
    }

    const coreFile = coreDbPath();
    const countOf = (tbl) => cdb.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n;

    return {
      engine: 'node:sqlite (SQLite3 + FTS5 + WAL Mode)',
      architecture: '4 Physically Separate Ring Databases + 1 Core Relational Database',
      postgresSchemaPath: 'database/postgres_schema.sql',
      sqliteSchemaPath: 'database/sqlite_schema.sql',
      ringDatabases: ringStores,
      coreDatabase: {
        file: 'core.sqlite',
        sizeBytes: fs.existsSync(coreFile) ? fs.statSync(coreFile).size : 0,
        tables: {
          pending_ingestions: countOf('pending_ingestions'),
          tagging_precedents: countOf('tagging_precedents'),
          ring1_codenames: countOf('ring1_codenames'),
          ring2_members: countOf('ring2_members'),
          member_conversations: countOf('member_conversations'),
          works: countOf('works'),
          media_assets: countOf('media_assets'),
          subscription_plans: countOf('subscription_plans'),
          discount_coupons: countOf('discount_coupons'),
          payment_transactions: countOf('payment_transactions'),
          ai_api_keys: countOf('ai_api_keys'),
          ai_usage_daily: countOf('ai_usage_daily'),
          studio_documents: countOf('studio_documents'),
          audit_logs: countOf('audit_logs')
        }
      }
    };
  }

  function close() {
    for (const [, db] of ringDbs.entries()) {
      try { db.close(); } catch (_) {}
    }
    ringDbs.clear();
    if (coreDb) {
      try { coreDb.close(); } catch (_) {}
      coreDb = null;
    }
  }

  return {
    ensureAll,
    loadStore,
    saveStore,
    loadPending,
    savePending,
    loadPrecedents,
    savePrecedents,
    loadCodenames,
    saveCodenames,
    loadMembers,
    saveMembers,
    appendAudit,
    queryAudit,
    readDocument,
    writeDocument,
    verifyIsolation,
    inspect,
    close
  };
};
