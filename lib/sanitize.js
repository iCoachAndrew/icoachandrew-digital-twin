'use strict';
// Allow-list sanitizers for everything the Ring 0 Studio can publish to visitors.
// Admin is trusted, but published content is still sanitized so a stolen admin
// session or a pasted snippet can never inject script into the public site.

const SAFE_URL = /^(https?:\/\/[^\s"'<>`]+|\/(?!\/)[^\s"'<>`]*|#[\w\-:.]*|mailto:[^\s"'<>`]+|tel:[+\d\s\-()]+)$/i;

function safeUrl(u) {
  const s = String(u || '').trim();
  if (!s || s.length > 2048) return '';
  if (/^\s*(javascript|data|vbscript):/i.test(s)) return '';
  return SAFE_URL.test(s) ? s : '';
}

function safeImageUrl(u) {
  const s = safeUrl(u);
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || /^\/media\/[a-z0-9_]+\.(png|jpe?g|gif|webp|avif|ico)$/i.test(s)) return s;
  return '';
}

const CLASS_OK = /^[\w\s:/\-[\]#.%()!,]*$/;
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'br', 'span', 'a', 'small', 'sup', 'sub', 'mark', 's']);
const BLOCK_TAGS = new Set([...INLINE_TAGS, 'div', 'section', 'article', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'figure', 'figcaption', 'img', 'hr', 'button', 'header', 'footer', 'aside', 'q', 'cite', 'code', 'pre']);
const VOID = new Set(['br', 'img', 'hr']);

function attr(attrs, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(attrs) || new RegExp('\\b' + name + "\\s*=\\s*'([^']*)'", 'i').exec(attrs);
  return m ? m[1] : null;
}

function sanitizeHtml(html, allowed, maxLen) {
  const s = String(html || '').slice(0, maxLen)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|template|svg|math|noscript)[\s\S]*?<\/\1\s*>/gi, '');
  return s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<|>/g, (m, tag, attrs) => {
    if (!tag) return m === '<' ? '&lt;' : '&gt;';
    tag = tag.toLowerCase();
    if (!allowed.has(tag)) return '';
    if (m.startsWith('</')) return VOID.has(tag) ? '' : `</${tag}>`;
    let out = '<' + tag;
    const cls = attr(attrs, 'class');
    if (cls && CLASS_OK.test(cls)) out += ` class="${escAttr(cls)}"`;
    if (tag === 'a') {
      const h = safeUrl(attr(attrs, 'href'));
      if (h) out += ` href="${escAttr(h)}"` + (/^https?:/i.test(h) ? ' target="_blank" rel="noopener noreferrer"' : '');
    }
    if (tag === 'img') {
      const src = safeImageUrl(attr(attrs, 'src'));
      if (!src) return '';
      out += ` src="${escAttr(src)}" alt="${escAttr(attr(attrs, 'alt') || '')}" loading="lazy"`;
    }
    return out + '>';
  });
}

const sanitizeInline = (h) => sanitizeHtml(h, INLINE_TAGS, 20000);
const sanitizeBlock = (h) => sanitizeHtml(h, BLOCK_TAGS, 60000);

const STYLE_PROPS = new Set(['color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontStyle', 'fontFamily', 'textAlign',
  'textTransform', 'letterSpacing', 'lineHeight', 'padding', 'margin', 'borderRadius', 'border', 'opacity', 'objectFit',
  'objectPosition', 'filter', 'width', 'maxWidth', 'height', 'minHeight', 'gap', 'boxShadow', 'textDecoration', 'aspectRatio']);
const STYLE_VALUE = /^[#\w\s.,%()+\-/'"]{0,120}$/;

function sanitizeStyle(style) {
  const out = {};
  if (!style || typeof style !== 'object') return out;
  for (const [k, v] of Object.entries(style)) {
    if (!STYLE_PROPS.has(k)) continue;
    const val = String(v ?? '').trim();
    if (!val) continue;
    if (!STYLE_VALUE.test(val) || /url\s*\(|expression|javascript|[;{}<>\\]/i.test(val)) continue;
    out[k] = val;
  }
  return out;
}

function sanitizeCss(css) {
  return String(css || '').slice(0, 30000)
    .replace(/<\/?\s*style/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/expression\s*\(|javascript:|behavior\s*:/gi, '')
    .replace(/@import[^;]*;?/gi, (m) => (/^@import\s+url\(\s*["']?https:\/\/fonts\.googleapis\.com\//i.test(m) ? m : ''));
}

const plain = (s, max = 400) => String(s ?? '').replace(/[<>]/g, '').slice(0, max).trim();

module.exports = { safeUrl, safeImageUrl, sanitizeInline, sanitizeBlock, sanitizeStyle, sanitizeCss, plain, escAttr };
