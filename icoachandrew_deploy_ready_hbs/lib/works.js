'use strict';
// Ring 0 Studio — Works repository (books, essays, modules, hymns, talks…) classified Ring 0..3.
// Rules from the Ring Protocol apply here too:
//  * stricter wins: sensitive-looking works are proposed to Ring 0 and loosening needs explicit confirmation;
//  * every loosening is written to the precedents log with the admin's note;
//  * a work synced to the twin's knowledge lives in exactly ONE ring store at a time.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./sanitize');

const TYPES = ['buku', 'esai', 'artikel', 'modul', 'kerangka', 'himne', 'lagu', 'ceramah', 'video', 'audio', 'catatan', 'memoar'];

module.exports = function createWorks(ctx) {
  const { DATA, PUBLIC_DIR, readJson, writeJson, audit, send, body, loadStore, saveStore, SENSITIVE, loadPrecedents, savePrecedents, readableRings } = ctx;
  const file = () => path.join(DATA, 'works.json');

  function coverFromIndex(alt) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      const m = new RegExp('alt="' + alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s+src="([^"]+)"').exec(html);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function ensure() {
    if (fs.existsSync(file())) return;
    const now = new Date().toISOString();
    const base = (o, i) => ({
      id: 'wk_' + crypto.randomBytes(5).toString('hex'), subtitle: '', link: '', tags: [], content: '', lang: 'id',
      featured: false, syncKnowledge: false, order: i, createdAt: now, updatedAt: now, ringHistory: [], ...o
    });
    writeJson(file(), [
      base({ title: 'The Tani Method: Architecture of Enterprise Governance', subtitle: 'Karya Utama • Jilid I', type: 'buku', ring: 3, year: 2019, status: 'published', featured: true,
        summary: 'Kejelasan peran kepemimpinan, keselarasan strategi dan manusia, serta perancangan organisasi lintas generasi.', coverUrl: coverFromIndex('The Tani Method'), tags: ['tata kelola', 'strategi'] }, 0),
      base({ title: 'Harmoni Nusantara', subtitle: 'Memimpin Lintas Budaya', type: 'buku', ring: 3, year: 2015, status: 'published', featured: true,
        summary: 'Seni mendengarkan dan membangun budaya kerja yang sehat di tengah keberagaman Nusantara.', coverUrl: coverFromIndex('Harmoni Nusantara'), tags: ['budaya'] }, 1),
      base({ title: 'Wadah Mandiri & Dinamika Antar-Generasi', subtitle: 'Bisnis Keluarga', type: 'buku', ring: 3, year: 2012, status: 'published', featured: true,
        summary: 'Menjaga keharmonisan bisnis keluarga dan menyiapkan suksesi generasi berikutnya.', coverUrl: coverFromIndex('Wadah Mandiri'), tags: ['suksesi', 'keluarga'] }, 2),
      base({ title: 'Himne & Renungan Kepemimpinan', subtitle: 'Karya Lagu & Puisi', type: 'himne', ring: 3, year: 1983, status: 'published', featured: true,
        summary: 'Lagu dan renungan yang menemani perjalanan kepemimpinan sejak 1983.', coverUrl: coverFromIndex('Himne & Renungan'), tags: ['himne'] }, 3),
      base({ title: 'Orbex Framework: Organizing Business Excellence', type: 'kerangka', ring: 2, year: 2021, status: 'published',
        summary: 'Kerangka berlisensi untuk menyelaraskan niat strategis dengan ritme operasional harian (khusus anggota).', coverUrl: '' }, 4),
      base({ title: 'Catatan Mandat Eksekutor', type: 'catatan', ring: 1, year: 2026, status: 'draft',
        summary: 'Catatan koordinasi untuk lingkaran eksekutor terpercaya.', coverUrl: '' }, 5),
      base({ title: 'Memoar Pribadi (Naskah Belum Terbit)', type: 'memoar', ring: 0, year: 2026, status: 'draft',
        summary: 'Naskah pribadi yang hanya boleh dibaca Andrew sendiri.', coverUrl: '' }, 6)
    ]);
  }
  const load = () => { ensure(); return readJson(file()); };
  const save = (v) => writeJson(file(), v);

  const flaggedOf = (w) => {
    const lower = (w.title + ' ' + w.summary + ' ' + w.content).toLowerCase();
    return SENSITIVE.filter((x) => lower.includes(x));
  };

  // Keep the knowledge copy in exactly one ring store (or none).
  function syncKnowledge(w, remove = false) {
    const docId = 'w_' + w.id;
    for (const r of [0, 1, 2, 3]) {
      const st = loadStore(r);
      const i = st.findIndex((d) => d.id === docId);
      if (i >= 0) { st.splice(i, 1); saveStore(r, st); }
    }
    if (remove || !w.syncKnowledge || w.status !== 'published') return false;
    const text = [w.summary, w.content].filter(Boolean).join('\n\n').trim();
    if (!text) return false;
    const st = loadStore(w.ring);
    st.push({ id: docId, title: w.title, text, lang: w.lang || 'id', ring: w.ring, approvedAt: new Date().toISOString(), source: 'works' });
    saveStore(w.ring, st);
    return true;
  }

  function precedent(w, fromRing, toRing, note, flagged) {
    const p = loadPrecedents();
    p.push({ id: w.id, title: w.title, proposedRing: fromRing, approvedRing: toRing, flagged, note: S.plain(note, 300), source: 'works', decidedAt: new Date().toISOString() });
    savePrecedents(p);
  }

  function clean(b, prev) {
    const ring = Number(b.ring);
    return {
      title: S.plain(b.title, 200),
      subtitle: S.plain(b.subtitle, 160),
      type: TYPES.includes(b.type) ? b.type : 'buku',
      ring: [0, 1, 2, 3].includes(ring) ? ring : (prev ? prev.ring : 0),
      year: Number(b.year) > 1900 && Number(b.year) < 2200 ? Number(b.year) : null,
      summary: S.plain(b.summary, 1200),
      content: String(b.content || '').replace(/<[^>]*>/g, '').slice(0, 200000),
      coverUrl: S.safeImageUrl(b.coverUrl),
      link: S.safeUrl(b.link),
      tags: (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map((t) => S.plain(t, 40)).filter(Boolean).slice(0, 16),
      status: b.status === 'published' ? 'published' : 'draft',
      featured: Boolean(b.featured),
      syncKnowledge: Boolean(b.syncKnowledge),
      lang: b.lang === 'en' ? 'en' : 'id'
    };
  }

  // Shared ring guard (stricter wins). fromRing is null for new works. Returns an error payload or null.
  function guard(w, fromRing, toRing, b) {
    const flagged = flaggedOf(w);
    const ackKey = flagged.join(',');
    if (flagged.length && toRing > 0 && !b.confirmSensitive && w.sensitiveAck !== ackKey) {
      return { code: 409, err: { error: 'sensitive_needs_confirm', flagged, proposedRing: 0 } };
    }
    if (fromRing !== null && toRing > fromRing && !String(b.note || '').trim()) {
      return { code: 409, err: { error: 'loosening_needs_note', fromRing, toRing } };
    }
    return null;
  }

  const admin = {
    'GET /admin/api/works': (req, res) => {
      const list = load().sort((a, b) => a.order - b.order).map((w) => ({ ...w, flagged: flaggedOf(w), contentLength: (w.content || '').length, content: undefined }));
      return send(res, 200, { works: list, types: TYPES });
    },

    'GET /admin/api/works/item': (req, res, { url }) => {
      const w = load().find((x) => x.id === url.searchParams.get('id'));
      if (!w) return send(res, 404, { error: 'not_found' });
      return send(res, 200, { work: { ...w, flagged: flaggedOf(w) } });
    },

    'POST /admin/api/works': async (req, res) => {
      const b = await body(req, 1024 * 1024);
      const list = load();
      const now = new Date().toISOString();
      let w = b.id ? list.find((x) => x.id === b.id) : null;
      const data = clean(b, w);
      if (!data.title) return send(res, 400, { error: 'title_required' });
      if (w) {
        const candidate = { ...w, ...data };
        const g = guard(candidate, w.ring, data.ring, b);
        if (g) return send(res, g.code, g.err);
        if (data.ring !== w.ring) {
          w.ringHistory = [...(w.ringHistory || []), { from: w.ring, to: data.ring, note: S.plain(b.note, 300), at: now }];
          if (data.ring > w.ring) precedent(w, w.ring, data.ring, b.note, flaggedOf(candidate));
          audit({ event: 'work_ring_changed', ring: 0, id: w.id, fromRing: w.ring, toRing: data.ring });
        }
        Object.assign(w, data, { updatedAt: now });
        if (b.confirmSensitive) w.sensitiveAck = flaggedOf(w).join(',');
      } else {
        const g = guard(data, null, data.ring, b);
        if (g) return send(res, g.code, g.err);
        w = { id: 'wk_' + crypto.randomBytes(5).toString('hex'), ...data, order: list.length, createdAt: now, updatedAt: now, ringHistory: [] };
        if (b.confirmSensitive) w.sensitiveAck = flaggedOf(w).join(',');
        list.push(w);
        audit({ event: 'work_created', ring: 0, id: w.id, workRing: w.ring });
      }
      const synced = syncKnowledge(w);
      save(list);
      return send(res, 200, { ok: true, work: { ...w, flagged: flaggedOf(w) }, synced });
    },

    'POST /admin/api/works/move': async (req, res) => {
      const b = await body(req, 4000);
      const toRing = Number(b.toRing);
      if (![0, 1, 2, 3].includes(toRing)) return send(res, 400, { error: 'bad_request' });
      const list = load();
      const w = list.find((x) => x.id === b.id);
      if (!w) return send(res, 404, { error: 'not_found' });
      if (w.ring === toRing) return send(res, 200, { ok: true, work: w });
      const g = guard(w, w.ring, toRing, b);
      if (g) return send(res, g.code, g.err);
      const now = new Date().toISOString();
      if (toRing > w.ring) precedent(w, w.ring, toRing, b.note, flaggedOf(w));
      w.ringHistory = [...(w.ringHistory || []), { from: w.ring, to: toRing, note: S.plain(b.note, 300), at: now }];
      audit({ event: 'work_ring_changed', ring: 0, id: w.id, fromRing: w.ring, toRing });
      w.ring = toRing; w.updatedAt = now;
      if (b.confirmSensitive) w.sensitiveAck = flaggedOf(w).join(',');
      syncKnowledge(w);
      save(list);
      return send(res, 200, { ok: true, work: w });
    },

    'POST /admin/api/works/reorder': async (req, res) => {
      const b = await body(req, 20000);
      const ids = Array.isArray(b.ids) ? b.ids : [];
      const list = load();
      ids.forEach((id, i) => { const w = list.find((x) => x.id === id); if (w) w.order = i; });
      save(list);
      return send(res, 200, { ok: true });
    },

    'POST /admin/api/works/delete': async (req, res) => {
      const b = await body(req, 2000);
      const list = load();
      const i = list.findIndex((x) => x.id === b.id);
      if (i < 0) return send(res, 404, { error: 'not_found' });
      const [w] = list.splice(i, 1);
      syncKnowledge(w, true);
      save(list);
      audit({ event: 'work_deleted', ring: 0, id: w.id });
      return send(res, 200, { ok: true });
    }
  };

  const pub = {
    'GET /api/works': (req, res, { sess }) => {
      const allowed = readableRings(sess.ring);
      const list = load()
        .filter((w) => w.status === 'published' && allowed.includes(w.ring))
        .sort((a, b) => a.order - b.order)
        .map((w) => ({ id: w.id, title: w.title, subtitle: w.subtitle, type: w.type, year: w.year, summary: w.summary, coverUrl: w.coverUrl, link: w.link, tags: w.tags, featured: w.featured }));
      return send(res, 200, { works: list });
    }
  };

  function summary() {
    const list = load();
    const byRing = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const w of list) byRing[w.ring]++;
    return { total: list.length, byRing, published: list.filter((w) => w.status === 'published').length };
  }

  return { ensure, admin, pub, summary, TYPES };
};
