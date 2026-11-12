'use strict';
// Ring 0 Studio — Works repository (books, essays, modules, hymns, talks…) classified Ring 0..3.
// Rules from the Ring Protocol apply here too:
//  * stricter wins: sensitive-looking works are proposed to Ring 0 and loosening needs explicit confirmation;
//  * every loosening is written to the precedents log with the admin's note;
//  * a work synced to the twin's knowledge lives in exactly ONE ring store at a time;
//  * supports direct read-only synchronization with Google Drive API v3 folders & files.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./sanitize');
const createGDriveConnector = require('./gdrive');

const TYPES = ['buku', 'esai', 'artikel', 'modul', 'kerangka', 'himne', 'lagu', 'ceramah', 'video', 'audio', 'catatan', 'memoar'];

module.exports = function createWorks(ctx) {
  const { DATA, PUBLIC_DIR, readJson, writeJson, audit, send, body, loadStore, saveStore, SENSITIVE, loadPrecedents, savePrecedents, readableRings } = ctx;
  const file = () => path.join(DATA, 'works.json');
  const gdrive = createGDriveConnector(ctx);

  function coverFromIndex(alt) {
    try {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      const m = new RegExp('alt="' + alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s+src="([^"]+)"').exec(html);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function ensure() {
    gdrive.ensure();
    const gdCfg = gdrive.loadConfig();
    gdrive.setupAutoSyncTimer(gdCfg.autoSyncMinutes, () => syncFromGoogleDrive({ trigger: 'auto' }));
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
    const lower = ((w.title || '') + ' ' + (w.summary || '') + ' ' + (w.content || '')).toLowerCase();
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
    st.push({
      id: docId,
      title: w.title,
      text,
      lang: w.lang || 'id',
      ring: w.ring,
      approvedAt: new Date().toISOString(),
      source: w.gdriveFileId ? 'gdrive_works' : 'works'
    });
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

  // Upsert a single Google Drive file into the works list (enforcing Stricter Wins).
  function upsertDriveFileToList(list, fileMeta, textContent, proposedRing, folderName = '', gdCfg = {}) {
    const now = new Date().toISOString();
    const rawTitle = gdrive.cleanTitleFromFilename(fileMeta.name) || fileMeta.name || 'Karya Tanpa Judul';
    const yearMatch = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(fileMeta.name || '') || /\b(19[5-9]\d|20[0-4]\d)\b/.exec(fileMeta.createdTime || '');
    const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
    const inferredType = gdrive.inferWorkType(fileMeta.name + ' ' + folderName, fileMeta.mimeType, TYPES);
    const cleanText = String(textContent || '').replace(/<[^>]*>/g, '').slice(0, 200000).trim();
    const firstPara = cleanText.split(/\n{2,}/).map((p) => p.trim()).find((p) => p.length > 20) || cleanText.slice(0, 400);
    const rawSummary = S.plain(fileMeta.description || firstPara || `Dokumen Google Drive (${folderName || 'Repositori Karya'})`, 1200);
    const lang = gdrive.inferLang(rawTitle, cleanText || rawSummary);
    const link = S.safeUrl(fileMeta.webViewLink || fileMeta.webContentLink || `https://drive.google.com/file/d/${fileMeta.id}/view`);

    // Check if file name itself specifies a stricter or explicit ring tag
    const fileRingTag = gdrive.inferRingFromName(fileMeta.name, null);
    let targetRing = fileRingTag !== null ? fileRingTag : ([0, 1, 2, 3].includes(Number(proposedRing)) ? Number(proposedRing) : 0);

    let existing = list.find((x) => x.gdriveFileId === fileMeta.id);
    if (existing && existing.ringOverrideByAdmin && fileRingTag === null) {
      targetRing = existing.ring;
    }

    const candidate = {
      title: S.plain(rawTitle, 200),
      summary: rawSummary,
      content: cleanText
    };
    const flagged = flaggedOf(candidate);
    const ackKey = flagged.join(',');
    let quarantined = false;
    let quarantinedFromRing = null;

    // Stricter Wins: if sensitive lexicon is detected and not explicitly acknowledged for this exact set, force Ring 0.
    if (flagged.length > 0 && targetRing > 0 && (!existing || existing.sensitiveAck !== ackKey)) {
      quarantinedFromRing = targetRing;
      targetRing = 0;
      quarantined = true;
    }

    if (existing) {
      existing.title = candidate.title || existing.title;
      existing.summary = candidate.summary || existing.summary;
      if (cleanText) existing.content = cleanText;
      existing.link = link || existing.link;
      existing.type = existing.type || inferredType;
      existing.year = existing.year || year;
      existing.lang = lang;
      existing.gdriveFolderName = folderName || existing.gdriveFolderName || '';
      existing.gdriveMimeType = fileMeta.mimeType || '';
      existing.gdriveModifiedTime = fileMeta.modifiedTime || now;
      existing.gdriveSyncedAt = now;
      if (quarantined) {
        existing.ring = 0;
        existing.quarantinedFromRing = quarantinedFromRing;
      } else if (!existing.ringOverrideByAdmin) {
        existing.ring = targetRing;
      }
      existing.updatedAt = now;
      syncKnowledge(existing);
      return { action: 'updated', work: existing, quarantined };
    }

    const newWork = {
      id: 'wk_' + crypto.randomBytes(5).toString('hex'),
      title: candidate.title,
      subtitle: folderName ? S.plain(folderName, 160) : 'Arsip Google Drive',
      type: inferredType,
      ring: targetRing,
      year,
      summary: candidate.summary,
      content: cleanText,
      coverUrl: '',
      link,
      tags: ['google-drive', ...(folderName ? [S.plain(folderName.toLowerCase(), 30)] : [])].filter(Boolean),
      status: gdCfg.autoPublish !== false ? 'published' : 'draft',
      featured: false,
      syncKnowledge: gdCfg.autoSyncKnowledge !== false,
      lang,
      order: list.length,
      createdAt: now,
      updatedAt: now,
      ringHistory: [],
      source: 'gdrive',
      gdriveFileId: fileMeta.id,
      gdriveFolderName: folderName || '',
      gdriveMimeType: fileMeta.mimeType || '',
      gdriveModifiedTime: fileMeta.modifiedTime || now,
      gdriveSyncedAt: now,
      ...(quarantined ? { quarantinedFromRing } : {})
    };
    list.push(newWork);
    syncKnowledge(newWork);
    return { action: 'added', work: newWork, quarantined };
  }

  // Synchronize all configured Google Drive folders into works.json and Ring 0..3 stores.
  async function syncFromGoogleDrive(opts = {}) {
    const gdCfg = gdrive.loadConfig();
    const list = load();
    let added = 0;
    let updated = 0;
    let quarantined = 0;
    let totalDriveFiles = 0;
    const errors = [];

    try {
      const targets = await gdrive.discoverRingFolders();
      if (!targets.length) {
        throw new Error('Belum ada Folder ID Google Drive yang dikonfigurasi (Root Folder atau Folder Ring 0–3).');
      }

      const processedFileIds = new Set();
      for (const target of targets) {
        let files = target.preloadedFiles;
        if (!files) {
          const children = await gdrive.listFolderChildren(target.folderId, 100);
          files = children.files;
        }
        for (const f of files) {
          if (!f || !f.id || processedFileIds.has(f.id)) continue;
          processedFileIds.add(f.id);
          totalDriveFiles++;
          try {
            const extracted = await gdrive.readFileContent(f);
            const res = upsertDriveFileToList(list, f, extracted.text, target.ring, target.folderName, gdCfg);
            if (res.action === 'added') added++;
            else if (res.action === 'updated') updated++;
            if (res.quarantined) {
              quarantined++;
              audit({ event: 'gdrive_work_quarantined', ring: 0, id: res.work.id, proposedRing: res.work.quarantinedFromRing });
            }
          } catch (fileErr) {
            errors.push({ fileId: f.id, name: f.name, error: String(fileErr.message || fileErr) });
          }
        }
      }

      save(list);
      const summaryObj = {
        added,
        updated,
        quarantined,
        totalDriveFiles,
        foldersScanned: targets.length,
        errors: errors.slice(0, 10)
      };
      gdCfg.lastSyncAt = new Date().toISOString();
      gdCfg.lastSyncStatus = errors.length ? 'partial' : 'ok';
      gdCfg.lastSyncSummary = summaryObj;
      gdrive.saveConfig(gdCfg);

      audit({
        event: 'gdrive_sync_completed',
        ring: 0,
        trigger: opts.trigger || 'manual',
        added,
        updated,
        quarantined,
        totalDriveFiles
      });

      return { ok: true, ...summaryObj };
    } catch (err) {
      gdCfg.lastSyncAt = new Date().toISOString();
      gdCfg.lastSyncStatus = 'error';
      gdCfg.lastSyncSummary = { error: String(err.message || err) };
      gdrive.saveConfig(gdCfg);
      throw err;
    }
  }

  const admin = {
    'GET /admin/api/works': (req, res) => {
      const list = load().sort((a, b) => a.order - b.order).map((w) => ({
        ...w,
        flagged: flaggedOf(w),
        contentLength: (w.content || '').length,
        content: undefined
      }));
      return send(res, 200, { works: list, types: TYPES, gdrive: gdrive.publicConfigView() });
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
          w.ringOverrideByAdmin = true;
          delete w.quarantinedFromRing;
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
      w.ring = toRing; w.updatedAt = now; w.ringOverrideByAdmin = true;
      delete w.quarantinedFromRing;
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
    },

    // ---------- Google Drive API v3 Integration Endpoints ----------
    'GET /admin/api/works/gdrive/config': (req, res) => {
      return send(res, 200, { gdrive: gdrive.publicConfigView() });
    },

    'POST /admin/api/works/gdrive/config': async (req, res) => {
      const b = await body(req, 256 * 1024);
      const cfg = gdrive.loadConfig();

      if (b.clearServiceAccount) {
        cfg.sealedServiceAccount = null;
        cfg.clientEmail = '';
        cfg.projectId = '';
        gdrive.clearTokenCache();
      }
      if (b.serviceAccountJson && String(b.serviceAccountJson).trim()) {
        let parsed;
        try {
          parsed = JSON.parse(String(b.serviceAccountJson).trim());
        } catch (_) {
          return send(res, 400, { error: 'invalid_service_account_json', message: 'Format JSON Service Account tidak valid.' });
        }
        if (!parsed.client_email || !parsed.private_key) {
          return send(res, 400, { error: 'incomplete_service_account_json', message: 'JSON Service Account harus memiliki client_email dan private_key.' });
        }
        cfg.sealedServiceAccount = ctx.vault.seal(JSON.stringify(parsed));
        cfg.clientEmail = String(parsed.client_email);
        cfg.projectId = String(parsed.project_id || '');
        cfg.authMode = 'service_account';
        cfg.enabled = true;
        gdrive.clearTokenCache();
      }

      if (b.clearOauth) {
        cfg.oauthClientId = '';
        cfg.sealedOauthClientSecret = null;
        cfg.sealedOauthRefreshToken = null;
        cfg.oauthRedirectUri = '';
        gdrive.clearTokenCache();
      }
      if (b.oauthClientId !== undefined && String(b.oauthClientId).trim()) {
        cfg.oauthClientId = S.plain(String(b.oauthClientId).trim(), 240);
      }
      if (b.oauthRedirectUri !== undefined) {
        cfg.oauthRedirectUri = S.plain(String(b.oauthRedirectUri).trim(), 320);
      }
      if (b.oauthClientSecret && String(b.oauthClientSecret).trim()) {
        cfg.sealedOauthClientSecret = ctx.vault.seal(String(b.oauthClientSecret).trim());
        gdrive.clearTokenCache();
      }
      if (b.oauthRefreshToken && String(b.oauthRefreshToken).trim()) {
        cfg.sealedOauthRefreshToken = ctx.vault.seal(String(b.oauthRefreshToken).trim());
        cfg.authMode = 'oauth2';
        cfg.enabled = true;
        gdrive.clearTokenCache();
      }

      if (b.clearApiKey) {
        cfg.sealedApiKey = null;
        gdrive.clearTokenCache();
      }
      if (b.apiKey && String(b.apiKey).trim()) {
        cfg.sealedApiKey = ctx.vault.seal(String(b.apiKey).trim());
        if (!cfg.sealedServiceAccount && !cfg.sealedOauthRefreshToken) cfg.authMode = 'api_key';
        cfg.enabled = true;
        gdrive.clearTokenCache();
      }

      if (b.authMode === 'service_account' || b.authMode === 'oauth2' || b.authMode === 'api_key') {
        cfg.authMode = b.authMode;
      }
      if (b.enabled !== undefined) cfg.enabled = Boolean(b.enabled);
      if (b.rootFolderId !== undefined) cfg.rootFolderId = gdrive.parseDriveId(b.rootFolderId);
      if (b.ringFolders && typeof b.ringFolders === 'object') {
        for (const r of [0, 1, 2, 3]) {
          if (b.ringFolders[r] !== undefined) {
            cfg.ringFolders[r] = gdrive.parseDriveId(b.ringFolders[r]);
          }
        }
      }
      if (b.defaultRing !== undefined && [0, 1, 2, 3].includes(Number(b.defaultRing))) {
        cfg.defaultRing = Number(b.defaultRing);
      }
      if (b.autoPublish !== undefined) cfg.autoPublish = Boolean(b.autoPublish);
      if (b.autoSyncKnowledge !== undefined) cfg.autoSyncKnowledge = Boolean(b.autoSyncKnowledge);
      if (b.autoSyncMinutes !== undefined) {
        cfg.autoSyncMinutes = Math.max(0, Math.min(1440, Math.round(Number(b.autoSyncMinutes) || 0)));
      }

      gdrive.saveConfig(cfg);
      gdrive.setupAutoSyncTimer(cfg.autoSyncMinutes, () => syncFromGoogleDrive({ trigger: 'auto' }));
      audit({ event: 'gdrive_config_updated', ring: 0, authMode: cfg.authMode, enabled: cfg.enabled });
      return send(res, 200, { ok: true, gdrive: gdrive.publicConfigView() });
    },

    'GET /admin/api/works/gdrive/oauth-url': (req, res, { url }) => {
      try {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host || 'localhost:3000';
        const origin = `${proto}://${host}`;
        const customRedir = url.searchParams.get('redirectUri') || '';
        const info = gdrive.buildOAuthConsentUrl(origin, customRedir);
        return send(res, 200, { ok: true, ...info });
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err.message || err) });
      }
    },

    'POST /admin/api/works/gdrive/oauth-exchange': async (req, res) => {
      const b = await body(req, 16000);
      try {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host || 'localhost:3000';
        const origin = `${proto}://${host}`;
        const result = await gdrive.exchangeOAuthCode(b.code, origin, b.redirectUri || '');
        audit({ event: 'gdrive_oauth_connected', ring: 0, hasRefreshToken: result.hasRefreshToken });
        return send(res, 200, { ok: true, ...result, gdrive: gdrive.publicConfigView() });
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err.message || err) });
      }
    },

    'GET /admin/api/works/gdrive/oauth-callback': async (req, res, { url }) => {
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      const oauthErr = url.searchParams.get('error') || '';
      if (oauthErr || !code) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem;"><h3>OAuth Google Drive Dibatalkan / Gagal</h3><p>${S.plain(oauthErr || 'Kode otorisasi tidak ditemukan.', 200)}</p><p><a href="/admin">Kembali ke Admin Studio</a></p></body></html>`);
        return;
      }
      const stateValid = gdrive.verifyOAuthState(state);
      if (!req.__isAuthedAdmin && !stateValid) {
        // Cross-site redirect from accounts.google.com withheld SameSite=Strict cookie;
        // perform a same-origin hop or pass code to the authenticated opener tab.
        const safeCodeJson = JSON.stringify(code);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><html><head><title>Menyelesaikan Otorisasi Google Drive...</title></head><body style="font-family:sans-serif;padding:2.5rem;background:#fdf9f1;color:#001637;"><div style="max-width:520px;margin:0 auto;background:#fff;padding:2rem;border-radius:16px;border:1px solid #c4c6d0;"><h3>Menyelesaikan Otorisasi Google Drive OAuth 2.0...</h3><p>Mohon tunggu sebentar...</p></div><script>(function(){var code=${safeCodeJson};if(window.opener){try{window.opener.postMessage({type:'gdrive:oauth-code',code:code},window.location.origin);setTimeout(function(){window.close();},1200);return;}catch(_){}}if(!location.search.includes('_so=1')){location.replace(location.pathname+location.search+'&_so=1');}})();</script></body></html>`);
        return;
      }
      try {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host || 'localhost:3000';
        const origin = `${proto}://${host}`;
        const result = await gdrive.exchangeOAuthCode(code, origin);
        audit({ event: 'gdrive_oauth_callback_connected', ring: 0, hasRefreshToken: result.hasRefreshToken });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Google Drive OAuth Terhubung</title></head><body style="font-family:sans-serif;padding:2.5rem;background:#fdf9f1;color:#001637;"><div style="max-width:520px;margin:0 auto;background:#fff;padding:2rem;border-radius:16px;border:1px solid #c4c6d0;box-shadow:0 8px 24px rgba(0,0,0,0.08);"><h2>✅ Google Drive OAuth 2.0 Berhasil Terhubung!</h2><p>Refresh Token Anda telah dienkripsi dan disimpan ke brankas AES-256-GCM Ring 0.</p><p><a href="/admin" style="display:inline-block;margin-top:1rem;padding:10px 18px;background:#001637;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Kembali ke Ring 0 Admin Studio</a></p></div><script>if(window.opener){try{window.opener.postMessage({type:'gdrive:oauth-success'},window.location.origin);setTimeout(()=>window.close(),1200);}catch(_){}}</script></body></html>`);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem;"><h3>Gagal Menukar Kode OAuth 2.0</h3><p>${S.plain(String(err.message || err), 300)}</p><p><a href="/admin">Kembali ke Admin Studio</a></p></body></html>`);
      }
    },

    'POST /admin/api/works/gdrive/test': async (req, res) => {
      const b = await body(req, 8000);
      try {
        const testFolderId = b.folderId ? gdrive.parseDriveId(b.folderId) : '';
        if (testFolderId) {
          const meta = await gdrive.getFileMeta(testFolderId);
          const children = await gdrive.listFolderChildren(testFolderId, 25);
          audit({ event: 'gdrive_connection_tested', ring: 0, ok: true });
          return send(res, 200, {
            ok: true,
            folder: { id: meta.id, name: meta.name },
            subfoldersCount: children.folders.length,
            filesCount: children.files.length,
            sampleFiles: children.files.slice(0, 8).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType }))
          });
        }

        const targets = await gdrive.discoverRingFolders();
        if (!targets.length) {
          const rootChildren = await gdrive.listFolderChildren('root', 25);
          audit({ event: 'gdrive_connection_tested', ring: 0, ok: true });
          return send(res, 200, {
            ok: true,
            folder: { id: 'root', name: 'Google Drive Utama (My Drive)' },
            subfoldersCount: rootChildren.folders.length,
            filesCount: rootChildren.files.length,
            sampleFiles: rootChildren.files.slice(0, 8).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType }))
          });
        }
        const folderSummaries = [];
        for (const t of targets) {
          const children = t.preloadedFiles
            ? { files: t.preloadedFiles, folders: [] }
            : await gdrive.listFolderChildren(t.folderId, 25);
          folderSummaries.push({
            folderId: t.folderId,
            folderName: t.folderName,
            ring: t.ring,
            filesCount: children.files.length
          });
        }
        audit({ event: 'gdrive_connection_tested', ring: 0, ok: true });
        return send(res, 200, {
          ok: true,
          targetsCount: folderSummaries.length,
          folders: folderSummaries
        });
      } catch (err) {
        audit({ event: 'gdrive_connection_tested', ring: 0, ok: false });
        return send(res, 400, { ok: false, error: String(err.message || err) });
      }
    },

    'GET /admin/api/works/gdrive/browse': async (req, res, { url }) => {
      try {
        const cfg = gdrive.loadConfig();
        const requestedId = gdrive.parseDriveId(url.searchParams.get('folderId') || '');
        const existingWorks = load();
        const byDriveId = new Map(existingWorks.filter((w) => w.gdriveFileId).map((w) => [w.gdriveFileId, w]));

        if (!requestedId) {
          // If rootFolderId is set, browse rootFolderId; otherwise return configured ring folders (or fallback to My Drive 'root')
          if (cfg.rootFolderId) {
            const meta = await gdrive.getFileMeta(cfg.rootFolderId);
            const children = await gdrive.listFolderChildren(cfg.rootFolderId, 100);
            return send(res, 200, {
              ok: true,
              currentFolder: { id: meta.id, name: meta.name, ring: gdrive.inferRingFromName(meta.name, cfg.defaultRing) },
              folders: children.folders.map((f) => ({
                ...f,
                inferredRing: gdrive.inferRingFromName(f.name, cfg.defaultRing)
              })),
              files: children.files.map((f) => {
                const sw = byDriveId.get(f.id);
                return { ...f, syncedWorkId: sw ? sw.id : null, syncedRing: sw ? sw.ring : null };
              })
            });
          }

          const targets = await gdrive.discoverRingFolders();
          if (targets.length > 0) {
            return send(res, 200, {
              ok: true,
              currentFolder: { id: '', name: 'Daftar Folder Ring Google Drive Terpetakan', ring: null },
              folders: targets.map((t) => ({
                id: t.folderId,
                name: `${t.folderName} (Ring ${t.ring})`,
                mimeType: 'application/vnd.google-apps.folder',
                inferredRing: t.ring
              })),
              files: []
            });
          }

          // When no folder ID is configured yet, automatically browse My Drive ('root') if credentials are ready
          const pubView = gdrive.publicConfigView();
          if (pubView.configured) {
            const children = await gdrive.listFolderChildren('root', 100);
            return send(res, 200, {
              ok: true,
              unconfiguredFolders: true,
              currentFolder: { id: 'root', name: 'Google Drive Utama (My Drive) — Pilih Folder Karya Anda', ring: cfg.defaultRing },
              folders: children.folders.map((f) => ({
                ...f,
                inferredRing: gdrive.inferRingFromName(f.name, cfg.defaultRing)
              })),
              files: children.files.map((f) => {
                const sw = byDriveId.get(f.id);
                return { ...f, syncedWorkId: sw ? sw.id : null, syncedRing: sw ? sw.ring : null };
              })
            });
          }

          return send(res, 200, {
            ok: true,
            currentFolder: { id: '', name: 'Daftar Folder Ring Google Drive', ring: null },
            folders: [],
            files: []
          });
        }

        const meta = await gdrive.getFileMeta(requestedId);
        const children = await gdrive.listFolderChildren(requestedId, 100);
        const folderRing = gdrive.inferRingFromName(meta.name, cfg.defaultRing);
        return send(res, 200, {
          ok: true,
          currentFolder: { id: meta.id, name: meta.name, ring: folderRing },
          folders: children.folders.map((f) => ({
            ...f,
            inferredRing: gdrive.inferRingFromName(f.name, folderRing)
          })),
          files: children.files.map((f) => {
            const sw = byDriveId.get(f.id);
            return { ...f, syncedWorkId: sw ? sw.id : null, syncedRing: sw ? sw.ring : null };
          })
        });
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err.message || err) });
      }
    },

    'POST /admin/api/works/gdrive/read-file': async (req, res) => {
      const b = await body(req, 16000);
      const fileId = gdrive.parseDriveId(b.fileId);
      if (!fileId) return send(res, 400, { error: 'invalid_file_id' });
      try {
        const result = await gdrive.readFileContent(fileId);
        let imported = null;
        if (b.importWork) {
          const gdCfg = gdrive.loadConfig();
          const list = load();
          const targetRing = [0, 1, 2, 3].includes(Number(b.ring)) ? Number(b.ring) : gdCfg.defaultRing;
          imported = upsertDriveFileToList(list, result.meta, result.text, targetRing, b.folderName || '', gdCfg);
          save(list);
          audit({ event: 'gdrive_file_imported', ring: 0, id: imported.work.id, workRing: imported.work.ring, quarantined: imported.quarantined });
        }
        return send(res, 200, {
          ok: true,
          file: result.meta,
          text: result.text,
          extracted: result.extracted,
          imported: imported ? { action: imported.action, quarantined: imported.quarantined, work: { ...imported.work, flagged: flaggedOf(imported.work) } } : null
        });
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err.message || err) });
      }
    },

    'POST /admin/api/works/gdrive/sync': async (req, res) => {
      try {
        const result = await syncFromGoogleDrive({ trigger: 'manual' });
        const list = load().sort((a, b) => a.order - b.order).map((w) => ({
          ...w,
          flagged: flaggedOf(w),
          contentLength: (w.content || '').length,
          content: undefined
        }));
        return send(res, 200, { ...result, works: list, gdrive: gdrive.publicConfigView() });
      } catch (err) {
        return send(res, 400, { ok: false, error: String(err.message || err) });
      }
    },

    'POST /admin/api/works/summarize': async (req, res) => {
      const b = await body(req, 512 * 1024);
      const list = load();
      const w = b.id ? list.find((x) => x.id === b.id) : null;
      const rawTitle = S.plain(b.title || (w && w.title) || 'Karya Andrew Tani', 200);
      const rawContent = String(b.content !== undefined ? b.content : ((w && w.content) || '')).trim();
      if (!rawContent) {
        return send(res, 400, { error: 'empty_content', message: 'Isi naskah/kutipan karya masih kosong.' });
      }
      const lang = (b.lang || (w && w.lang) || 'id') === 'en' ? 'en' : 'id';
      const prompt = lang === 'en'
        ? `Summarize the core leadership wisdom of the manuscript "${rawTitle}" in 2 to 3 concise executive sentences:`
        : `Buatkan ikhtisar eksekutif dalam 2 hingga 3 kalimat bernas yang merangkum intisari kebijaksanaan kepemimpinan dari naskah "${rawTitle}":`;

      let summaryText = '';
      let mode = 'extractive';
      if (ctx.ai && typeof ctx.ai.generate === 'function') {
        const gen = await ctx.ai.generate({
          askerRing: w ? w.ring : 0,
          lang,
          question: prompt,
          context: `[${rawTitle}]\n${rawContent.slice(0, 12000)}`,
          source: 'works_summarize'
        });
        if (gen && gen.ok && gen.text) {
          summaryText = S.plain(gen.text, 1200);
          mode = 'claude';
        }
      }
      if (!summaryText) {
        const sentences = rawContent
          .replace(/\s+/g, ' ')
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 35);
        summaryText = S.plain((sentences.slice(0, 3).join(' ') || rawContent.slice(0, 360)), 1200);
        mode = 'extractive';
      }

      if (w && b.save) {
        w.summary = summaryText;
        w.updatedAt = new Date().toISOString();
        syncKnowledge(w);
        save(list);
      }
      audit({ event: 'work_summarized', ring: 0, id: w ? w.id : 'draft', mode });
      return send(res, 200, { ok: true, mode, summary: summaryText });
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
    let fromDrive = 0;
    for (const w of list) {
      byRing[w.ring] = (byRing[w.ring] || 0) + 1;
      if (w.gdriveFileId || w.source === 'gdrive') fromDrive++;
    }
    const gdView = gdrive.publicConfigView();
    return {
      total: list.length,
      byRing,
      published: list.filter((w) => w.status === 'published').length,
      fromDrive,
      gdriveConfigured: gdView.configured,
      gdriveLastSyncAt: gdView.lastSyncAt
    };
  }

  return { ensure, admin, pub, summary, TYPES, gdrive, syncFromGoogleDrive };
};
