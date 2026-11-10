'use strict';
// Ring 0 Studio — aggregates every Studio module behind one route table.
// Admin routes are only reached after server.js has verified the Ring 0 admin session.

const fs = require('node:fs');
const path = require('node:path');
const S = require('./sanitize');
const createVault = require('./vault');

module.exports = function createStudio(ctx) {
  ctx.vault = createVault(ctx.DATA);
  const cms = require('./cms')(ctx);
  const works = require('./works')(ctx);
  const memory = require('./memory')(ctx);
  ctx.memory = memory;
  const ai = require('./ai')(ctx);
  const commerce = require('./commerce')(ctx);
  const { send, body, readJson, DATA, audit } = ctx;

  function ensure() { cms.ensure(); works.ensure(); memory.ensure(); ai.ensure(); commerce.ensure(); }

  function auditStats() {
    const f = path.join(DATA, 'audit.log');
    const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').slice(-5000) : [];
    const since7 = Date.now() - 7 * 86400000;
    const day = new Date().toISOString().slice(0, 10);
    const out = { chatsToday: 0, chats7d: 0, byRing7d: { 0: 0, 1: 0, 2: 0, 3: 0 }, refused7d: 0, guard7d: 0, series: {} };
    for (const l of lines) {
      if (!l) continue;
      let e; try { e = JSON.parse(l); } catch (_) { continue; }
      if (e.event !== 'chat') { if (e.event === 'leak_blocked' && Date.parse(e.ts) > since7) out.guard7d++; continue; }
      const t = Date.parse(e.ts);
      if (String(e.ts).startsWith(day)) out.chatsToday++;
      if (t > since7) {
        out.chats7d++; out.byRing7d[e.ring] = (out.byRing7d[e.ring] || 0) + 1;
        if (e.refused) out.refused7d++;
        const d = String(e.ts).slice(0, 10); out.series[d] = (out.series[d] || 0) + 1;
      }
    }
    return out;
  }

  const extraAdmin = {
    'GET /admin/api/overview': (req, res) => {
      const stores = {};
      for (const r of [0, 1, 2, 3]) stores[r] = ctx.loadStore(r).length;
      const members = ctx.loadMembers();
      const codes = ctx.loadCodenames();
      return send(res, 200, {
        stores, pending: ctx.loadPending().length, precedents: ctx.loadPrecedents().length,
        members: { total: members.length, active: members.filter((m) => m.entitlement === 'active').length },
        codenames: { active: codes.filter((c) => c.status === 'active').length, revoked: codes.filter((c) => c.status !== 'active').length },
        site: cms.summary(), works: works.summary(), memory: memory.summary(), ai: ai.summary(), commerce: commerce.summary(),
        database: ctx.db ? ctx.db.inspect() : null,
        activity: auditStats(), serverTime: new Date().toISOString()
      });
    },

    'GET /admin/api/database': (req, res) => {
      if (!ctx.db) return send(res, 503, { error: 'db_unavailable' });
      return send(res, 200, ctx.db.inspect());
    },

    'POST /admin/api/database/verify-isolation': (req, res) => {
      if (!ctx.db) return send(res, 503, { error: 'db_unavailable' });
      const result = ctx.db.verifyIsolation();
      audit({ event: 'database_isolation_verified', ring: 0, ok: result.ok });
      return send(res, 200, result);
    },

    'GET /admin/api/members': (req, res) => {
      const plans = readJson(path.join(DATA, 'commerce.json')).plans;
      return send(res, 200, {
        members: ctx.loadMembers().map(({ credentialHash, conversations, ...m }) => ({ ...m, conversationCount: (conversations || []).length })),
        plans: plans.filter((p) => p.ring === 2).map((p) => ({ id: p.id, name: p.name, messageCap: p.messageCap }))
      });
    },

    'POST /admin/api/members/update': async (req, res) => {
      const b = await body(req, 4000);
      const list = ctx.loadMembers();
      const m = list.find((x) => x.id === b.id);
      if (!m) return send(res, 404, { error: 'not_found' });
      if (['active', 'lapsed', 'pending_payment', 'suspended'].includes(b.entitlement)) m.entitlement = b.entitlement;
      if (b.cap !== undefined) m.cap = Math.max(0, Math.round(Number(b.cap) || 0));
      if (b.resetUsage) m.used = 0;
      if (b.planId !== undefined) { m.planId = S.plain(b.planId, 60) || null; if (m.planId && b.cap === undefined) m.cap = commerce.capForPlan(m.planId); }
      if (b.displayName !== undefined) m.displayName = S.plain(b.displayName, 120);
      ctx.saveMembers(list);
      audit({ event: 'member_updated', ring: 0, memberId: m.id, entitlement: m.entitlement });
      return send(res, 200, { ok: true });
    },

    'POST /admin/api/members/delete': async (req, res) => {
      const b = await body(req, 2000);
      const list = ctx.loadMembers();
      const i = list.findIndex((x) => x.id === b.id);
      if (i < 0) return send(res, 404, { error: 'not_found' });
      list.splice(i, 1);
      ctx.saveMembers(list);
      for (const [t, s] of ctx.sessions.entries()) if (s.memberId === b.id) ctx.sessions.delete(t);
      audit({ event: 'member_deleted', ring: 0, memberId: b.id });
      return send(res, 200, { ok: true });
    },

    // Backup bundle — never includes secrets, password hashes or the vault key.
    'GET /admin/api/export': (req, res) => {
      const read = (f, d) => { const p = path.join(DATA, f); return fs.existsSync(p) ? readJson(p) : d; };
      const commerceData = read('commerce.json', {});
      for (const g of Object.values(commerceData.gateways || {})) for (const k of Object.keys(g)) if (g[k] && typeof g[k] === 'object' && g[k].data) g[k] = '[sealed]';
      const aiCfg = read('ai-config.json', {});
      aiCfg.keys = (aiCfg.keys || []).map((k) => ({ id: k.id, label: k.label, sealed: '[sealed]' }));
      audit({ event: 'admin_export', ring: 0 });
      const bundle = {
        exportedAt: new Date().toISOString(), app: 'iCoachAndrew Ring 0 Studio',
        site: read('site-content.json', {}), works: read('works.json', []), gdrive: works.gdrive ? works.gdrive.publicConfigView() : {}, memory: read('protocol-memory.json', {}),
        commerce: commerceData, ai: aiCfg, media: read('media.json', []),
        knowledge: { 0: ctx.loadStore(0), 1: ctx.loadStore(1), 2: ctx.loadStore(2), 3: ctx.loadStore(3) }, precedents: ctx.loadPrecedents()
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="icoachandrew-backup-' + bundle.exportedAt.slice(0, 10) + '.json"' });
      return res.end(JSON.stringify(bundle, null, 2));
    },

    // Knowledge passage detail & delete (complements the existing upload/approve/move flow)
    'GET /admin/api/doc': (req, res, { url }) => {
      const ring = Number(url.searchParams.get('ring'));
      if (![0, 1, 2, 3].includes(ring)) return send(res, 400, { error: 'bad_request' });
      const d = ctx.loadStore(ring).find((x) => x.id === url.searchParams.get('id'));
      return d ? send(res, 200, { doc: d }) : send(res, 404, { error: 'not_found' });
    },

    'POST /admin/api/doc/delete': async (req, res) => {
      const b = await body(req, 2000);
      const ring = Number(b.ring);
      if (![0, 1, 2, 3].includes(ring)) return send(res, 400, { error: 'bad_request' });
      const st = ctx.loadStore(ring);
      const i = st.findIndex((x) => x.id === b.id);
      if (i < 0) return send(res, 404, { error: 'not_found' });
      st.splice(i, 1); ctx.saveStore(ring, st);
      audit({ event: 'doc_deleted', ring: 0, docRing: ring, id: b.id });
      return send(res, 200, { ok: true });
    },

    'POST /admin/api/pending/reject': async (req, res) => {
      const b = await body(req, 2000);
      const p = ctx.loadPending();
      const i = p.findIndex((x) => x.id === b.id);
      if (i < 0) return send(res, 404, { error: 'not_found' });
      p.splice(i, 1); ctx.savePending(p);
      audit({ event: 'file_rejected', ring: 0, id: b.id });
      return send(res, 200, { ok: true });
    }
  };

  const adminTable = { ...cms.admin, ...works.admin, ...memory.admin, ...ai.admin, ...commerce.admin, ...extraAdmin };
  const publicTable = { ...cms.pub, ...works.pub, ...commerce.pub };

  async function run(table, req, res, extra) {
    const h = table[req.method + ' ' + extra.url.pathname];
    if (!h) return false;
    if (typeof extra.getSess === 'function') extra.sess = extra.getSess();
    await h(req, res, extra);
    return true;
  }

  return {
    ensure, cms, works, memory, ai, commerce,
    dispatchAdmin: (req, res, extra) => run(adminTable, req, res, extra),
    dispatchPublic: (req, res, extra) => run(publicTable, req, res, extra),
    serveMedia: cms.serveMedia
  };
};
