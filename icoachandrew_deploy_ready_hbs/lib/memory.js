'use strict';
// Ring 0 Studio — Andrew Tani's protocol memory, Ring 0..3.
// The twin only ever receives the memory of rings the asker may read (readableRings),
// and the leak guard also checks replies against the memory of stricter rings.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./sanitize');

const DEFAULT = () => ({
  core: {
    identity: 'Saya adalah digital twin Pak Andrew Tani, Senior Management Advisor & Author, serta co-author buku Organizing for Business Excellence dan Brain Quotient. Andrew Tani telah mendampingi para pemimpin dan dewan direksi sejak 1983. Saya berbicara sebagai Andrew dalam orang pertama, tetapi selalu jujur bahwa saya adalah digital twin-nya bila ditanya dengan sungguh-sungguh.',
    voice: 'Lugas, hangat, dan membumi. Substansi sebelum seremoni. Mendengarkan dulu, baru menanggapi. Menyapa penanya sebagai sahabat. Tidak memakai tanda bintang, tagar, atau em-dash.',
    values: [
      'Ing Ngarso Sung Tulodo: memimpin dengan keteladanan.',
      'Ing Madyo Mangun Karso: membangun semangat dari tengah tim.',
      'Tut Wuri Handayani: mendorong dari belakang agar orang lain tumbuh.',
      'Budaya dibentuk oleh apa yang kita hargai dan apa yang kita biarkan setiap hari.'
    ],
    languageStyle: 'Ikuti bahasa penanya (Indonesia atau Inggris). Kalimat pendek, contoh nyata, tanpa jargon.'
  },
  rings: {
    0: { label: 'Ring 0 — Sovereign (Andrew pribadi)', audience: 'Hanya Andrew Tani sendiri.', tone: 'Jujur dan reflektif, seperti catatan pribadi.',
      directives: 'Boleh membahas seluruh arsip termasuk catatan pribadi, keuangan, dan keluarga. Tidak pernah dikutip ke ring lain.', blockedTopics: [],
      memories: [{ text: 'Andrew lebih suka keputusan sensitif keluarga dibahas langsung, tidak lewat perantara.', tags: ['keluarga'], pinned: true }] },
    1: { label: 'Ring 1 — Lingkaran Eksekutor (kode nama)', audience: 'Eksekutor dan sahabat terdekat yang memegang kode nama aktif.', tone: 'Akrab, ringkas, berorientasi tindakan.',
      directives: 'Boleh membahas mandat koordinasi dan rencana kerja yang sudah dibagikan. Jangan pernah menyebut identitas asli pemegang kode nama.', blockedTopics: ['valuasi', 'valuation', 'warisan'],
      memories: [{ text: 'Untuk koordinasi mandat, Andrew mengutamakan kejelasan siapa memutuskan apa dan kapan ditinjau ulang.', tags: ['mandat'], pinned: false }] },
    2: { label: 'Ring 2 — Anggota Eksekutif', audience: 'Anggota berlangganan yang terverifikasi.', tone: 'Hangat dan mendalam, seperti sesi mentoring.',
      directives: 'Boleh memakai materi berlisensi khusus anggota (misalnya Orbex Framework). Arahkan pada refleksi dan langkah praktis.', blockedTopics: [],
      memories: [{ text: 'Dalam mentoring anggota, Andrew biasanya menutup dengan satu pertanyaan reflektif untuk dibawa pulang.', tags: ['gaya'], pinned: true }] },
    3: { label: 'Ring 3 — Publik', audience: 'Siapa pun yang berkunjung tanpa masuk.', tone: 'Ramah, menyambut, dan inspiratif.',
      directives: 'Hanya memakai karya yang sudah terbit untuk umum. Bila ragu, tolak dengan sopan memakai kalimat penolakan baku.', blockedTopics: [],
      memories: [{ text: 'Andrew Tani adalah Senior Management Advisor & Author, co-author buku Organizing for Business Excellence dan Brain Quotient. Andrew mulai mendampingi organisasi dan para pemimpin sejak 1983, dan menulis lagu serta esai kepemimpinan di sepanjang perjalanan itu.', tags: ['biografi'], pinned: true }] }
  },
  updatedAt: null,
  versions: []
});

module.exports = function createMemory(ctx) {
  const { DATA, readJson, writeJson, audit, send, body, SENSITIVE, readableRings, loadPrecedents, savePrecedents, FIXED_DUTIES } = ctx;
  const file = () => path.join(DATA, 'protocol-memory.json');
  const newId = () => 'mem_' + crypto.randomBytes(5).toString('hex');

  function ensure() {
    if (fs.existsSync(file())) return;
    const d = DEFAULT();
    const now = new Date().toISOString();
    for (const r of [0, 1, 2, 3]) d.rings[r].memories = d.rings[r].memories.map((m) => ({ id: newId(), ...m, createdAt: now, updatedAt: now }));
    d.updatedAt = now;
    writeJson(file(), d);
  }
  const load = () => { ensure(); return readJson(file()); };
  function save(m, note) {
    const last = m.versions[0];
    if (!last || Date.now() - Date.parse(last.at) > 10 * 60 * 1000 || note) {
      const prev = readJson(file());
      delete prev.versions;
      m.versions.unshift({ id: 'mv_' + crypto.randomBytes(4).toString('hex'), at: new Date().toISOString(), note: S.plain(note || 'Simpan otomatis', 160), snapshot: prev });
      m.versions = m.versions.slice(0, 20);
    }
    m.updatedAt = new Date().toISOString();
    writeJson(file(), m);
  }
  const flaggedOf = (t) => SENSITIVE.filter((w) => String(t).toLowerCase().includes(w));
  const ringOk = (r) => [0, 1, 2, 3].includes(Number(r));

  // ---------- used by the conversation engine ----------
  function compileFor(askerRing, maxChars = 9000) {
    const m = load();
    const lines = [];
    lines.push('Identity: ' + m.core.identity);
    lines.push('Voice: ' + m.core.voice);
    if (m.core.languageStyle) lines.push('Language: ' + m.core.languageStyle);
    if (m.core.values.length) lines.push('Values:\n' + m.core.values.map((v) => '- ' + v).join('\n'));
    // most public first, then progressively more trusted rings the asker may read
    for (const r of readableRings(askerRing).sort((a, b) => b - a)) {
      const ring = m.rings[r];
      lines.push(`[Ring ${r} guidance] Audience: ${ring.audience} Tone: ${ring.tone} ${ring.directives}`);
      const mem = [...ring.memories].sort((a, b) => Number(b.pinned) - Number(a.pinned));
      if (mem.length) lines.push(`[Ring ${r} memories]\n` + mem.map((x) => '- ' + x.text).join('\n'));
    }
    return lines.join('\n\n').slice(0, maxChars);
  }

  function blockedFor(askerRing) {
    const r = load().rings[askerRing];
    return r ? r.blockedTopics : [];
  }

  // Texts the asker may NOT read (stricter rings) — fed to the leak guard.
  function stricterTexts(askerRing) {
    const m = load();
    const out = [];
    for (let r = 0; r < askerRing; r++) {
      out.push({ ring: r, id: 'directives_r' + r, text: m.rings[r].directives });
      for (const x of m.rings[r].memories) out.push({ ring: r, id: x.id, text: x.text });
    }
    return out;
  }

  function ringToneFor(askerRing) {
    const r = load().rings[askerRing];
    return r ? r.tone : '';
  }

  // ---------- admin routes ----------
  const admin = {
    'GET /admin/api/memory': (req, res) => {
      const m = load();
      const stats = {};
      for (const r of [0, 1, 2, 3]) stats[r] = { memories: m.rings[r].memories.length, chars: compileFor(r, 1e6).length };
      return send(res, 200, {
        core: m.core, rings: m.rings, updatedAt: m.updatedAt, stats, fixedDuties: FIXED_DUTIES,
        versions: m.versions.map((v) => ({ id: v.id, at: v.at, note: v.note }))
      });
    },

    'GET /admin/api/memory/preview': (req, res, { url }) => {
      const ring = Number(url.searchParams.get('ring') ?? 3);
      if (!ringOk(ring)) return send(res, 400, { error: 'bad_request' });
      return send(res, 200, { ring, readable: readableRings(ring), compiled: compileFor(ring, 1e6) });
    },

    'POST /admin/api/memory/core': async (req, res) => {
      const b = await body(req, 60000);
      const m = load();
      m.core = {
        identity: S.plain(b.identity ?? m.core.identity, 4000),
        voice: S.plain(b.voice ?? m.core.voice, 4000),
        languageStyle: S.plain(b.languageStyle ?? m.core.languageStyle, 2000),
        values: (Array.isArray(b.values) ? b.values : m.core.values).map((v) => S.plain(v, 400)).filter(Boolean).slice(0, 30)
      };
      save(m);
      audit({ event: 'memory_core_updated', ring: 0 });
      return send(res, 200, { ok: true, core: m.core });
    },

    'POST /admin/api/memory/ring': async (req, res) => {
      const b = await body(req, 60000);
      if (!ringOk(b.ring)) return send(res, 400, { error: 'bad_request' });
      const m = load();
      const r = m.rings[Number(b.ring)];
      if (b.label !== undefined) r.label = S.plain(b.label, 120);
      if (b.audience !== undefined) r.audience = S.plain(b.audience, 600);
      if (b.tone !== undefined) r.tone = S.plain(b.tone, 600);
      if (b.directives !== undefined) r.directives = S.plain(b.directives, 6000);
      if (b.blockedTopics !== undefined) {
        r.blockedTopics = (Array.isArray(b.blockedTopics) ? b.blockedTopics : String(b.blockedTopics).split(','))
          .map((t) => S.plain(t, 60).toLowerCase()).filter(Boolean).slice(0, 60);
      }
      save(m);
      audit({ event: 'memory_ring_policy_updated', ring: 0, targetRing: Number(b.ring) });
      return send(res, 200, { ok: true, ring: r });
    },

    'POST /admin/api/memory/entry': async (req, res) => {
      const b = await body(req, 20000);
      if (!ringOk(b.ring)) return send(res, 400, { error: 'bad_request' });
      const ring = Number(b.ring);
      const text = S.plain(b.text, 3000);
      if (!text) return send(res, 400, { error: 'text_required' });
      const flagged = flaggedOf(text);
      if (flagged.length && ring > 0 && !b.confirmSensitive) return send(res, 409, { error: 'sensitive_needs_confirm', flagged, proposedRing: 0 });
      const m = load();
      const list = m.rings[ring].memories;
      const now = new Date().toISOString();
      const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map((t) => S.plain(t, 40)).filter(Boolean).slice(0, 12);
      let e = b.id ? list.find((x) => x.id === b.id) : null;
      if (e) Object.assign(e, { text, tags, pinned: Boolean(b.pinned), updatedAt: now });
      else { e = { id: newId(), text, tags, pinned: Boolean(b.pinned), createdAt: now, updatedAt: now }; list.push(e); }
      save(m);
      audit({ event: 'memory_entry_saved', ring: 0, targetRing: ring, flaggedCount: flagged.length });
      return send(res, 200, { ok: true, entry: e, flagged });
    },

    'POST /admin/api/memory/import': async (req, res) => {
      const b = await body(req, 400000);
      if (!ringOk(b.ring)) return send(res, 400, { error: 'bad_request' });
      const ring = Number(b.ring);
      const lines = String(b.lines || '').split(/\r?\n/).map((l) => S.plain(l.replace(/^[-*•\s]+/, ''), 3000)).filter((l) => l.length > 3).slice(0, 500);
      const flagged = lines.filter((l) => flaggedOf(l).length);
      if (flagged.length && ring > 0 && !b.confirmSensitive) return send(res, 409, { error: 'sensitive_needs_confirm', flaggedLines: flagged.slice(0, 10), count: flagged.length });
      const m = load();
      const now = new Date().toISOString();
      for (const text of lines) m.rings[ring].memories.push({ id: newId(), text, tags: S.plain(b.tag || '', 40) ? [S.plain(b.tag, 40)] : [], pinned: false, createdAt: now, updatedAt: now });
      save(m, 'Impor ' + lines.length + ' memori ke Ring ' + ring);
      audit({ event: 'memory_imported', ring: 0, targetRing: ring, count: lines.length });
      return send(res, 200, { ok: true, added: lines.length });
    },

    'POST /admin/api/memory/entry/delete': async (req, res) => {
      const b = await body(req, 2000);
      if (!ringOk(b.ring)) return send(res, 400, { error: 'bad_request' });
      const m = load();
      const list = m.rings[Number(b.ring)].memories;
      const i = list.findIndex((x) => x.id === b.id);
      if (i < 0) return send(res, 404, { error: 'not_found' });
      list.splice(i, 1);
      save(m);
      audit({ event: 'memory_entry_deleted', ring: 0, targetRing: Number(b.ring) });
      return send(res, 200, { ok: true });
    },

    'POST /admin/api/memory/entry/move': async (req, res) => {
      const b = await body(req, 4000);
      const from = Number(b.fromRing), to = Number(b.toRing);
      if (!ringOk(from) || !ringOk(to) || from === to) return send(res, 400, { error: 'bad_request' });
      const m = load();
      const src = m.rings[from].memories;
      const i = src.findIndex((x) => x.id === b.id);
      if (i < 0) return send(res, 404, { error: 'not_found' });
      const e = src[i];
      const flagged = flaggedOf(e.text);
      if (flagged.length && to > 0 && !b.confirmSensitive) return send(res, 409, { error: 'sensitive_needs_confirm', flagged, proposedRing: 0 });
      if (to > from && !String(b.note || '').trim()) return send(res, 409, { error: 'loosening_needs_note', fromRing: from, toRing: to });
      src.splice(i, 1);
      e.updatedAt = new Date().toISOString();
      m.rings[to].memories.push(e);
      if (to > from) {
        const p = loadPrecedents();
        p.push({ id: e.id, title: e.text.slice(0, 80), proposedRing: from, approvedRing: to, flagged, note: S.plain(b.note, 300), source: 'memory', decidedAt: e.updatedAt });
        savePrecedents(p);
      }
      save(m, `Pindah memori Ring ${from} → Ring ${to}`);
      audit({ event: 'memory_entry_moved', ring: 0, fromRing: from, toRing: to });
      return send(res, 200, { ok: true });
    },

    'POST /admin/api/memory/restore': async (req, res) => {
      const b = await body(req, 2000);
      const m = load();
      const v = m.versions.find((x) => x.id === b.versionId);
      if (!v) return send(res, 404, { error: 'not_found' });
      const restored = { ...JSON.parse(JSON.stringify(v.snapshot)), versions: m.versions };
      save(restored, 'Sebelum pemulihan ke ' + v.at);
      audit({ event: 'memory_restored', ring: 0, version: v.id });
      return send(res, 200, { ok: true });
    }
  };

  function summary() {
    const m = load();
    const out = {};
    for (const r of [0, 1, 2, 3]) out[r] = m.rings[r].memories.length;
    return { byRing: out, updatedAt: m.updatedAt };
  }

  return { ensure, admin, compileFor, blockedFor, stricterTexts, ringToneFor, summary };
};
