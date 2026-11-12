'use strict';
// Ring 0 Studio — Google Drive API v3 Connector (Read-Only Folder & File Ingestion).
// Zero external npm dependencies: uses Node's built-in crypto (RS256 JWT for Service Account)
// and global fetch() to read folders and files from Google Drive into the Ring 0–3 Works Repository.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const S = require('./sanitize');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Extract clean Google Drive Folder/File ID from either a full URL or a raw ID string.
function parseDriveId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.toLowerCase() === 'root') return 'root';
  const folderMatch = /\/folders\/([a-zA-Z0-9_-]{10,})/.exec(raw);
  if (folderMatch) return folderMatch[1];
  const fileMatch = /\/d\/([a-zA-Z0-9_-]{10,})/.exec(raw);
  if (fileMatch) return fileMatch[1];
  const idParam = /[?&]id=([a-zA-Z0-9_-]{10,})/.exec(raw);
  if (idParam) return idParam[1];
  if (/^[a-zA-Z0-9_-]{10,120}$/.test(raw)) return raw;
  return '';
}

// Infer Ring 0..3 from folder name or file name tags like "[Ring 0]", "[R2]", "Ring 3 - Public", etc.
function inferRingFromName(name, fallback = null) {
  const s = String(name || '').toLowerCase();
  if (/(?:\bring\s*0\b|\br0\b|\[r0\]|\[ring\s*0\]|sovereign|pribadi|rahasia)/i.test(s)) return 0;
  if (/(?:\bring\s*1\b|\br1\b|\[r1\]|\[ring\s*1\]|inner\s*circle|eksekutor)/i.test(s)) return 1;
  if (/(?:\bring\s*2\b|\br2\b|\[r2\]|\[ring\s*2\]|licensed\s*member|member|anggota)/i.test(s)) return 2;
  if (/(?:\bring\s*3\b|\br3\b|\[r3\]|\[ring\s*3\]|public|publik|umum)/i.test(s)) return 3;
  return fallback;
}

// Infer work type from file name, folder name, or MIME type.
function inferWorkType(name, mimeType = '', types = []) {
  const s = String(name || '').toLowerCase();
  const m = String(mimeType || '').toLowerCase();
  for (const t of types) {
    if (new RegExp(`(?:\\b|\\[)${t}(?:\\b|\\])`, 'i').test(s)) return t;
  }
  if (/(?:\bbook\b|\bbuku\b|\bjilid\b|\bmonograph\b)/i.test(s)) return 'buku';
  if (/(?:\bessay\b|\besai\b)/i.test(s)) return 'esai';
  if (/(?:\barticle\b|\bartikel\b)/i.test(s)) return 'artikel';
  if (/(?:\bmodule\b|\bmodul\b|\bworkbook\b)/i.test(s)) return 'modul';
  if (/(?:\bframework\b|\bkerangka\b|\borbex\b)/i.test(s)) return 'kerangka';
  if (/(?:\bhymn\b|\bhimne\b|\bpuisi\b)/i.test(s)) return 'himne';
  if (/(?:\bsong\b|\blagu\b)/i.test(s)) return 'lagu';
  if (/(?:\btalk\b|\bkeynote\b|\bceramah\b|\bspeech\b)/i.test(s)) return 'ceramah';
  if (/(?:\bmemoir\b|\bmemoar\b)/i.test(s)) return 'memoar';
  if (/(?:\bnote\b|\bcatatan\b|\bmandat\b)/i.test(s)) return 'catatan';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'esai';
}

// Infer language ('id' or 'en') from text sample.
function inferLang(title, text) {
  const sample = (' ' + String(title || '') + ' ' + String(text || '').slice(0, 1500) + ' ').toLowerCase();
  const enHits = (sample.match(/\b(the|and|for|with|that|this|from|leadership|governance|enterprise)\b/g) || []).length;
  const idHits = (sample.match(/\b(dan|yang|untuk|dengan|dalam|adalah|kepemimpinan|organisasi|keluarga|budaya)\b/g) || []).length;
  return enHits > idHits + 2 ? 'en' : 'id';
}

// Clean file title (strip extension and bracketed ring/type tags).
function cleanTitleFromFilename(filename) {
  return String(filename || '')
    .replace(/\.(txt|md|markdown|docx|pdf|doc|json|mp3|mp4|wav|m4a)$/i, '')
    .replace(/^\s*\[(?:ring\s*[0-3]|r[0-3])\]\s*/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lightweight pure-Node DOCX text extractor (reads word/document.xml from ZIP local entries).
function extractTextFromDocxBuffer(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 30) return '';
    let offset = 0;
    while (offset + 30 <= buf.length) {
      const sig = buf.readUInt32LE(offset);
      if (sig !== 0x04034b50) break; // Local file header signature
      const compression = buf.readUInt16LE(offset + 8);
      const compSize = buf.readUInt32LE(offset + 18);
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
      const dataStart = offset + 30 + nameLen + extraLen;
      const dataEnd = dataStart + compSize;
      if (dataEnd > buf.length) break;
      if (name === 'word/document.xml' && compSize > 0) {
        const rawEntry = buf.subarray(dataStart, dataEnd);
        const xmlBuf = compression === 0 ? rawEntry : (compression === 8 ? zlib.inflateRawSync(rawEntry) : null);
        if (!xmlBuf) return '';
        return xmlBuf
          .toString('utf8')
          .replace(/<\/w:p>/g, '\n\n')
          .replace(/<w:br[^>]*\/>/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
      offset = dataEnd;
    }
  } catch (_) {}
  return '';
}

module.exports = function createGDriveConnector(ctx) {
  const { DATA, readJson, writeJson, vault, audit } = ctx;
  const cfgFile = () => path.join(DATA, 'gdrive-config.json');

  let cachedToken = null; // { token, expiresAt }
  let syncTimer = null;
  let customFetch = null; // Optional test hook

  function defaultConfig() {
    return {
      enabled: false,
      authMode: 'service_account', // 'service_account' | 'oauth2' | 'api_key'
      clientEmail: '',
      projectId: '',
      sealedServiceAccount: null,
      oauthClientId: '',
      sealedOauthClientSecret: null,
      sealedOauthRefreshToken: null,
      oauthRedirectUri: '',
      sealedApiKey: null,
      rootFolderId: '',
      ringFolders: { 0: '', 1: '', 2: '', 3: '' },
      defaultRing: 0, // Stricter Wins default
      autoPublish: true,
      autoSyncKnowledge: true,
      autoSyncMinutes: 0,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncSummary: null,
      updatedAt: new Date().toISOString()
    };
  }

  function ensure() {
    if (!fs.existsSync(cfgFile())) {
      writeJson(cfgFile(), defaultConfig());
    }
    const cfg = loadConfig();
    setupAutoSyncTimer(cfg.autoSyncMinutes);
  }

  function loadConfig() {
    const raw = readJson(cfgFile());
    const def = defaultConfig();
    if (!raw || typeof raw !== 'object') return def;
    return {
      ...def,
      ...raw,
      ringFolders: { 0: '', 1: '', 2: '', 3: '', ...(raw.ringFolders || {}) }
    };
  }

  function saveConfig(cfg) {
    cfg.updatedAt = new Date().toISOString();
    writeJson(cfgFile(), cfg);
  }

  // Returns public-safe view of configuration (never exposes private_key, client_secret, refresh_token, or API key in plain text).
  function publicConfigView() {
    const cfg = loadConfig();
    const envSa = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const envKey = Boolean(process.env.GOOGLE_DRIVE_API_KEY);
    const envOauthId = Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID);
    const envOauthSecret = Boolean(process.env.GOOGLE_OAUTH_CLIENT_SECRET);
    const envOauthRefresh = Boolean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN);

    const hasSa = Boolean((cfg.sealedServiceAccount && cfg.sealedServiceAccount.data) || envSa);
    const hasKey = Boolean((cfg.sealedApiKey && cfg.sealedApiKey.data) || envKey);
    const hasOauthId = Boolean(cfg.oauthClientId || envOauthId);
    const hasOauthSecret = Boolean((cfg.sealedOauthClientSecret && cfg.sealedOauthClientSecret.data) || envOauthSecret);
    const hasOauthRefresh = Boolean((cfg.sealedOauthRefreshToken && cfg.sealedOauthRefreshToken.data) || envOauthRefresh);
    const hasOauth = Boolean(hasOauthId && hasOauthSecret && hasOauthRefresh);

    const configured = hasSa || hasOauth || hasKey;
    const effectiveMode = cfg.authMode === 'oauth2' && (hasOauth || (hasOauthId && hasOauthSecret))
      ? 'oauth2'
      : (cfg.authMode === 'service_account' && hasSa
          ? 'service_account'
          : (cfg.authMode === 'api_key' && hasKey
              ? 'api_key'
              : (hasOauth ? 'oauth2' : (hasSa ? 'service_account' : (hasKey ? 'api_key' : (cfg.authMode || 'service_account'))))));

    return {
      enabled: Boolean(cfg.enabled),
      configured,
      authMode: effectiveMode,
      clientEmail: cfg.clientEmail || (envSa ? '(via GOOGLE_SERVICE_ACCOUNT_JSON)' : ''),
      projectId: cfg.projectId || '',
      hasServiceAccount: hasSa,
      serviceAccountHint: (cfg.sealedServiceAccount && cfg.sealedServiceAccount.hint) || (envSa ? 'ENV:GOOGLE_SERVICE_ACCOUNT_JSON' : ''),
      hasOauth,
      hasOauthClientId: hasOauthId,
      oauthClientId: cfg.oauthClientId || (envOauthId ? '(via ENV:GOOGLE_OAUTH_CLIENT_ID)' : ''),
      oauthRedirectUri: cfg.oauthRedirectUri || '',
      hasOauthSecret,
      hasOauthClientSecret: hasOauthSecret,
      oauthSecretHint: (cfg.sealedOauthClientSecret && cfg.sealedOauthClientSecret.hint) || (envOauthSecret ? 'ENV:GOOGLE_OAUTH_CLIENT_SECRET' : ''),
      hasOauthRefresh,
      hasOauthRefreshToken: hasOauthRefresh,
      oauthRefreshHint: (cfg.sealedOauthRefreshToken && cfg.sealedOauthRefreshToken.hint) || (envOauthRefresh ? 'ENV:GOOGLE_OAUTH_REFRESH_TOKEN' : ''),
      hasApiKey: hasKey,
      apiKeyHint: (cfg.sealedApiKey && cfg.sealedApiKey.hint) || (envKey ? 'ENV:GOOGLE_DRIVE_API_KEY' : ''),
      rootFolderId: cfg.rootFolderId || '',
      ringFolders: cfg.ringFolders || { 0: '', 1: '', 2: '', 3: '' },
      defaultRing: [0, 1, 2, 3].includes(Number(cfg.defaultRing)) ? Number(cfg.defaultRing) : 0,
      autoPublish: Boolean(cfg.autoPublish),
      autoSyncKnowledge: Boolean(cfg.autoSyncKnowledge),
      autoSyncMinutes: Number(cfg.autoSyncMinutes || 0),
      lastSyncAt: cfg.lastSyncAt || null,
      lastSyncStatus: cfg.lastSyncStatus || null,
      lastSyncSummary: cfg.lastSyncSummary || null,
      updatedAt: cfg.updatedAt
    };
  }

  function resolveOAuthParams(cfg) {
    const clientId = (cfg && cfg.oauthClientId) || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    const clientSecret = (cfg && cfg.sealedOauthClientSecret && vault.open(cfg.sealedOauthClientSecret)) || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
    const refreshToken = (cfg && cfg.sealedOauthRefreshToken && vault.open(cfg.sealedOauthRefreshToken)) || process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '';
    return {
      clientId: String(clientId).trim(),
      clientSecret: String(clientSecret).trim(),
      refreshToken: String(refreshToken).trim()
    };
  }

  function resolveCredentials() {
    const cfg = loadConfig();
    const oauth = resolveOAuthParams(cfg);

    // If explicitly set to oauth2 and credentials exist, prioritize oauth2
    if (cfg.authMode === 'oauth2' && oauth.clientId && oauth.clientSecret && oauth.refreshToken) {
      return { mode: 'oauth2', ...oauth, tokenUri: TOKEN_URL };
    }

    if (cfg.authMode === 'service_account' || (cfg.sealedServiceAccount && cfg.sealedServiceAccount.data) || process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const rawJson = (cfg.sealedServiceAccount && vault.open(cfg.sealedServiceAccount)) || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
      if (rawJson) {
        try {
          const parsed = JSON.parse(rawJson);
          if (parsed && parsed.client_email && parsed.private_key) {
            return { mode: 'service_account', clientEmail: parsed.client_email, privateKey: parsed.private_key, tokenUri: parsed.token_uri || TOKEN_URL };
          }
        } catch (_) {}
      }
    }

    // Fallback to oauth2 if configured
    if (oauth.clientId && oauth.clientSecret && oauth.refreshToken) {
      return { mode: 'oauth2', ...oauth, tokenUri: TOKEN_URL };
    }

    const apiKey = (cfg.sealedApiKey && vault.open(cfg.sealedApiKey)) || process.env.GOOGLE_DRIVE_API_KEY || '';
    if (apiKey) {
      return { mode: 'api_key', apiKey };
    }
    return { mode: 'none' };
  }

  function createServiceAccountJwt(clientEmail, privateKey, tokenUri = TOKEN_URL) {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: clientEmail,
      scope: DRIVE_SCOPE,
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600
    };
    const signingInput = base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(payload));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const pem = String(privateKey).replace(/\\n/g, '\n');
    const signature = signer.sign(pem);
    return signingInput + '.' + base64UrlEncode(signature);
  }

  function buildOAuthConsentUrl(origin = '', customRedirectUri = '') {
    const cfg = loadConfig();
    const { clientId } = resolveOAuthParams(cfg);
    if (!clientId) {
      throw new Error('OAuth Client ID belum diisi. Masukkan OAuth Client ID dari Google Cloud Console terlebih dahulu.');
    }
    const redirectUri = String(customRedirectUri || cfg.oauthRedirectUri || (origin ? `${origin.replace(/\/+$/, '')}/admin/api/works/gdrive/oauth-callback` : '')).trim();
    if (!redirectUri) {
      throw new Error('Redirect URI OAuth tidak ditemukan.');
    }
    const state = crypto.randomBytes(24).toString('hex');
    cfg.pendingOauthState = { state, exp: Date.now() + 15 * 60 * 1000 };
    saveConfig(cfg);

    const u = new URL(AUTH_URL);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', DRIVE_SCOPE);
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', state);
    return { url: u.toString(), redirectUri, clientId, state };
  }

  function verifyOAuthState(stateToken) {
    if (!stateToken) return false;
    const cfg = loadConfig();
    const p = cfg.pendingOauthState;
    if (!p || !p.state || !p.exp || Date.now() > Number(p.exp)) return false;
    const a = Buffer.from(String(stateToken));
    const b = Buffer.from(String(p.state));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    delete cfg.pendingOauthState;
    saveConfig(cfg);
    return true;
  }

  async function exchangeOAuthCode(code, origin = '', customRedirectUri = '') {
    const doFetch = customFetch || globalThis.fetch;
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new Error('Kode otorisasi OAuth (code) kosong.');
    const cfg = loadConfig();
    const { clientId, clientSecret } = resolveOAuthParams(cfg);
    if (!clientId || !clientSecret) {
      throw new Error('OAuth Client ID dan Client Secret harus disimpan terlebih dahulu sebelum menukar kode otorisasi.');
    }
    const redirectUri = String(customRedirectUri || cfg.oauthRedirectUri || (origin ? `${origin.replace(/\/+$/, '')}/admin/api/works/gdrive/oauth-callback` : 'https://developers.google.com/oauthplayground')).trim();
    const bodyStr = new URLSearchParams({
      code: cleanCode,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString();

    const resp = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyStr
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || (!data.refresh_token && !data.access_token)) {
      const msg = data.error_description || data.error || ('HTTP ' + resp.status);
      throw new Error('Gagal menukar kode OAuth Google Drive: ' + msg);
    }
    if (data.refresh_token) {
      cfg.sealedOauthRefreshToken = vault.seal(String(data.refresh_token).trim());
    }
    cfg.authMode = 'oauth2';
    cfg.enabled = true;
    saveConfig(cfg);
    if (data.access_token) {
      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
      };
    } else {
      cachedToken = null;
    }
    return {
      ok: true,
      hasRefreshToken: Boolean(data.refresh_token || (cfg.sealedOauthRefreshToken && cfg.sealedOauthRefreshToken.data)),
      scope: data.scope || DRIVE_SCOPE
    };
  }

  async function getAccessToken() {
    const doFetch = customFetch || globalThis.fetch;
    const creds = resolveCredentials();
    if (creds.mode === 'none') {
      throw new Error('Kredensial Google Drive belum dikonfigurasi. Pilih OAuth 2.0, Service Account JSON, atau API Key terlebih dahulu.');
    }
    if (creds.mode === 'api_key') {
      return { mode: 'api_key', apiKey: creds.apiKey };
    }
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
      return { mode: creds.mode, accessToken: cachedToken.token };
    }

    if (creds.mode === 'oauth2') {
      const bodyStr = new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: 'refresh_token'
      }).toString();
      const resp = await doFetch(creds.tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyStr
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.access_token) {
        const msg = data.error_description || data.error || ('HTTP ' + resp.status);
        throw new Error('Gagal memperbarui Access Token OAuth 2.0 Google Drive: ' + msg);
      }
      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
      };
      return { mode: 'oauth2', accessToken: cachedToken.token };
    }

    const assertion = createServiceAccountJwt(creds.clientEmail, creds.privateKey, creds.tokenUri);
    const bodyStr = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString();

    const resp = await doFetch(creds.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyStr
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
      const msg = data.error_description || data.error || ('HTTP ' + resp.status);
      throw new Error('Gagal mendapatkan token OAuth Google Drive: ' + msg);
    }
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
    };
    return { mode: 'service_account', accessToken: cachedToken.token };
  }

  async function driveFetch(urlStr, opts = {}) {
    const doFetch = customFetch || globalThis.fetch;
    const auth = await getAccessToken();
    const u = new URL(urlStr);
    const headers = { ...(opts.headers || {}) };
    if (auth.mode === 'service_account' || auth.mode === 'oauth2') {
      headers.Authorization = 'Bearer ' + auth.accessToken;
    } else if (auth.mode === 'api_key') {
      u.searchParams.set('key', auth.apiKey);
    }
    return doFetch(u.toString(), { ...opts, headers });
  }

  // Get metadata for a single file or folder by ID.
  async function getFileMeta(fileId) {
    const cleanId = parseDriveId(fileId);
    if (!cleanId) throw new Error('Folder/File ID Google Drive tidak valid.');
    if (cleanId === 'root') {
      return {
        id: 'root',
        name: 'Google Drive Utama (My Drive)',
        mimeType: 'application/vnd.google-apps.folder'
      };
    }
    const u = new URL(DRIVE_API + '/' + encodeURIComponent(cleanId));
    u.searchParams.set('fields', 'id,name,mimeType,description,modifiedTime,createdTime,size,webViewLink,webContentLink,thumbnailLink,parents');
    u.searchParams.set('supportsAllDrives', 'true');
    const r = await driveFetch(u.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const errMsg = (data.error && data.error.message) || ('HTTP ' + r.status);
      throw new Error(`Gagal mengakses ID "${cleanId}": ${errMsg}`);
    }
    return data;
  }

  // List files and folders inside a Google Drive folder.
  async function listFolderChildren(folderId, pageSize = 100) {
    const cleanId = parseDriveId(folderId);
    if (!cleanId) throw new Error('Folder ID Google Drive kosong atau tidak valid.');
    const u = new URL(DRIVE_API);
    u.searchParams.set('q', `'${cleanId.replace(/'/g, "\\'")}' in parents and trashed = false`);
    u.searchParams.set('fields', 'files(id,name,mimeType,description,modifiedTime,createdTime,size,webViewLink,webContentLink,thumbnailLink)');
    u.searchParams.set('orderBy', 'folder,name');
    u.searchParams.set('pageSize', String(Math.min(Math.max(Number(pageSize) || 100, 1), 500)));
    u.searchParams.set('supportsAllDrives', 'true');
    u.searchParams.set('includeItemsFromAllDrives', 'true');

    const r = await driveFetch(u.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const errMsg = (data.error && data.error.message) || ('HTTP ' + r.status);
      throw new Error(`Gagal membaca isi folder "${cleanId}": ${errMsg}`);
    }
    const items = Array.isArray(data.files) ? data.files : [];
    const folders = items.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    const files = items.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
    return { folderId: cleanId, folders, files, total: items.length };
  }

  // Read/extract text content from a Google Drive file.
  async function readFileContent(fileOrId) {
    const meta = typeof fileOrId === 'object' && fileOrId && fileOrId.id
      ? fileOrId
      : await getFileMeta(fileOrId);
    const id = meta.id;
    const mime = String(meta.mimeType || '').toLowerCase();
    const name = String(meta.name || '');

    let text = '';
    if (mime === 'application/vnd.google-apps.document' || mime === 'application/vnd.google-apps.presentation') {
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}/export`);
      u.searchParams.set('mimeType', 'text/plain');
      const r = await driveFetch(u.toString());
      if (r.ok) text = await r.text();
    } else if (mime === 'application/vnd.google-apps.spreadsheet') {
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}/export`);
      u.searchParams.set('mimeType', 'text/csv');
      const r = await driveFetch(u.toString());
      if (r.ok) text = await r.text();
    } else if (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      /\.(txt|md|markdown|csv|json)$/i.test(name)
    ) {
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
      u.searchParams.set('alt', 'media');
      u.searchParams.set('supportsAllDrives', 'true');
      const r = await driveFetch(u.toString());
      if (r.ok) text = await r.text();
    } else if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(name)
    ) {
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
      u.searchParams.set('alt', 'media');
      u.searchParams.set('supportsAllDrives', 'true');
      const r = await driveFetch(u.toString());
      if (r.ok) {
        const ab = await r.arrayBuffer();
        text = extractTextFromDocxBuffer(Buffer.from(ab));
      }
    }

    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    return {
      meta,
      text: text.slice(0, 200000),
      extracted: Boolean(text)
    };
  }

  // Gather all target folders and their assigned Ring (0..3) based on config + subfolder discovery.
  async function discoverRingFolders() {
    const cfg = loadConfig();
    const targets = []; // { folderId, folderName, ring, source }
    const seen = new Set();

    // 1. Explicit per-ring folders
    for (const r of [0, 1, 2, 3]) {
      const fid = parseDriveId(cfg.ringFolders && cfg.ringFolders[r]);
      if (fid && !seen.has(fid)) {
        seen.add(fid);
        targets.push({ folderId: fid, folderName: `Folder Ring ${r}`, ring: r, source: 'ring_folder' });
      }
    }

    // 2. Root folder & its direct subfolders
    const rootId = parseDriveId(cfg.rootFolderId);
    if (rootId) {
      const rootChildren = await listFolderChildren(rootId, 100);
      if (!seen.has(rootId)) {
        seen.add(rootId);
        targets.push({
          folderId: rootId,
          folderName: 'Root Folder',
          ring: [0, 1, 2, 3].includes(Number(cfg.defaultRing)) ? Number(cfg.defaultRing) : 0,
          source: 'root_direct',
          preloadedFiles: rootChildren.files
        });
      }
      for (const sub of rootChildren.folders) {
        if (seen.has(sub.id)) continue;
        seen.add(sub.id);
        const inferred = inferRingFromName(sub.name, [0, 1, 2, 3].includes(Number(cfg.defaultRing)) ? Number(cfg.defaultRing) : 0);
        targets.push({
          folderId: sub.id,
          folderName: sub.name,
          ring: inferred,
          source: 'root_subfolder'
        });
      }
    }

    return targets;
  }

  function setupAutoSyncTimer(minutes, onTick) {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    const mins = Number(minutes || 0);
    if (mins >= 5 && typeof onTick === 'function') {
      syncTimer = setInterval(() => {
        onTick().catch(() => {});
      }, mins * 60 * 1000);
      if (syncTimer && typeof syncTimer.unref === 'function') syncTimer.unref();
    }
  }

  return {
    ensure,
    loadConfig,
    saveConfig,
    publicConfigView,
    parseDriveId,
    inferRingFromName,
    inferWorkType,
    inferLang,
    cleanTitleFromFilename,
    getFileMeta,
    listFolderChildren,
    readFileContent,
    discoverRingFolders,
    setupAutoSyncTimer,
    buildOAuthConsentUrl,
    verifyOAuthState,
    exchangeOAuthCode,
    setCustomFetch: (fn) => { customFetch = fn; },
    clearTokenCache: () => { cachedToken = null; }
  };
};
