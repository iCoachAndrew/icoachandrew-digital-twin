'use strict';
// Secret vault: API keys and payment-gateway secrets are encrypted at rest (AES-256-GCM).
// The key comes from ICOACH_SECRET_KEY, or a random key file kept beside the data folder.
// Secrets are never returned to the browser in clear text — only masked hints.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function createVault(DATA) {
  let key;
  function getKey() {
    if (key) return key;
    if (process.env.ICOACH_SECRET_KEY) {
      key = crypto.createHash('sha256').update(process.env.ICOACH_SECRET_KEY).digest();
      return key;
    }
    const f = path.join(DATA, '.vault.key');
    fs.mkdirSync(DATA, { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    key = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    return key;
  }

  function seal(plain) {
    if (!plain) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64'), hint: mask(plain) };
  }

  function open(sealed) {
    if (!sealed || !sealed.data) return '';
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(sealed.iv, 'base64'));
      d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8');
    } catch (_) {
      return '';
    }
  }

  function mask(plain) {
    const s = String(plain || '');
    if (!s) return '';
    if (s.length <= 8) return '••••';
    return s.slice(0, Math.min(7, Math.floor(s.length / 4))) + '••••' + s.slice(-4);
  }

  return { seal, open, mask, hint: (sealed) => (sealed && sealed.hint) || '' };
};
