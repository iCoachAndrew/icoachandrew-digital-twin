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

const LINK_KEYS = [
  'book1Shopee', 'book1Tokopedia', 'book1Gramedia',
  'book2Shopee', 'book2Tokopedia', 'book2Gramedia',
  'whatsapp', 'linkedin', 'facebook', 'instagram'
];

const DEFAULT_WHAT_THEY_SAY_VIDEOS = [
  { id: 'wts_1', name: 'Edwin Soeryadjaya', youtubeId: 'VBdAdIIgB34', url: 'https://www.youtube.com/watch?v=VBdAdIIgB34' },
  { id: 'wts_2', name: 'Hasnul Suhaimi', youtubeId: 'dTFxKrsPRbU', url: 'https://www.youtube.com/watch?v=dTFxKrsPRbU' },
  { id: 'wts_3', name: 'Franky Welirang', youtubeId: 'FCKq-B-0YgE', url: 'https://www.youtube.com/watch?v=FCKq-B-0YgE' },
  { id: 'wts_4', name: 'Tedy Djuhar', youtubeId: 'xdGuQeidPKI', url: 'https://www.youtube.com/watch?v=xdGuQeidPKI' },
  { id: 'wts_5', name: 'Sandiaga Uno', youtubeId: 'xJNlJU0FsKg', url: 'https://www.youtube.com/watch?v=xJNlJU0FsKg' },
  { id: 'wts_6', name: 'Richard Buntario', youtubeId: 'LWu2OXB3ZwI', url: 'https://www.youtube.com/watch?v=LWu2OXB3ZwI' }
];

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_ALLOWED_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

function extractYoutubeId(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 500 || /[\x00-\x1f\x7f]/.test(s)) return null;
  if (YT_ID_RE.test(s)) return s;
  let candidate = s;
  if (!/^https?:\/\//i.test(candidate) && /^(www\.|m\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(candidate)) {
    candidate = 'https://' + candidate;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    if (!YT_ALLOWED_HOSTS.has(host)) return null;
    let id = '';
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = (u.pathname.replace(/^\/+/, '').split('/')[0] || '').trim();
    } else if (u.pathname === '/watch') {
      id = (u.searchParams.get('v') || '').trim();
    } else {
      const m = /^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname);
      if (m) id = m[2];
    }
    return YT_ID_RE.test(id) ? id : null;
  } catch (_) {
    return null;
  }
}

const cloneDefaultWts = () => ({ videos: DEFAULT_WHAT_THEY_SAY_VIDEOS.map((v) => ({ ...v })) });

const emptyDoc = () => ({
  elements: {},
  layout: { order: [], hidden: [] },
  blocks: [],
  theme: { colors: {}, fonts: {}, customCss: '' },
  seo: {},
  links: {},
  whatTheySay: cloneDefaultWts(),
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
  const loadSite = () => {
    ensure();
    const s = readJson(siteFile());
    if (s.draft && !s.draft.whatTheySay) s.draft.whatTheySay = cloneDefaultWts();
    if (s.published && !s.published.whatTheySay) s.published.whatTheySay = cloneDefaultWts();
    return s;
  };
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
    const prRaw = i18nText(e.prompt, (x) => S.plain(x, 1200));
    if (prRaw) {
      const pr = {};
      for (const [k, v] of Object.entries(prRaw)) if (String(v || '').trim()) pr[k] = String(v).trim();
      if (Object.keys(pr).length) o.prompt = pr;
    }
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
      case 'links': {
        const prev = (current && typeof current === 'object') ? current : {};
        const out = {};
        for (const k of LINK_KEYS) {
          if (value && value[k] !== undefined) {
            const raw = String(value[k] || '').trim();
            if (raw === '') {
              out[k] = '';
            } else {
              const clean = S.safeUrl(raw);
              if (clean) out[k] = clean;
              else if (prev[k] !== undefined) out[k] = prev[k];
            }
          } else if (prev[k] !== undefined) {
            out[k] = prev[k];
          }
        }
        return out;
      }
      case 'whatTheySay': {
        const list = Array.isArray(value && value.videos) ? value.videos : (Array.isArray(value) ? value : null);
        if (!list) return (current && Array.isArray(current.videos)) ? current : cloneDefaultWts();
        const videos = [];
        const seenIds = new Set();
        for (const item of list.slice(0, 24)) {
          if (!item || typeof item !== 'object') continue;
          const name = S.plain(item.name || '', 120);
          const youtubeId = extractYoutubeId(item.youtubeId || item.url || '');
          if (!name || !youtubeId) continue;
          let id = /^[A-Za-z0-9_-]{2,24}$/.test(String(item.id || ''))
            ? String(item.id)
            : ('wts_' + crypto.randomBytes(4).toString('hex'));
          while (seenIds.has(id)) id = 'wts_' + crypto.randomBytes(4).toString('hex');
          seenIds.add(id);
          videos.push({
            id,
            name,
            youtubeId,
            url: 'https://www.youtube.com/watch?v=' + youtubeId
          });
        }
        return { videos };
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
        const fontScaleExplicit = (value && value.fontScaleExplicit !== undefined)
          ? Boolean(value.fontScaleExplicit)
          : Boolean((value && validScales.includes(value.fontScale)) || (current && current.fontScaleExplicit));
        return {
          ...current,
          worksOnHome: value && value.worksOnHome !== undefined ? Boolean(value.worksOnHome) : Boolean(current && current.worksOnHome),
          pricingOnHome: value && value.pricingOnHome !== undefined ? Boolean(value.pricingOnHome) : Boolean(current && current.pricingOnHome),
          announcement: value && value.announcement !== undefined ? S.sanitizeInline(value.announcement || '') : ((current && current.announcement) || ''),
          maintenance: value && value.maintenance !== undefined ? Boolean(value.maintenance) : Boolean(current && current.maintenance),
          fontScale,
          fontScope,
          fontScaleExplicit
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

  function canonicalJson(val) {
    if (val === null || typeof val !== 'object') return JSON.stringify(val);
    if (Array.isArray(val)) return '[' + val.map(canonicalJson).join(',') + ']';
    const keys = Object.keys(val).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}';
  }
  const isDirty = (s) => canonicalJson(s.draft) !== canonicalJson(s.published);

  // ---------- routes ----------
  const admin = {
    'GET /admin/api/site': (req, res) => {
      const s = loadSite();
      return send(res, 200, {
        draft: s.draft, published: s.published, publishedAt: s.publishedAt, updatedAt: s.updatedAt,
        dirty: isDirty(s),
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
      for (const part of ['layout', 'blocks', 'theme', 'seo', 'links', 'whatTheySay', 'settings']) {
        if (b[part] !== undefined) { s.draft[part] = sanitizeDocPart(part, b[part], s.draft[part]); changed++; }
      }
      s.updatedAt = new Date().toISOString();
      saveSite(s);
      return send(res, 200, { ok: true, changed, draft: s.draft, updatedAt: s.updatedAt, dirty: isDirty(s) });
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
      if (!s.draft.whatTheySay) s.draft.whatTheySay = cloneDefaultWts();
      s.updatedAt = new Date().toISOString();
      saveSite(s);
      audit({ event: 'site_version_restored', ring: 0, version: v.id });
      return send(res, 200, { ok: true, draft: s.draft });
    },

    'POST /admin/api/site/reset-all': async (req, res) => {
      const s = loadSite();
      const prevSettings = (s.draft && s.draft.settings) || (s.published && s.published.settings) || {};
      const prevFonts = (s.draft && s.draft.theme && s.draft.theme.fonts) || (s.published && s.published.theme && s.published.theme.fonts) || {};
      s.draft = emptyDoc();
      // Preserve saved font scale, scope, and font families unless explicitly changed via font controls
      if (prevSettings.fontScale) s.draft.settings.fontScale = prevSettings.fontScale;
      if (prevSettings.fontScope) s.draft.settings.fontScope = prevSettings.fontScope;
      if (prevSettings.fontScaleExplicit) s.draft.settings.fontScaleExplicit = true;
      if (prevFonts && Object.keys(prevFonts).length) s.draft.theme.fonts = { ...prevFonts };
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
      s.draft.settings.fontScaleExplicit = true;
      s.published.settings.fontScaleExplicit = true;
      const at = new Date().toISOString();
      s.updatedAt = at;
      s.publishedAt = at;
      saveSite(s);
      audit({ event: 'site_typography_updated', ring: 0, fontScale: s.draft.settings.fontScale, fontScope: s.draft.settings.fontScope });
      return send(res, 200, {
        ok: true,
        fontScale: s.draft.settings.fontScale || 'small',
        fontScope: s.draft.settings.fontScope || 'both',
        fontScaleExplicit: true,
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

    // Instant marketplace & social media URL links update (saves & publishes immediately)
    'POST /admin/api/site/links': async (req, res) => {
      const b = await body(req, 16000);
      const s = loadSite();
      const src = (b && b.links && typeof b.links === 'object') ? b.links : (b || {});
      const rejected = [];
      for (const k of LINK_KEYS) {
        if (src[k] !== undefined) {
          const raw = String(src[k] || '').trim();
          if (raw !== '' && !S.safeUrl(raw)) rejected.push(k);
        }
      }
      const nextLinks = sanitizeDocPart('links', src, s.draft.links);
      s.draft.links = nextLinks;
      s.published.links = JSON.parse(JSON.stringify(nextLinks));
      const at = new Date().toISOString();
      s.updatedAt = at;
      s.publishedAt = at;
      saveSite(s);
      audit({ event: 'site_links_updated', ring: 0, count: Object.keys(nextLinks).length, rejectedCount: rejected.length });
      return send(res, 200, { ok: true, links: nextLinks, rejected, dirty: isDirty(s), publishedAt: at, draft: s.draft });
    },

    // Instant What They Say video testimonials update (saves & publishes immediately)
    'POST /admin/api/site/what-they-say': async (req, res) => {
      const b = await body(req, 32000);
      const s = loadSite();
      let nextWts;
      const rejected = [];
      if (b && b.reset === true) {
        nextWts = cloneDefaultWts();
      } else {
        const rawList = Array.isArray(b && b.videos) ? b.videos : (Array.isArray(b && b.whatTheySay && b.whatTheySay.videos) ? b.whatTheySay.videos : null);
        if (!rawList) return send(res, 400, { error: 'invalid_videos_payload' });
        rawList.slice(0, 24).forEach((item, idx) => {
          const name = S.plain((item && item.name) || '', 120);
          const ytId = extractYoutubeId((item && (item.youtubeId || item.url)) || '');
          if (!name || !ytId) rejected.push({ index: idx, name: name || `#${idx + 1}` });
        });
        nextWts = sanitizeDocPart('whatTheySay', { videos: rawList }, s.draft.whatTheySay);
        // Fail closed: do not wipe live videos if caller submitted items and every single one was invalid
        if (rawList.length > 0 && nextWts.videos.length === 0) {
          return send(res, 400, { error: 'no_valid_videos', rejected });
        }
      }
      s.draft.whatTheySay = nextWts;
      s.published.whatTheySay = JSON.parse(JSON.stringify(nextWts));
      const at = new Date().toISOString();
      s.updatedAt = at;
      s.publishedAt = at;
      saveSite(s);
      audit({ event: 'site_what_they_say_updated', ring: 0, count: nextWts.videos.length, rejectedCount: rejected.length });
      return send(res, 200, { ok: true, whatTheySay: nextWts, rejected, dirty: isDirty(s), publishedAt: at, draft: s.draft });
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
      dirty: isDirty(s),
      linksCount: Object.keys((s.published && s.published.links) || {}).length,
      whatTheySayVideos: ((s.published && s.published.whatTheySay && s.published.whatTheySay.videos) || DEFAULT_WHAT_THEY_SAY_VIDEOS).length,
      publishedAt: s.publishedAt,
      media: loadMedia().length
    };
  }

  return { ensure, admin, pub, serveMedia, summary, loadSite, loadMedia, THEME_TOKENS, DEFAULT_WHAT_THEY_SAY_VIDEOS, extractYoutubeId };
};
