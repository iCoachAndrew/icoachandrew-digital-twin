'use strict';
// Secret vault: API keys and payment-gateway secrets are encrypted at rest (AES-256-GCM).
// The key comes from ICOACH_SECRET_KEY, or a random key file kept beside the data folder.
// Secrets are never returned to the browser in clear text — only masked hints.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function createVault(DATA) {
  let cachedFileKey = null;

  function getMirrorDirs() {
    const dirs = [];
    if (process.env.ICOACH_PERSISTENT_MIRROR) dirs.push(process.env.ICOACH_PERSISTENT_MIRROR);
    if (process.env.NODE_ENV === 'test') return dirs;
    try {
      const home = os.homedir();
      if (home) dirs.push(path.join(home, '.icoachandrew_persistent'));
    } catch (_) {}
    return dirs;
  }

  function getEnvSecretKey() {
    if (!process.env.ICOACH_SECRET_KEY) return null;
    return crypto.createHash('sha256').update(process.env.ICOACH_SECRET_KEY).digest();
  }

  function getFallbackPassphraseKey() {
    if (!process.env.ADMIN_PASSPHRASE) return null;
    return crypto.createHash('sha256').update('icoach-vault-v1:' + process.env.ADMIN_PASSPHRASE).digest();
  }

  function readKeyFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const hex = fs.readFileSync(filePath, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    } catch (_) {}
    return null;
  }

  function mirrorVaultKeyIfAbsent(hexStr) {
    for (const dir of getMirrorDirs()) {
      try {
        const dst = path.join(dir, '.vault.key');
        if (fs.existsSync(dst)) continue; // Never overwrite an existing mirrored vault key
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(dir, 0o700); } catch (_) {}
        fs.writeFileSync(dst, hexStr, { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(dst, 0o600); } catch (_) {}
      } catch (_) {}
    }
  }

  function getOrCreateFileKey() {
    const f = path.join(DATA, '.vault.key');
    const existing = readKeyFile(f);
    if (existing) {
      cachedFileKey = existing;
      return existing;
    }
    // Before generating a brand new key, check persistent mirror dirs so redeploys keep decrypting old secrets
    for (const dir of getMirrorDirs()) {
      const mirrored = readKeyFile(path.join(dir, '.vault.key'));
      if (mirrored) {
        try {
          fs.mkdirSync(DATA, { recursive: true });
          fs.writeFileSync(f, mirrored.toString('hex'), { mode: 0o600 });
          try { fs.chmodSync(f, 0o600); } catch (_) {}
        } catch (_) {}
        cachedFileKey = mirrored;
        return mirrored;
      }
    }
    fs.mkdirSync(DATA, { recursive: true });
    const fb = getFallbackPassphraseKey();
    const hexToWrite = fb ? fb.toString('hex') : crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, hexToWrite, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch (_) {}
    mirrorVaultKeyIfAbsent(hexToWrite);
    cachedFileKey = Buffer.from(hexToWrite, 'hex');
    return cachedFileKey;
  }

  function getKey() {
    const envSecret = getEnvSecretKey();
    if (envSecret) return envSecret;
    return getOrCreateFileKey();
  }

  function keySource() {
    if (process.env.ICOACH_SECRET_KEY) return 'env_secret';
    if (process.env.ADMIN_PASSPHRASE) return 'env_passphrase';
    return 'vault_file';
  }

  function seal(plain) {
    if (!plain) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64'), hint: mask(plain) };
  }

  function tryDecryptWithKey(sealed, k) {
    if (!k) return '';
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(sealed.iv, 'base64'));
      d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8');
    } catch (_) {
      return '';
    }
  }

  function candidateKeys() {
    const seen = new Set();
    const out = [];
    const add = (buf) => {
      if (!buf || !Buffer.isBuffer(buf) || buf.length !== 32) return;
      const hex = buf.toString('hex');
      if (seen.has(hex)) return;
      seen.add(hex);
      out.push(buf);
    };
    add(getKey());
    add(getEnvSecretKey());
    add(getFallbackPassphraseKey());
    add(readKeyFile(path.join(DATA, '.vault.key')));
    if (cachedFileKey) add(cachedFileKey);
    for (const dir of getMirrorDirs()) {
      add(readKeyFile(path.join(dir, '.vault.key')));
    }
    return out;
  }

  function open(sealed) {
    if (!sealed || !sealed.data || !sealed.iv || !sealed.tag) return '';
    for (const k of candidateKeys()) {
      const dec = tryDecryptWithKey(sealed, k);
      if (dec) return dec;
    }
    return '';
  }

  function canOpen(sealed) {
    return Boolean(open(sealed));
  }

  function needsReseal(sealed) {
    if (!sealed || !sealed.data || !sealed.iv || !sealed.tag) return false;
    if (tryDecryptWithKey(sealed, getKey())) return false;
    return Boolean(open(sealed));
  }

  function mask(plain) {
    const s = String(plain || '');
    if (!s) return '';
    if (s.length <= 8) return '••••';
    return s.slice(0, Math.min(7, Math.floor(s.length / 4))) + '••••' + s.slice(-4);
  }

  return { seal, open, canOpen, needsReseal, mask, keySource, hint: (sealed) => (sealed && sealed.hint) || '' };
};
