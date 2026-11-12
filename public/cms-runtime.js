/* iCoachAndrew Ring 0 Studio — Live Website Runtime & Visual Canvas Bridge */
(function () {
  'use strict';

  const isStudio = window.self !== window.top && new URLSearchParams(window.location.search).get('studio') === '1';
  let siteDoc = null;
  let worksList = null;
  let pricingData = null;
  let selectedEl = null;
  let selectedKey = null;
  let hoverEl = null;
  let studioMode = 'inspect'; // 'inspect' | 'navigate'
  const originals = new Map();

  function sanitizeHtml(raw) {
    if (raw == null) return '';
    const str = String(raw);
    if (typeof DOMParser === 'undefined') {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    const doc = new DOMParser().parseFromString('<body>' + str + '</body>', 'text/html');
    const blockedTags = new Set(['script', 'iframe', 'object', 'embed', 'svg', 'math', 'style', 'link', 'meta', 'base', 'form', 'template', 'noscript']);
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (blockedTags.has(tag)) {
            child.remove();
            continue;
          }
          for (const attr of Array.from(child.attributes)) {
            const name = attr.name.toLowerCase();
            const val = String(attr.value || '').trim();
            if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
              child.removeAttribute(attr.name);
            } else if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') && /^(javascript|vbscript|data\s*:\s*text\/html)/i.test(val)) {
              child.removeAttribute(attr.name);
            }
          }
          walk(child);
        }
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }

  // ---------- Stable DOM key generator & resolver ----------
  function computeKey(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    if (el.id && /^[A-Za-z][\w-]{0,80}$/.test(el.id)) return '#' + el.id;
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 24) {
      if (cur.id && /^[A-Za-z][\w-]{0,80}$/.test(cur.id)) {
        parts.unshift('#' + cur.id);
        return parts.join('/');
      }
      const parent = cur.parentElement;
      if (!parent) break;
      const tag = cur.tagName.toLowerCase();
      const sameTagSiblings = Array.from(parent.children).filter(
        (c) => c.tagName.toLowerCase() === tag && !c.hasAttribute('data-cms-injected')
      );
      const idx = sameTagSiblings.indexOf(cur);
      if (idx < 0) break;
      parts.unshift(tag + '[' + idx + ']');
      cur = parent;
    }
    return null;
  }

  function resolveKey(key) {
    if (!key || !key.startsWith('#')) return null;
    const segs = key.split('/');
    const rootId = segs[0].slice(1);
    let cur = document.getElementById(rootId);
    if (!cur) return null;
    for (let i = 1; i < segs.length; i++) {
      const m = /^([a-z0-9]+)\[(\d+)\]$/.exec(segs[i]);
      if (!m) return null;
      const tag = m[1];
      const idx = Number(m[2]);
      const matches = Array.from(cur.children).filter(
        (c) => c.tagName.toLowerCase() === tag && !c.hasAttribute('data-cms-injected')
      );
      cur = matches[idx];
      if (!cur) return null;
    }
    return cur;
  }

  function rememberOriginal(key, el) {
    if (originals.has(key) || !el) return;
    originals.set(key, {
      html: el.innerHTML,
      src: el.tagName === 'IMG' ? el.getAttribute('src') : null,
      alt: el.tagName === 'IMG' ? el.getAttribute('alt') : null,
      href: el.tagName === 'A' ? el.getAttribute('href') : null,
      placeholder: el.getAttribute('placeholder'),
      styleCss: el.getAttribute('style') || ''
    });
  }

  function restoreOriginals() {
    for (const [key, orig] of originals.entries()) {
      const el = resolveKey(key);
      if (!el) continue;
      if (el.tagName === 'IMG') {
        if (orig.src !== null) el.setAttribute('src', orig.src);
        if (orig.alt !== null) el.setAttribute('alt', orig.alt);
      } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (orig.placeholder !== null) el.setAttribute('placeholder', orig.placeholder);
      } else {
        el.innerHTML = orig.html;
      }
      if (el.tagName === 'A' && orig.href !== null) el.setAttribute('href', orig.href);
      if (orig.styleCss) el.setAttribute('style', orig.styleCss);
      else el.removeAttribute('style');
      if (el.hasAttribute('data-cms-hidden')) {
        el.classList.remove('hidden');
        el.removeAttribute('data-cms-hidden');
      }
    }
  }

  function activeLang() {
    if (typeof window.currentLang === 'string') return window.currentLang;
    try {
      const stored = localStorage.getItem('icoachandrew_lang');
      if (stored === 'en' || stored === 'id') return stored;
    } catch (_) {}
    return (document.documentElement && document.documentElement.lang === 'en') ? 'en' : 'id';
  }

  function pickI18n(obj, lang) {
    if (!obj) return undefined;
    if (typeof obj === 'string') return obj;
    return obj[lang] !== undefined && obj[lang] !== '' ? obj[lang] : (obj.all !== undefined ? obj.all : obj.id);
  }

  // ---------- Apply site document (overrides, layout, blocks, theme, seo) ----------
  function applySiteDoc(doc) {
    if (!doc) return;
    siteDoc = doc;
    restoreOriginals();

    const lang = activeLang();
    const elements = doc.elements || {};
    for (const [key, entry] of Object.entries(elements)) {
      if (!entry) continue;
      const el = resolveKey(key);
      if (!el) continue;
      rememberOriginal(key, el);

      if (el.tagName === 'IMG') {
        if (entry.src) el.setAttribute('src', entry.src);
        if (entry.alt !== undefined) el.setAttribute('alt', entry.alt);
      } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const ph = pickI18n(entry.placeholder, lang);
        if (ph !== undefined) el.setAttribute('placeholder', ph);
      } else {
        const txt = pickI18n(entry.text, lang);
        if (txt !== undefined) el.innerHTML = sanitizeHtml(txt);
      }

      if (el.tagName === 'A' && entry.href) el.setAttribute('href', entry.href);

      if (entry.style && typeof entry.style === 'object') {
        for (const [prop, val] of Object.entries(entry.style)) {
          if (val !== undefined && val !== '') el.style[prop] = val;
        }
      }

      if (entry.hidden) {
        el.setAttribute('data-cms-hidden', '1');
        if (!isStudio) el.classList.add('hidden');
      }
    }

    applyLayoutAndBlocks(doc);
    applyTheme(doc.theme);
    applySeo(doc.seo);
    applyAnnouncement(doc.settings);
    applyTypographyScale(doc.settings);
    if (doc.settings && doc.settings.worksOnHome && worksList) renderWorksOnHome(worksList);
    if (doc.settings && doc.settings.pricingOnHome && pricingData) renderPricingOnHome(pricingData);
    if (isStudio) notifyParentState();
  }

  function applyTypographyScale(settings) {
    let styleEl = document.getElementById('cms-font-scale-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'cms-font-scale-style';
      document.head.appendChild(styleEl);
    }
    let rawScale = settings && settings.fontScale;
    let rawScope = settings && settings.fontScope;
    const isExplicitOnServer = Boolean(settings && (settings.fontScaleExplicit || (rawScale && rawScale !== 'small')));
    if (isExplicitOnServer) {
      try {
        localStorage.setItem('icoach_font_scale', rawScale || 'small');
        localStorage.setItem('icoach_font_scope', rawScope || 'both');
        localStorage.setItem('icoach_font_explicit', '1');
      } catch (_) {}
    } else {
      try {
        if (localStorage.getItem('icoach_font_explicit') === '1') {
          rawScale = localStorage.getItem('icoach_font_scale') || rawScale || 'small';
          rawScope = localStorage.getItem('icoach_font_scope') || rawScope || 'both';
        }
      } catch (_) {}
    }
    const scope = rawScope || 'both';
    const scale = (scope === 'both' || scope === 'frontpage') ? (rawScale || 'small') : 'small';
    document.documentElement.setAttribute('data-font-scale', scale);
    if (scale === 'small') {
      styleEl.textContent = '';
      return;
    }
    const mult = scale === 'medium' ? 1.14 : (scale === 'large' ? 1.28 : 1.44);
    const px = (base) => Math.round(base * mult * 10) / 10 + 'px';
    styleEl.textContent = `
      html[data-font-scale="${scale}"] { font-size: ${Math.round(16 * mult * 10) / 10}px !important; }
      html[data-font-scale="${scale}"] .text-\\[10px\\], html[data-font-scale="${scale}"] .text-label-sm { font-size: ${px(11)} !important; line-height: 1.45 !important; }
      html[data-font-scale="${scale}"] .text-\\[11px\\] { font-size: ${px(11.5)} !important; line-height: 1.45 !important; }
      html[data-font-scale="${scale}"] .text-xs { font-size: ${px(12)} !important; line-height: 1.5 !important; }
      html[data-font-scale="${scale}"] .text-body-sm, html[data-font-scale="${scale}"] .text-label-md, html[data-font-scale="${scale}"] .text-\\[13px\\] { font-size: ${px(13)} !important; line-height: 1.55 !important; }
      html[data-font-scale="${scale}"] .text-sm, html[data-font-scale="${scale}"] .text-\\[14px\\] { font-size: ${px(14)} !important; line-height: 1.55 !important; }
      html[data-font-scale="${scale}"] .text-body-md, html[data-font-scale="${scale}"] body { font-size: ${px(15)} !important; line-height: 1.6 !important; }
      html[data-font-scale="${scale}"] .text-base { font-size: ${px(16)} !important; line-height: 1.6 !important; }
      html[data-font-scale="${scale}"] .text-body-lg, html[data-font-scale="${scale}"] .text-title-md, html[data-font-scale="${scale}"] .text-lg { font-size: ${px(18)} !important; line-height: 1.55 !important; }
      html[data-font-scale="${scale}"] .text-headline-sm, html[data-font-scale="${scale}"] .text-xl { font-size: ${px(20)} !important; line-height: 1.4 !important; }
      html[data-font-scale="${scale}"] .text-headline-md, html[data-font-scale="${scale}"] .text-2xl { font-size: ${px(24)} !important; line-height: 1.35 !important; }
      html[data-font-scale="${scale}"] .text-headline-lg, html[data-font-scale="${scale}"] .text-3xl { font-size: ${px(32)} !important; line-height: 1.28 !important; }
    `;
  }

  function applyLayoutAndBlocks(doc) {
    const fp = document.getElementById('frontpage-view');
    if (!fp) return;
    // Remove previously injected custom blocks
    fp.querySelectorAll('[data-cms-injected="block"]').forEach((n) => n.remove());

    const layout = doc.layout || {};
    const order = Array.isArray(layout.order) ? layout.order : [];
    const hidden = new Set(Array.isArray(layout.hidden) ? layout.hidden : []);

    const sections = Array.from(fp.querySelectorAll(':scope > section[id]'));
    const byId = new Map(sections.map((s) => [s.id, s]));
    for (const id of order) {
      const sec = byId.get(id);
      if (sec) fp.appendChild(sec);
    }
    for (const sec of sections) {
      const isHidden = hidden.has(sec.id);
      sec.toggleAttribute('data-cms-section-hidden', isHidden);
      if (!isStudio) sec.classList.toggle('hidden', isHidden);
    }

    const blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
    for (const b of blocks) {
      if (b.hidden && !isStudio) continue;
      const wrapper = document.createElement('section');
      wrapper.id = b.id;
      wrapper.setAttribute('data-cms-injected', 'block');
      wrapper.setAttribute('data-bio-section', '1');
      wrapper.setAttribute('data-cms-block-label', b.label || 'Blok Kustom');
      if (b.hidden) wrapper.setAttribute('data-cms-section-hidden', 'true');
      wrapper.className = 'w-full py-space-xl px-6 md:px-margin bg-surface';
      wrapper.innerHTML = '<div class="max-w-[1360px] mx-auto">' + sanitizeHtml(b.html || '') + '</div>';
      const anchor = b.after ? byId.get(b.after) : null;
      if (anchor && anchor.parentNode === fp) anchor.insertAdjacentElement('afterend', wrapper);
      else fp.appendChild(wrapper);
    }
  }

  function applyTheme(theme) {
    let styleEl = document.getElementById('cms-theme-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'cms-theme-style';
      document.head.appendChild(styleEl);
    }
    if (!theme) { styleEl.textContent = ''; return; }
    const rules = [];
    const c = theme.colors || {};
    if (c.primary) {
      rules.push(`.text-primary { color: ${c.primary} !important; }`);
      rules.push(`.bg-primary { background-color: ${c.primary} !important; }`);
      rules.push(`.border-primary { border-color: ${c.primary} !important; }`);
    }
    if (c['primary-container']) {
      rules.push(`.bg-primary-container { background-color: ${c['primary-container']} !important; }`);
      rules.push(`.text-primary-container { color: ${c['primary-container']} !important; }`);
    }
    if (c.surface) {
      rules.push(`.bg-surface, .bg-background, body { background-color: ${c.surface} !important; }`);
    }
    if (c['surface-container-low']) {
      rules.push(`.bg-surface-container-low { background-color: ${c['surface-container-low']} !important; }`);
    }
    if (c['surface-container-high']) {
      rules.push(`.bg-surface-container-high { background-color: ${c['surface-container-high']} !important; }`);
    }
    if (c['on-surface']) {
      rules.push(`.text-on-surface, body { color: ${c['on-surface']} !important; }`);
    }
    if (c['on-surface-variant']) {
      rules.push(`.text-on-surface-variant { color: ${c['on-surface-variant']} !important; }`);
    }
    if (c['tertiary-fixed']) {
      rules.push(`.text-tertiary-fixed { color: ${c['tertiary-fixed']} !important; }`);
      rules.push(`.bg-tertiary-fixed { background-color: ${c['tertiary-fixed']} !important; }`);
    }
    if (c['on-tertiary-container']) {
      rules.push(`.text-on-tertiary-container { color: ${c['on-tertiary-container']} !important; }`);
    }
    if (c.secondary) {
      rules.push(`.text-secondary { color: ${c.secondary} !important; }`);
      rules.push(`.bg-secondary { background-color: ${c.secondary} !important; }`);
    }
    let f = (theme && theme.fonts) || {};
    if (f.consistentAll || f.serif || f.sans) {
      try {
        localStorage.setItem('icoach_theme_fonts', JSON.stringify(f));
      } catch (_) {}
    } else {
      try {
        const cachedFonts = localStorage.getItem('icoach_theme_fonts');
        if (cachedFonts) {
          const parsed = JSON.parse(cachedFonts);
          if (parsed && typeof parsed === 'object') f = parsed;
        }
      } catch (_) {}
    }
    if (f.consistentAll) {
      ensureGoogleFont(f.consistentAll);
      rules.push(`body, h1, h2, h3, h4, h5, h6, p, a, button, input, textarea, select, li, blockquote, .font-serif, .font-sans, .font-serif-heading, .font-display-lg, .font-headline-xl, .font-headline-lg, .font-headline-md, .font-headline-sm, .font-title-md, .font-body-lg, .font-body-md, .font-body-sm, .font-label-md, .font-label-sm { font-family: "${f.consistentAll}", -apple-system, BlinkMacSystemFont, sans-serif !important; }`);
      rules.push(`.material-symbols-outlined { font-family: 'Material Symbols Outlined' !important; }`);
    } else {
      if (f.serif) {
        ensureGoogleFont(f.serif);
        rules.push(`h1, h2, h3, h4, .font-serif, .font-serif-heading, .font-display-lg, .font-headline-xl, .font-headline-lg, .font-headline-md, .font-headline-sm { font-family: "${f.serif}", Georgia, serif !important; }`);
      }
      if (f.sans) {
        ensureGoogleFont(f.sans);
        rules.push(`body, p, a, button, input, textarea, select, li, .font-sans, .font-body-lg, .font-body-md, .font-body-sm, .font-label-md, .font-label-sm { font-family: "${f.sans}", -apple-system, BlinkMacSystemFont, sans-serif !important; }`);
        rules.push(`.material-symbols-outlined { font-family: 'Material Symbols Outlined' !important; }`);
      }
    }
    if (theme.customCss) rules.push(theme.customCss);
    styleEl.textContent = rules.join('\n');
  }

  function ensureGoogleFont(name) {
    const id = 'cms-font-' + name.toLowerCase().replace(/\s+/g, '-');
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name) + ':ital,wght@0,400;0,600;0,700;1,400&display=swap';
    document.head.appendChild(link);
  }

  function applySeo(seo) {
    if (!seo) return;
    window.__cmsSeo = seo;
    const lang = activeLang();
    if (lang === 'en' && seo.titleEn) {
      document.title = seo.titleEn;
    } else if (seo.title) {
      document.title = seo.title;
    }
    if (seo.description) {
      let m = document.querySelector('meta[name="description"]');
      if (!m) { m = document.createElement('meta'); m.name = 'description'; document.head.appendChild(m); }
      m.content = seo.description;
    }
    if (seo.favicon) {
      let l = document.getElementById('site-favicon') || document.querySelector('link[rel="icon"]');
      if (!l) { l = document.createElement('link'); l.id = 'site-favicon'; l.rel = 'icon'; document.head.appendChild(l); }
      l.removeAttribute('type');
      l.href = seo.favicon;
    }
  }

  function applyAnnouncement(settings) {
    let bar = document.getElementById('cms-announcement-bar');
    const txt = settings && settings.announcement ? settings.announcement.trim() : '';
    if (!txt) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cms-announcement-bar';
      bar.setAttribute('data-cms-injected', 'announcement');
      bar.className = 'w-full bg-primary text-on-primary text-center py-2 px-4 text-xs font-medium tracking-wide';
      document.body.insertBefore(bar, document.body.firstChild);
    }
    bar.innerHTML = sanitizeHtml(txt);
  }

  // ---------- Dynamic Works Repository & Pricing Cards ----------
  function renderWorksOnHome(works) {
    const sec = document.getElementById('karya-buku');
    if (!sec || !Array.isArray(works) || !works.length) return;
    const grid = sec.querySelector('.grid');
    if (!grid) return;
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const featured = works.filter((w) => w.featured);
    const list = (featured.length ? featured : works).slice(0, 8);
    const lang = activeLang();
    const isEn = lang === 'en';
    grid.innerHTML = list.map((w) => {
      const prompt = isEn
        ? `Let's discuss the work "${w.title}": ${w.summary || ''}`.replace(/\s+/g, ' ').slice(0, 220).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        : `Mari berdiskusi tentang karya "${w.title}": ${w.summary || ''}`.replace(/\s+/g, ' ').slice(0, 220).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const cover = w.coverUrl
        ? `<img class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" alt="${esc(w.title)}" src="${esc(w.coverUrl)}"/>`
        : `<div class="w-full h-full flex items-center justify-center bg-primary-container text-tertiary-fixed font-serif text-xl px-4 text-center">${esc(w.title)}</div>`;
      return `
        <div data-cms-injected="work" onclick="askBookPrompt('${esc(prompt)}')" class="cursor-pointer group bg-surface rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all flex flex-col">
          <div class="h-48 overflow-hidden bg-primary-container relative">
            ${cover}
            <div class="absolute inset-0 bg-gradient-to-t from-primary/90 via-transparent to-transparent"></div>
            <div class="absolute bottom-3 left-3 right-3 text-on-primary">
              <span class="font-label-sm text-[10px] uppercase tracking-wider text-tertiary-fixed">${esc(w.subtitle || (w.type || (isEn ? 'Work' : 'Karya')).toUpperCase() + (w.year ? ' • ' + w.year : ''))}</span>
            </div>
          </div>
          <div class="p-space-md flex-1 flex flex-col justify-between space-y-space-sm">
            <div class="space-y-1">
              <h3 class="font-headline-sm text-headline-sm text-primary group-hover:text-primary-container transition-colors">${esc(w.title)}</h3>
              <p class="font-body-sm text-body-sm text-on-surface-variant">${esc(w.summary || '')}</p>
            </div>
            <div class="pt-space-xs font-label-sm text-label-sm text-primary flex items-center justify-between">
              <span>${isEn ? 'Discuss This Work →' : 'Diskusikan Karya Ini →'}</span>
              <span class="material-symbols-outlined text-[16px]">menu_book</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function formatMoney(amount, currency) {
    const n = Number(amount) || 0;
    if (n <= 0) return 'Gratis';
    try {
      return new Intl.NumberFormat(currency === 'IDR' ? 'id-ID' : 'en-US', { style: 'currency', currency: currency || 'IDR', maximumFractionDigits: 0 }).format(n);
    } catch (_) {
      return (currency || 'IDR') + ' ' + n.toLocaleString('id-ID');
    }
  }

  function renderPricingOnHome(pricing) {
    const fp = document.getElementById('frontpage-view');
    if (!fp || !pricing || !Array.isArray(pricing.plans)) return;
    let sec = document.getElementById('cms-pricing-section');
    if (!sec) {
      sec = document.createElement('section');
      sec.id = 'cms-pricing-section';
      sec.setAttribute('data-cms-injected', 'pricing');
      sec.setAttribute('data-bio-section', '1');
      sec.className = 'w-full bg-surface py-space-xl px-6 md:px-margin border-t border-outline-variant/20';
      const anchor = document.getElementById('lingkaran-pendampingan');
      if (anchor && anchor.parentNode === fp) anchor.insertAdjacentElement('afterend', sec);
      else fp.appendChild(sec);
    }
    const lang = activeLang();
    const isEn = lang === 'en';
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cards = pricing.plans.map((p) => {
      const priceLabel = p.priceMonthly > 0
        ? `${formatMoney(p.priceMonthly, pricing.currency)}<span class="text-xs font-normal text-outline"> / ${isEn ? 'month' : 'bulan'}</span>`
        : (p.ring === 1 ? (isEn ? 'Private Invitation' : 'Undangan Pribadi') : (isEn ? 'Open Space' : 'Terbuka'));
      const action = p.purchasable
        ? `window.__cmsOpenCheckout('${esc(p.id)}')`
        : p.ring === 1 ? "openModal('ring1-auth-modal')" : "openChamberView()";
      const feats = (p.features || []).map((f) => `<li class="flex items-start gap-2 text-body-sm text-on-surface-variant"><span class="material-symbols-outlined text-[16px] text-primary shrink-0 mt-0.5">check_circle</span><span>${esc(f)}</span></li>`).join('');
      return `
        <div class="rounded-2xl p-6 flex flex-col justify-between border ${p.highlight ? 'bg-primary text-on-primary border-primary shadow-lg' : 'bg-surface-container-lowest text-on-surface border-outline-variant/30 shadow-sm'}">
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <span class="text-[11px] uppercase tracking-widest font-bold ${p.highlight ? 'text-tertiary-fixed' : 'text-on-tertiary-container'}">${esc(p.badge || (p.highlight ? (isEn ? 'Top Recommendation' : 'Rekomendasi Utama') : (isEn ? 'Advisory Circle' : 'Lingkaran Pendampingan')))}</span>
              ${p.messageCap > 0 ? `<span class="text-xs px-2 py-0.5 rounded-full ${p.highlight ? 'bg-white/10 text-white' : 'bg-surface-container text-primary'}">${p.messageCap} ${isEn ? 'sessions/mo' : 'sesi/bln'}</span>` : ''}
            </div>
            <div>
              <h3 class="font-headline-sm text-xl ${p.highlight ? 'text-white' : 'text-primary'}">${esc(p.name)}</h3>
              <p class="text-xs mt-1 ${p.highlight ? 'text-on-primary-container' : 'text-on-surface-variant'}">${esc(p.tagline || '')}</p>
            </div>
            <div class="text-2xl font-bold ${p.highlight ? 'text-tertiary-fixed' : 'text-primary'}">${priceLabel}</div>
            <ul class="space-y-2 pt-2 ${p.highlight ? '[&_li]:text-white/90 [&_span]:text-tertiary-fixed' : ''}">${feats}</ul>
          </div>
          <button onclick="${action}" class="mt-6 w-full py-2.5 px-4 rounded-lg font-label-md text-label-md font-semibold transition-all ${p.highlight ? 'bg-tertiary-fixed text-on-tertiary-fixed hover:opacity-95' : 'bg-primary text-on-primary hover:bg-primary-container'}">
            ${esc(p.ctaLabel || (isEn ? 'Select Circle' : 'Pilih Paket'))}
          </button>
        </div>`;
    }).join('');
    sec.innerHTML = `
      <div class="max-w-[1360px] mx-auto space-y-8">
        <div class="max-w-2xl space-y-2">
          <div class="font-label-sm text-label-sm uppercase tracking-widest text-on-tertiary-container font-bold">${isEn ? 'Membership &amp; Contribution' : 'Keanggotaan &amp; Kontribusi'}</div>
          <h2 class="font-headline-xl text-headline-xl-mobile md:text-headline-xl text-primary leading-tight">${isEn ? 'Choose the Advisory Circle That Fits Your Journey' : 'Pilih Lingkaran Pendampingan yang Sesuai dengan Perjalanan Anda'}</h2>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">${cards}</div>
      </div>`;
  }

  // ---------- Interactive Checkout Modal for Ring 2 Plans ----------
  window.__cmsOpenCheckout = function (planId) {
    if (!pricingData) return;
    const plan = (pricingData.plans || []).find((p) => p.id === planId);
    if (!plan) return;
    if (pricingData.freeForNow) {
      if (typeof window.openModal === 'function') window.openModal('ring2-membership-modal');
      return;
    }
    let modal = document.getElementById('cms-checkout-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'cms-checkout-modal';
      modal.className = 'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
      document.body.appendChild(modal);
    }
    const gws = (pricingData.gateways || []).map((g) => `<option value="${g.provider}">${g.provider.toUpperCase()} (${g.mode})</option>`).join('');
    modal.innerHTML = `
      <div class="bg-surface rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4 border border-outline-variant/30">
        <div class="flex items-center justify-between">
          <h3 class="font-headline-sm text-xl text-primary">${plan.name}</h3>
          <button onclick="document.getElementById('cms-checkout-modal').remove()" class="text-outline hover:text-primary">✕</button>
        </div>
        <p class="text-xs text-on-surface-variant">${plan.tagline || ''}</p>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <label class="border rounded-lg p-3 cursor-pointer flex flex-col gap-1"><input type="radio" name="cms_cycle" value="monthly" checked/> <span>Bulanan</span><strong>${formatMoney(plan.priceMonthly, pricingData.currency)}</strong></label>
          <label class="border rounded-lg p-3 cursor-pointer flex flex-col gap-1"><input type="radio" name="cms_cycle" value="yearly"/> <span>Tahunan</span><strong>${formatMoney(plan.priceYearly, pricingData.currency)}</strong></label>
        </div>
        <div class="space-y-2">
          <label class="block text-xs font-semibold text-primary">Metode Pembayaran</label>
          <select id="cms-co-gw" class="w-full border rounded-lg px-3 py-2 text-sm bg-white">${gws || '<option value="manual">Transfer Bank Manual</option>'}</select>
        </div>
        <div class="space-y-2">
          <label class="block text-xs font-semibold text-primary">Kode Kupon (Opsional)</label>
          <input id="cms-co-coupon" type="text" placeholder="Contoh: SAHABAT10" class="w-full border rounded-lg px-3 py-2 text-sm bg-white"/>
        </div>
        <div id="cms-co-result" class="text-xs text-primary space-y-1"></div>
        <button id="cms-co-submit" class="w-full py-2.5 rounded-lg bg-primary text-on-primary font-semibold text-sm hover:bg-primary-container">Lanjutkan Pembayaran</button>
      </div>`;
    document.getElementById('cms-co-submit').onclick = async () => {
      const cycle = modal.querySelector('input[name="cms_cycle"]:checked').value;
      const gateway = document.getElementById('cms-co-gw').value;
      const coupon = document.getElementById('cms-co-coupon').value.trim();
      const box = document.getElementById('cms-co-result');
      box.textContent = 'Memproses pesanan...';
      const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: plan.id, cycle, gateway, coupon }) });
      const j = await r.json();
      if (!r.ok) {
        if (j.error === 'member_required' && typeof window.openModal === 'function') {
          modal.remove();
          window.openModal('ring2-membership-modal');
          return;
        }
        box.textContent = 'Gagal membuat pesanan: ' + (j.detail || j.error || 'Periksa kembali data Anda.');
        return;
      }
      if (j.redirectUrl) { window.location.href = j.redirectUrl; return; }
      if (j.instructions) {
        box.innerHTML = `<div class="p-3 rounded-lg bg-surface-container text-xs space-y-1">
          <div><strong>Kode Pesanan:</strong> ${j.orderId}</div>
          <div><strong>Nominal:</strong> ${formatMoney(j.amount, j.currency)}</div>
          <div><strong>Bank:</strong> ${j.instructions.bankName} — ${j.instructions.accountNo} (${j.instructions.accountName})</div>
          <div>${j.instructions.note || ''}</div>
        </div>`;
      }
    };
  };

  // ---------- Hook language switch so CMS overrides re-apply per language ----------
  function hookLanguageSwitch() {
    const origSetLang = window.setLanguage;
    if (typeof origSetLang === 'function' && !origSetLang.__cmsWrapped) {
      const wrapped = function (lang) {
        const res = origSetLang.apply(this, arguments);
        if (siteDoc) applySiteDoc(siteDoc);
        return res;
      };
      wrapped.__cmsWrapped = true;
      window.setLanguage = wrapped;
    }
  }

  // ---------- Human-friendly labels & plain-text entity decoder ----------
  const SECTION_LABELS = {
    'ruang-diskusi': 'Ruang Diskusi & Chat Utama',
    'beranda': 'Profil: Siapa Andrew Tani',
    'karya-buku': 'Pustaka & Buku Rujukan',
    'lingkaran-pendampingan': 'Pilihan Akses Diskusi',
    'tentang-pak-andrew-tani': 'Rekam Jejak & Biografi',
    'footer': 'Catatan Kaki (Bagian Bawah)',
    'halaman': 'Bagian Atas / Navigasi'
  };

  const ELEMENT_ID_LABELS = {
    'top-bar-left': 'Label Baris Atas (Header)',
    'header-subtitle': 'Subjudul Logo iCoachAndrew',
    'chat-badge': 'Label Atas Ruang Chat',
    'chat-free-pill': 'Info Kuota 10x Gratis',
    'chat-title': 'Judul Utama Ruang Chat',
    'chat-subtitle': 'Penjelasan Singkat Ruang Chat',
    'prompt-chip-1': 'Tombol Pertanyaan Kilat 1',
    'prompt-chip-2': 'Tombol Pertanyaan Kilat 2',
    'prompt-chip-3': 'Tombol Pertanyaan Kilat 3',
    'prompt-chip-4': 'Tombol Pertanyaan Kilat 4',
    'chat-welcome-header': 'Judul Sapaan Pembuka Chat',
    'chat-welcome-body': 'Isi Sapaan Pembuka Pak Andrew',
    'chat-welcome-foot': 'Catatan Kaki Sapaan Chat',
    'who-trigger-badge': 'Label Kartu Siapa Andrew Tani',
    'who-trigger-title': 'Judul Tombol Siapa Andrew Tani',
    'who-trigger-desc': 'Penjelasan Tombol Siapa Andrew Tani',
    'hero-badge': 'Label Profil Siapa Andrew Tani',
    'hero-title': 'Judul Utama Profil Andrew Tani',
    'hero-subtitle': 'Paragraf Pembuka Profil Andrew Tani',
    'portrait-name': 'Nama pada Kartu Foto Profil',
    'portrait-title': 'Jabatan pada Kartu Foto Profil',
    'portrait-subtitle': 'Keterangan Buku pada Kartu Foto',
    'portrait-quote': 'Kutipan pada Kartu Foto Profil',
    'books-badge': 'Label Bagian Buku & Karya',
    'books-title': 'Judul Bagian Buku & Karya',
    'books-subtitle': 'Deskripsi Bagian Buku & Karya',
    'book1-title': 'Judul Buku 1 (Organizing for Business Excellence)',
    'book1-desc': 'Ringkasan Buku 1',
    'book2-title': 'Judul Buku 2 (Brain Quotient)',
    'book2-desc': 'Ringkasan Buku 2',
    'book3-title': 'Judul Karya 3 (Suksesi & Tata Kelola)',
    'book3-desc': 'Ringkasan Karya 3',
    'book4-title': 'Judul Karya 4 (Refleksi & Lagu)',
    'book4-desc': 'Ringkasan Karya 4',
    'tiers-title': 'Judul Bagian Pilihan Akses',
    'tiers-subtitle': 'Subjudul Bagian Pilihan Akses',
    'tier1-name': 'Nama Paket Akses 1 (Publik)',
    'tier1-desc': 'Deskripsi Paket Akses 1',
    'tier2-name': 'Nama Paket Akses 2 (Eksekutif)',
    'tier2-desc': 'Deskripsi Paket Akses 2',
    'footer-desc': 'Deskripsi Penutup (Bagian Bawah)',
    'footer-address': 'Alamat Kantor (Bagian Bawah)',
    'footer-contact-title': 'Judul Kontak Sekretariat',
    'footer-contact-desc': 'Teks Kontak Sekretariat',
    'footer-wa-text': 'Teks Tombol WhatsApp Sekretariat',
    'footer-ethics-title': 'Judul Etika & Penafian',
    'footer-ethics-desc': 'Isi Etika & Penafian'
  };

  function decodeHtmlToPlainText(rawHtml, fallbackEl) {
    if (fallbackEl && typeof fallbackEl.innerText === 'string' && fallbackEl.children.length === 0) {
      return fallbackEl.textContent.replace(/\s+/g, ' ').trim();
    }
    const str = String(rawHtml ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '');
    if (typeof document !== 'undefined') {
      const txt = document.createElement('textarea');
      txt.innerHTML = str;
      return txt.value.trim();
    }
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  function getFriendlyType(el) {
    if (!el || !el.tagName) return 'Elemen';
    const t = el.tagName.toLowerCase();
    if (t === 'img') return 'Foto / Gambar';
    if (/^h[1-6]$/.test(t)) return 'Judul';
    if (t === 'button') return 'Tombol';
    if (t === 'a') return 'Tombol / Tautan';
    if (t === 'input' || t === 'textarea') return 'Kolom Isian';
    if (t === 'section') return 'Bagian Halaman';
    return 'Teks';
  }

  function getFriendlySectionName(secId) {
    if (!secId) return 'Bagian Halaman';
    const clean = String(secId).replace(/^#/, '');
    return SECTION_LABELS[clean] || clean.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function getFriendlyLabel(el, key) {
    if (!el) return 'Elemen Halaman';
    if (el.id && ELEMENT_ID_LABELS[el.id]) return ELEMENT_ID_LABELS[el.id];
    const typeLabel = getFriendlyType(el);
    if (el.tagName === 'IMG') {
      return 'Foto: ' + (el.getAttribute('alt') || 'Gambar Halaman');
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return 'Kolom Input: ' + (el.getAttribute('placeholder') || 'Isian Teks').slice(0, 38);
    }
    const sample = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 42);
    if (sample) return `${typeLabel}: "${sample}${sample.length >= 42 ? '…' : ''}"`;
    return typeLabel;
  }

  // ---------- Studio Visual Canvas Bridge (?studio=1) ----------
  function initStudioBridge() {
    document.body.classList.add('bio-revealed');
    const badge = document.createElement('div');
    badge.setAttribute('data-cms-injected', 'studio-ui');
    badge.style.cssText = 'position:fixed;pointer-events:none;z-index:99998;border:2px solid #b18d48;border-radius:6px;transition:all 80ms ease;display:none;box-shadow:0 0 0 2px rgba(0,22,55,0.18);';
    const tagPill = document.createElement('span');
    tagPill.style.cssText = 'position:absolute;top:-22px;left:-2px;background:#001637;color:#ffdea5;font:600 10px/1.2 sans-serif;padding:3px 7px;border-radius:4px;white-space:nowrap;letter-spacing:0.04em;';
    badge.appendChild(tagPill);
    document.body.appendChild(badge);

    const selBox = document.createElement('div');
    selBox.setAttribute('data-cms-injected', 'studio-ui');
    selBox.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;border:2px solid #001637;border-radius:6px;display:none;box-shadow:0 0 0 3px rgba(233,193,118,0.55);';
    document.body.appendChild(selBox);

    const stStyle = document.createElement('style');
    stStyle.setAttribute('data-cms-injected', 'studio-ui');
    stStyle.textContent = `
      [data-cms-hidden="1"], [data-cms-section-hidden="true"] { opacity: 0.35 !important; outline: 1px dashed #a73833 !important; }
      [contenteditable="true"] { outline: 2px solid #0d2b55 !important; background: rgba(255,222,165,0.18) !important; border-radius: 4px; }
    `;
    document.head.appendChild(stStyle);

    function positionBox(box, el, labelText) {
      if (!el || ! document.body.contains(el)) { box.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.style.top = r.top + 'px';
      box.style.left = r.left + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      if (labelText && box === badge) tagPill.textContent = labelText;
    }

    function updateBoxes() {
      if (hoverEl && hoverEl !== selectedEl) positionBox(badge, hoverEl, describeEl(hoverEl));
      else badge.style.display = 'none';
      if (selectedEl) positionBox(selBox, selectedEl);
      else selBox.style.display = 'none';
    }
    window.addEventListener('scroll', updateBoxes, true);
    window.addEventListener('resize', updateBoxes);

    function describeEl(el) {
      if (!el) return '';
      const t = el.tagName.toLowerCase();
      if (t === 'img') return 'FOTO / GAMBAR • Klik untuk ganti';
      if (t === 'section') return 'BAGIAN: ' + getFriendlySectionName(el.id || '');
      const fLabel = getFriendlyLabel(el);
      return fLabel.slice(0, 48) + ' • Klik untuk edit';
    }

    function isEditableTarget(el) {
      if (!el || el === document.body || el === document.documentElement) return false;
      if (el.closest('[data-cms-injected="studio-ui"]')) return false;
      return true;
    }

    function pickBestTarget(raw) {
      if (!raw) return null;
      const img = raw.closest('img');
      if (img) return img;
      const leaf = raw.closest('h1,h2,h3,h4,h5,h6,p,span,a,button,li,blockquote,figcaption,label,input,textarea,div,section');
      return leaf || raw;
    }

    document.addEventListener('mousemove', (e) => {
      if (studioMode !== 'inspect') { badge.style.display = 'none'; return; }
      const t = pickBestTarget(e.target);
      if (!isEditableTarget(t)) { hoverEl = null; badge.style.display = 'none'; return; }
      hoverEl = t;
      updateBoxes();
    }, true);

    document.addEventListener('click', (e) => {
      if (studioMode !== 'inspect') return;
      const t = pickBestTarget(e.target);
      if (!isEditableTarget(t)) return;
      e.preventDefault();
      e.stopPropagation();
      selectElement(t);
    }, true);

    document.addEventListener('dblclick', (e) => {
      if (studioMode !== 'inspect') return;
      const t = pickBestTarget(e.target);
      if (!t || ['IMG', 'INPUT', 'TEXTAREA', 'SECTION'].includes(t.tagName)) return;
      e.preventDefault();
      e.stopPropagation();
      selectElement(t);
      t.setAttribute('contenteditable', 'true');
      t.focus();
      const onBlur = () => {
        t.removeAttribute('contenteditable');
        t.removeEventListener('blur', onBlur);
        const key = computeKey(t);
        if (key) {
          const cleanPlain = decodeHtmlToPlainText(t.innerHTML, t);
          window.parent.postMessage({ type: 'cms:inline-edit', key, lang: activeLang(), html: cleanPlain, plainText: cleanPlain }, window.location.origin);
        }
      };
      t.addEventListener('blur', onBlur);
    }, true);

    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const msg = e.data || {};
      if (msg.type === 'cms:apply-doc' && msg.doc) {
        applySiteDoc(msg.doc);
        updateBoxes();
      } else if (msg.type === 'cms:set-mode') {
        studioMode = msg.mode === 'navigate' ? 'navigate' : 'inspect';
        updateBoxes();
      } else if (msg.type === 'cms:set-view') {
        if (msg.view === 'chamber' && typeof window.openChamberView === 'function') window.openChamberView();
        else if (msg.view === 'frontpage' && typeof window.showFrontpageView === 'function') window.showFrontpageView();
        else if (msg.view === 'modal-r2' && typeof window.openModal === 'function') window.openModal('ring2-membership-modal');
        else if (msg.view === 'modal-r1' && typeof window.openModal === 'function') window.openModal('ring1-auth-modal');
        setTimeout(notifyParentState, 80);
      } else if (msg.type === 'cms:set-lang' && typeof window.setLanguage === 'function') {
        window.setLanguage(msg.lang);
      } else if (msg.type === 'cms:toggle-bio') {
        if (msg.show === false) document.body.classList.remove('bio-revealed');
        else document.body.classList.add('bio-revealed');
        setTimeout(() => { updateBoxes(); notifyParentState(); }, 80);
      } else if (msg.type === 'cms:select-key') {
        const el = resolveKey(msg.key);
        if (el) {
          if (el.closest('[data-bio-section="1"]')) {
            document.body.classList.add('bio-revealed');
          }
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          selectElement(el);
        }
      } else if (msg.type === 'cms:request-state') {
        notifyParentState();
      }
    });

    function selectElement(el) {
      const key = computeKey(el);
      if (!key) return;
      rememberOriginal(key, el);
      selectedEl = el;
      selectedKey = key;
      updateBoxes();
      const cs = window.getComputedStyle(el);
      const entry = (siteDoc && siteDoc.elements && siteDoc.elements[key]) || {};
      const secEl = el.closest('section[id], footer, header');
      const secId = secEl ? (secEl.id || secEl.tagName.toLowerCase()) : 'halaman';
      const plainText = decodeHtmlToPlainText(el.innerHTML, el);
      window.parent.postMessage({
        type: 'cms:selected',
        key,
        friendlyLabel: getFriendlyLabel(el, key),
        friendlyType: getFriendlyType(el),
        sectionLabel: getFriendlySectionName(secId),
        tag: el.tagName.toLowerCase(),
        isImage: el.tagName === 'IMG',
        isLink: el.tagName === 'A',
        isInput: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA',
        lang: activeLang(),
        html: plainText,
        plainText,
        text: plainText.slice(0, 400),
        src: el.tagName === 'IMG' ? el.getAttribute('src') : null,
        alt: el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : null,
        href: el.tagName === 'A' ? (el.getAttribute('href') || '') : null,
        placeholder: el.getAttribute('placeholder') || '',
        hidden: Boolean(entry.hidden),
        style: entry.style || {},
        computed: {
          color: rgbToHex(cs.color),
          backgroundColor: rgbToHex(cs.backgroundColor),
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          textAlign: cs.textAlign,
          borderRadius: cs.borderRadius,
          padding: cs.padding
        }
      }, window.location.origin);
    }
  }

  function rgbToHex(rgb) {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(rgb || ''));
    if (!m) return '#001637';
    return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  }

  function scanPageInventory() {
    const images = [];
    document.querySelectorAll('img').forEach((img, i) => {
      const key = computeKey(img);
      if (!key) return;
      rememberOriginal(key, img);
      const sec = img.closest('section[id], footer, header, div[id]');
      const secId = sec ? (sec.id || sec.tagName.toLowerCase()) : 'halaman';
      images.push({
        index: i,
        key,
        src: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || ('Foto #' + (i + 1)),
        section: secId,
        sectionLabel: getFriendlySectionName(secId),
        width: img.naturalWidth || img.clientWidth || 0,
        height: img.naturalHeight || img.clientHeight || 0
      });
    });

    const fp = document.getElementById('frontpage-view');
    const sections = [];
    if (fp) {
      fp.querySelectorAll(':scope > section[id]').forEach((s) => {
        if (s.getAttribute('data-cms-injected') === 'block') return;
        const h = s.querySelector('h1, h2, h3');
        sections.push({
          id: s.id,
          friendlyName: getFriendlySectionName(s.id),
          title: h ? (h.textContent || '').trim().slice(0, 70) : getFriendlySectionName(s.id),
          hidden: s.hasAttribute('data-cms-section-hidden')
        });
      });
    }

    const editableElements = [];
    const seenKeys = new Set();
    const candidates = document.querySelectorAll('h1, h2, h3, [id^="chat-"], [id^="prompt-chip-"], [id^="who-trigger-"], [id^="hero-"], [id^="portrait-"], [id^="book"], [id^="tier"], [id^="footer-"], #header-subtitle, #top-bar-left');
    candidates.forEach((el) => {
      if (!el || el.tagName === 'IMG' || el.tagName === 'SECTION' || el.tagName === 'FORM' || el.tagName === 'AUDIO') return;
      if (el.closest('[data-cms-injected="studio-ui"]')) return;
      const key = computeKey(el);
      if (!key || seenKeys.has(key)) return;
      const plain = decodeHtmlToPlainText(el.innerHTML, el);
      if (!plain && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
      seenKeys.add(key);
      const sec = el.closest('section[id], footer, header');
      const secId = sec ? (sec.id || sec.tagName.toLowerCase()) : 'halaman';
      editableElements.push({
        key,
        friendlyLabel: getFriendlyLabel(el, key),
        friendlyType: getFriendlyType(el),
        section: secId,
        sectionLabel: getFriendlySectionName(secId),
        preview: plain.slice(0, 70)
      });
    });

    return { images, sections, editableElements, lang: activeLang() };
  }

  function notifyParentState() {
    if (!isStudio || window.parent === window) return;
    window.parent.postMessage({ type: 'cms:inventory', ...scanPageInventory() }, window.location.origin);
  }

  // ---------- Boot ----------
  async function boot() {
    applyTypographyScale(null);
    applyTheme({});
    hookLanguageSwitch();
    if (isStudio) initStudioBridge();
    try {
      const [siteRes, worksRes, pricingRes] = await Promise.all([
        fetch('/api/site-content'),
        fetch('/api/works'),
        fetch('/api/pricing')
      ]);
      if (worksRes.ok) { const wj = await worksRes.json(); worksList = wj.works || []; }
      if (pricingRes.ok) { pricingData = await pricingRes.json(); }
      if (siteRes.ok) { const sj = await siteRes.json(); applySiteDoc(sj); }
    } catch (_) {}
    if (isStudio) setTimeout(notifyParentState, 150);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
