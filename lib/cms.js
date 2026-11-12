'use strict';
// Ring 0 Studio — Website editor (draft → publish with version history) and Media library.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./sanitize');

const THEME_TOKENS = ['primary', 'primary-container', 'secondary', 'tertiary-fixed', 'on-tertiary-container', 'surface',
  'surface-container-low', 'surface-container', 'surface-container-high', 'on-surface', 'on-surface-variant', 'outline'];
const KEY_RE = /^#[A-Za-z][\w-]{0,80}(\/[a-z0-9]{1,12}\[\d{1,3}\]){0,24}$/;
const MAGIC = [
  { ext: 'png', mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { ext: 'avif', mime: 'image/avif', test: (b) => b.slice(4, 12).toString('ascii').startsWith('ftypavi') },
  { ext: 'ico', mime: 'image/x-icon', test: (b) => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 }
];
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon' };

const emptyDoc = () => ({
  elements: {},
  layout: { order: [], hidden: [] },
  blocks: [],
  theme: { colors: {}, fonts: {}, customCss: '' },
  seo: {},
  settings: { worksOnHome: false, pricingOnHome: false, fontScale: 'small', fontScope: 'both' }
});

module.exports = function createCms(ctx) {
  const { DATA, readJson, writeJson, audit, send, body } = ctx;
  const siteFile = () => path.join(DATA, 'site-content.json');
  const mediaDir = () => path.join(DATA, 'media');
  const mediaIndex = () => path.join(DATA, 'media.json');

  function ensure() {
    fs.mkdirSync(mediaDir(), { recursive: true });
    if (!fs.existsSync(siteFile())) writeJson(siteFile(), { draft: emptyDoc(), published: emptyDoc(), publishedAt: null, updatedAt: null, versions: [] });
    if (!fs.existsSync(mediaIndex())) writeJson(mediaIndex(), []);
  }
  const loadSite = () => { ensure(); return readJson(siteFile()); };
  const saveSite = (v) => writeJson(siteFile(), v);
  const loadMedia = () => { ensure(); return readJson(mediaIndex()); };
  const saveMedia = (v) => writeJson(mediaIndex(), v);

  // ---------- sanitizers ----------
  function i18nText(v, fn) {
    if (v == null) return undefined;
    if (typeof v === 'string') return { all: fn(v) };
    const o = {};
    for (const k of ['all', 'id', 'en']) if (typeof v[k] === 'string') o[k] = fn(v[k]);
    return Object.keys(o).length ? o : undefined;
  }

  function sanitizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const o = {};
    const t = i18nText(e.text, S.sanitizeInline); if (t) o.text = t;
    const p = i18nText(e.placeholder, (x) => S.plain(x, 300)); if (p) o.placeholder = p;
    if (e.src) { const s = S.safeImageUrl(e.src); if (s) o.src = s; }
    if (e.alt != null && e.alt !== '') o.alt = S.plain(e.alt, 300);
    if (e.href) { const h = S.safeUrl(e.href); if (h) o.href = h; }
    if (e.style) { const st = S.sanitizeStyle(e.style); if (Object.keys(st).length) o.style = st; }
    if (e.hidden === true) o.hidden = true;
    if (e.label) o.label = S.plain(e.label, 120);
    return Object.keys(o).length ? o : null;
  }

  const sectionId = (s) => (/^[A-Za-z][\w-]{0,80}$/.test(String(s)) ? String(s) : null);

  function sanitizeDocPart(part, value, current) {
    switch (part) {
      case 'layout': {
        const order = (Array.isArray(value && value.order) ? value.order : []).map(sectionId).filter(Boolean).slice(0, 60);
        const hidden = (Array.isArray(value && value.hidden) ? value.hidden : []).map(sectionId).filter(Boolean).slice(0, 60);
        return { order, hidden };
      }
      case 'blocks':
        return (Array.isArray(value) ? value : []).slice(0, 40).map((b) => ({
          id: /^blk_[a-f0-9]{6,16}$/.test(b.id) ? b.id : 'blk_' + crypto.randomBytes(5).toString('hex'),
          label: S.plain(b.label || 'Blok Kustom', 80),
          after: sectionId(b.after) || '',
          hidden: b.hidden === true,
          html: S.sanitizeBlock(b.html || '')
        }));
      case 'theme': {
        const colors = {};
        for (const [k, v] of Object.entries((value && value.colors) || {})) {
          if (THEME_TOKENS.includes(k) && /^#[0-9a-fA-F]{6}$/.test(String(v))) colors[k] = String(v).toLowerCase();
        }
        const fonts = {};
        for (const k of ['serif', 'sans', 'consistentAll']) {
          const f = value && value.fonts && value.fonts[k];
          if (f && /^[A-Za-z0-9 ]{2,40}$/.test(f)) fonts[k] = f;
        }
        const radius = value && /^\d{1,2}$/.test(String(value.radius ?? '')) ? Number(value.radius) : undefined;
        return { colors, fonts, customCss: S.sanitizeCss(value && value.customCss), ...(radius !== undefined ? { radius } : {}) };
      }
      case 'seo': {
        const prev = (current && typeof current === 'object') ? current : {};
        return {
          title: value && value.title !== undefined ? S.plain(value.title, 120) : (prev.title || ''),
          titleEn: value && value.titleEn !== undefined ? S.plain(value.titleEn, 120) : (prev.titleEn || ''),
          description: value && value.description !== undefined ? S.plain(value.description, 320) : (prev.description || ''),
          ogImage: value && value.ogImage !== undefined ? S.safeImageUrl(value.ogImage) : (prev.ogImage || ''),
          favicon: value && value.favicon !== undefined ? S.safeImageUrl(value.favicon) : (prev.favicon || '')
        };
      }
      case 'settings': {
        const validScales = ['small', 'medium', 'large', 'xlarge'];
        const validScopes = ['both', 'frontpage', 'admin'];
        const fontScale = validScales.includes(value && value.fontScale)
          ? value.fontScale
          : ((current && validScales.includes(current.fontScale)) ? current.fontScale : 'small');
        const fontScope = validScopes.includes(value && value.fontScope)
          ? value.fontScope
          : ((current && validScopes.includes(current.fontScope)) ? current.fontScope : 'both');
        return {
          ...current,
          worksOnHome: value && value.worksOnHome !== undefined ? Boolean(value.worksOnHome) : Boolean(current && current.worksOnHome),
          pricingOnHome: value && value.pricingOnHome !== undefined ? Boolean(value.pricingOnHome) : Boolean(current && current.pricingOnHome),
          announcement: value && value.announcement !== undefined ? S.sanitizeInline(value.announcement || '') : ((current && current.announcement) || ''),
          maintenance: value && value.maintenance !== undefined ? Boolean(value.maintenance) : Boolean(current && current.maintenance),
          fontScale,
          fontScope
        };
      }
      default:
        return current;
    }
  }

  // ---------- media helpers ----------
  function storeImage(b) {
    const raw = String(b.data || '').replace(/^data:[\w/+.-]+;base64,/, '');
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length || buf.length > 15 * 1024 * 1024) return { error: 'bad_size' };
    const kind = MAGIC.find((m) => m.test(buf));
    if (!kind) return { error: 'unsupported_type' };
    const id = 'img_' + crypto.randomBytes(6).toString('hex');
    const file = id + '.' + kind.ext;
    fs.writeFileSync(path.join(mediaDir(), file), buf);
    const item = {
      id, file, url: '/media/' + file, mime: kind.mime, size: buf.length,
      name: S.plain(b.filename || file, 160),
      alt: S.plain(b.alt || '', 300),
      tags: (Array.isArray(b.tags) ? b.tags : []).map((t) => S.plain(t, 40)).filter(Boolean).slice(0, 12),
      width: Number(b.width) || null, height: Number(b.height) || null,
      uploadedAt: new Date().toISOString()
    };
    const list = loadMedia(); list.unshift(item); saveMedia(list);
    return { item };
  }

  function serveMedia(req, res, pathname) {
    const m = /^\/media\/([a-z0-9_]+\.(png|jpe?g|gif|webp|avif|ico))$/i.exec(pathname);
    if (!m) return false;
    const f = path.join(mediaDir(), m[1]);
    if (!fs.existsSync(f)) { send(res, 404, { error: 'not_found' }); return true; }
    res.writeHead(200, {
      'content-type': MIME_BY_EXT[m[2].toLowerCase()],
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'"
    });
    res.end(fs.readFileSync(f));
    return true;
  }

  // ---------- routes ----------
  const admin = {
    'GET /admin/api/site': (req, res) => {
      const s = loadSite();
      return send(res, 200, {
        draft: s.draft, published: s.published, publishedAt: s.publishedAt, updatedAt: s.updatedAt,
        dirty: JSON.stringify(s.draft) !== JSON.stringify(s.published),
        versions: s.versions.map((v) => ({ id: v.id, at: v.at, note: v.note, changes: Object.keys(v.snapshot.elements || {}).length }))
      });
    },

    'POST /admin/api/site/draft': async (req, res) => {
      const b = await body(req, 2 * 1024 * 1024);
      const s = loadSite();
      let changed = 0;
      if (b.elements && typeof b.elements === 'object') {
        for (const [k, v] of Object.entries(b.elements)) {
          if (!KEY_RE.test(k)) continue;
          const clean = v === null ? null : sanitizeEntry(v);
          if (clean) s.draft.elements[k] = clean; else delete s.draft.elements[k];
          changed++;
        }
      }
      for (const part of ['layout', 'blocks', 'theme', 'seo', 'settings']) {
        if (b[part] !== undefined) { s.draft[part] = sanitizeDocPart(part, b[part], s.draft[part]); changed++; }
      }
      s.updatedAt = new Date().toISOString();
      saveSite(s);
      return send(res, 200, { ok: true, changed, draft: s.draft, updatedAt: s.updatedAt, dirty: JSON.stringify(s.draft) !== JSON.stringify(s.published) });
    },

    'POST /admin/api/site/publish': async (req, res) => {
      const b = await body(req, 4000);
      const s = loadSite();
      const at = new Date().toISOString();
      s.versions.unshift({ id: 'v_' + crypto.randomBytes(4).toString('hex'), at, note: S.plain(b.note || 'Publikasi', 160), snapshot: JSON.parse(JSON.stringify(s.draft)) });
      s.versions = s.versions.slice(0, 30);
      s.published = JSON.parse(JSON.stringify(s.draft));
      s.publishedAt = at;
      saveSite(s);
      audit({ event: 'site_published', ring: 0, elements: Object.keys(s.published.elements).length });
      return send(res, 200, { ok: true, publishedAt: at });
    },

    'POST /admin/api/site/discard': async (req, res) => {
      const s = loadSite();
      s.draft = JSON.parse(JSON.stringify(s.published));
      s.updatedAt = new Date().toISOString();
      saveSite(s);
      audit({ event: 'site_draft_discarded', ring: 0 });
      return send(res, 200, { ok: true, draft: s.draft });
    },

    'POST /admin/api/site/restore': async (req, res) => {
      const b = await body(req, 2000);
      const s = loadSite();
      const v = s.versions.find((x) => x.id === b.versionId);
      if (!v) return send(res, 404, { error: 'not_found' });
      s.draft = JSON.parse(JSON.stringify(v.snapshot));
      s.updatedAt = new Date().toISOString();
      saveSite(s);
      audit({ event: 'site_version_restored', ring: 0, version: v.id });
      return send(res, 200, { ok: true, draft: s.draft });
    },

    'POST /admin/api/site/reset-all': async (req, res) => {
      const s = loadSite();
      s.draft = emptyDoc();
      s.updatedAt = new Date().toISOString();
      saveSite(s);
      audit({ event: 'site_draft_reset', ring: 0 });
      return send(res, 200, { ok: true, draft: s.draft });
    },

    // Instant typography scale & scope update (applies immediately to both draft and published site settings)
    'POST /admin/api/site/typography': async (req, res) => {
      const b = await body(req, 4000);
      const validScales = ['small', 'medium', 'large', 'xlarge'];
      const validScopes = ['both', 'frontpage', 'admin'];
      const s = loadSite();
      s.draft.settings = s.draft.settings || {};
      s.published.settings = s.published.settings || {};
      if (validScales.includes(b.fontScale)) {
        s.draft.settings.fontScale = b.fontScale;
        s.published.settings.fontScale = b.fontScale;
      }
      if (validScopes.includes(b.fontScope)) {
        s.draft.settings.fontScope = b.fontScope;
        s.published.settings.fontScope = b.fontScope;
      }
      s.updatedAt = new Date().toISOString();
      saveSite(s);
      audit({ event: 'site_typography_updated', ring: 0, fontScale: s.draft.settings.fontScale, fontScope: s.draft.settings.fontScope });
      return send(res, 200, {
        ok: true,
        fontScale: s.draft.settings.fontScale || 'small',
        fontScope: s.draft.settings.fontScope || 'both',
        draft: s.draft
      });
    },

    // Instant web information & browser tab metadata update (saves & publishes seo immediately)
    'POST /admin/api/site/web-info': async (req, res) => {
      const b = await body(req, 32000);
      const s = loadSite();
      const nextSeo = sanitizeDocPart('seo', b.seo || b, s.draft.seo);
      s.draft.seo = nextSeo;
      s.published.seo = JSON.parse(JSON.stringify(nextSeo));
      const at = new Date().toISOString();
      s.updatedAt = at;
      s.publishedAt = at;
      saveSite(s);
      audit({ event: 'site_web_info_updated', ring: 0, hasFavicon: Boolean(nextSeo.favicon) });
      return send(res, 200, { ok: true, seo: nextSeo, publishedAt: at, draft: s.draft });
    },

    // Instant consistent font family update across the entire website (updates draft & published theme.fonts)
    'POST /admin/api/site/fonts': async (req, res) => {
      const b = await body(req, 8000);
      const s = loadSite();
      s.draft.theme = s.draft.theme || { colors: {}, fonts: {}, customCss: '' };
      s.published.theme = s.published.theme || { colors: {}, fonts: {}, customCss: '' };
      const cleanFonts = {};
      const srcFonts = (b && b.fonts) ? b.fonts : b;
      for (const k of ['serif', 'sans', 'consistentAll']) {
        const f = srcFonts && srcFonts[k];
        if (f && /^[A-Za-z0-9 ]{2,40}$/.test(String(f).trim())) {
          cleanFonts[k] = String(f).trim();
        }
      }
      // If consistentAll is chosen, also align serif & sans to consistentAll unless explicitly overridden
      if (cleanFonts.consistentAll) {
        if (!cleanFonts.serif) cleanFonts.serif = cleanFonts.consistentAll;
        if (!cleanFonts.sans) cleanFonts.sans = cleanFonts.consistentAll;
      }
      s.draft.theme.fonts = cleanFonts;
      s.published.theme.fonts = JSON.parse(JSON.stringify(cleanFonts));
      const at = new Date().toISOString();
      s.updatedAt = at;
      s.publishedAt = at;
      saveSite(s);
      audit({ event: 'site_fonts_updated', ring: 0, consistentAll: cleanFonts.consistentAll || null, serif: cleanFonts.serif || null, sans: cleanFonts.sans || null });
      return send(res, 200, { ok: true, fonts: cleanFonts, publishedAt: at, draft: s.draft });
    },

    // Draft content for the same-origin preview frame inside the admin studio
    'GET /api/site-content': (req, res) => {
      const s = loadSite();
      return send(res, 200, { ...s.draft, preview: true, publishedAt: s.publishedAt });
    },

    'GET /admin/api/media': (req, res) => send(res, 200, { media: loadMedia() }),

    'POST /admin/api/media': async (req, res) => {
      const b = await body(req, 22 * 1024 * 1024);
      const r = storeImage(b);
      if (r.error) return send(res, 400, { error: r.error });
      audit({ event: 'media_uploaded', ring: 0, id: r.item.id, size: r.item.size });
      return send(res, 200, { ok: true, item: r.item });
    },

    'POST /admin/api/media/update': async (req, res) => {
      const b = await body(req, 8000);
      const list = loadMedia();
      const it = list.find((m) => m.id === b.id);
      if (!it) return send(res, 404, { error: 'not_found' });
      if (b.alt !== undefined) it.alt = S.plain(b.alt, 300);
      if (b.name !== undefined) it.name = S.plain(b.name, 160);
      if (Array.isArray(b.tags)) it.tags = b.tags.map((t) => S.plain(t, 40)).filter(Boolean).slice(0, 12);
      saveMedia(list);
      return send(res, 200, { ok: true, item: it });
    },

    'POST /admin/api/media/delete': async (req, res) => {
      const b = await body(req, 2000);
      const list = loadMedia();
      const i = list.findIndex((m) => m.id === b.id);
      if (i < 0) return send(res, 404, { error: 'not_found' });
      const [it] = list.splice(i, 1);
      const f = path.join(mediaDir(), it.file);
      if (fs.existsSync(f)) fs.unlinkSync(f);
      saveMedia(list);
      // report where it was still referenced so the editor can warn
      const s = loadSite();
      const refs = Object.entries(s.draft.elements).filter(([, e]) => e.src === it.url).map(([k]) => k);
      audit({ event: 'media_deleted', ring: 0, id: it.id });
      return send(res, 200, { ok: true, stillReferencedBy: refs });
    }
  };

  const pub = {
    'GET /api/site-content': (req, res) => {
      const s = loadSite();
      return send(res, 200, { ...s.published, publishedAt: s.publishedAt });
    }
  };

  function summary() {
    const s = loadSite();
    return {
      overrides: Object.keys(s.published.elements).length,
      draftOverrides: Object.keys(s.draft.elements).length,
      dirty: JSON.stringify(s.draft) !== JSON.stringify(s.published),
      publishedAt: s.publishedAt,
      media: loadMedia().length
    };
  }

  return { ensure, admin, pub, serveMedia, summary, loadSite, loadMedia, THEME_TOKENS };
};
