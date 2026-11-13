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

// Infer Ring 0..3 or 'irrelevant' from folder name or file name tags like "[Ring 0]", "[R2]", "Ring 3 - Public", "[Irrelevant]", etc.
function inferRingFromName(name, fallback = null) {
  const s = String(name || '').toLowerCase();
  if (/(?:\birrelevant\b|\bunassigned\b|\babaikan\b|\[skip\]|\[ignore\])/i.test(s)) return 'irrelevant';
  if (/(?:\bring\s*0\b|\br0\b|\[r0\]|\[ring\s*0\])/i.test(s)) return 0;
  if (/(?:\bring\s*1\b|\br1\b|\[r1\]|\[ring\s*1\])/i.test(s)) return 1;
  if (/(?:\bring\s*2\b|\br2\b|\[r2\]|\[ring\s*2\])/i.test(s)) return 2;
  if (/(?:\bring\s*3\b|\br3\b|\[r3\]|\[ring\s*3\])/i.test(s)) return 3;
  return fallback;
}

// Fuzzy search scorer (0 = no match, up to 100 = exact match).
function fuzzyScore(query, target) {
  const q = String(query || '').trim().toLowerCase();
  const t = String(target || '').trim().toLowerCase();
  if (!q) return 1;
  if (!t) return 0;
  if (t === q) return 100;
  if (t.includes(q)) return 92 - Math.min(20, Math.floor(t.indexOf(q) / 3));

  const qTokens = q.split(/[\s_\-./]+/).filter(Boolean);
  const tTokens = t.split(/[\s_\-./()[\]]+/).filter(Boolean);

  // Check if all query tokens match as substrings or close fuzzy matches
  let matchedTokens = 0;
  let scoreSum = 0;
  for (const qt of qTokens) {
    if (t.includes(qt)) {
      matchedTokens++;
      scoreSum += 80;
      continue;
    }
    // Check subsequence or edit distance <= 2 against target tokens
    let bestTokScore = 0;
    for (const tt of tTokens) {
      if (tt.startsWith(qt) || qt.startsWith(tt)) {
        bestTokScore = Math.max(bestTokScore, 70);
      } else {
        // Subsequence check
        let qi = 0;
        for (let ti = 0; ti < tt.length && qi < qt.length; ti++) {
          if (tt[ti] === qt[qi]) qi++;
        }
        if (qi === qt.length && qt.length >= 2) {
          bestTokScore = Math.max(bestTokScore, 60);
        } else if (qt.length >= 4 && Math.abs(qt.length - tt.length) <= 2) {
          // Simple character overlap / transposition tolerance
          let common = 0;
          for (const ch of qt) {
            if (tt.includes(ch)) common++;
          }
          if (common >= qt.length - 1) bestTokScore = Math.max(bestTokScore, 52);
        }
      }
    }
    if (bestTokScore > 0) {
      matchedTokens++;
      scoreSum += bestTokScore;
    }
  }
  if (matchedTokens === qTokens.length && qTokens.length > 0) {
    return Math.round(scoreSum / qTokens.length);
  }

  // Full string subsequence fallback
  let qi = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      if (consecutive > maxConsecutive) maxConsecutive = consecutive;
    } else {
      consecutive = 0;
    }
  }
  if (qi === q.length && q.length >= 3) {
    return 40 + Math.min(25, maxConsecutive * 4);
  }
  return 0;
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
    .replace(/^\s*\[(?:ring\s*[0-3]|r[0-3]|irrelevant|unassigned)\]\s*/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Convert extracted work text & metadata into a structured, lightweight Markdown (.md) document for AI context.
function convertToMarkdownDocument(info = {}) {
  const title = String(info.title || 'Dokumen Karya Andrew Tani').trim();
  const ringLabel = [0, 1, 2, 3].includes(Number(info.ring)) ? Number(info.ring) : 'unassigned';
  const type = String(info.type || 'esai').trim();
  const lang = String(info.lang || 'id').trim();
  const year = String(info.year || new Date().getFullYear()).trim();
  const fileId = String(info.fileId || '').trim();
  const fileName = String(info.fileName || '').trim();
  const folderName = String(info.folderName || '').trim();
  const method = String(info.extractionMethod || 'text').trim();
  const syncedAt = String(info.syncedAt || new Date().toISOString()).trim();
  const summary = String(info.summary || '').trim();
  const rawBody = String(info.content || '').replace(/\r\n/g, '\n').trim();

  // Normalize body paragraphs into clean Markdown
  const lines = rawBody.split('\n');
  const mdLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (mdLines.length && mdLines[mdLines.length - 1] !== '') mdLines.push('');
      continue;
    }
    // Preserve existing Markdown headings/lists or promote ALL-CAPS short lines as subheadings
    if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>)/.test(trimmed)) {
      mdLines.push(trimmed);
    } else if (trimmed.length >= 4 && trimmed.length <= 75 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed) && !/[.!?]$/.test(trimmed)) {
      mdLines.push(`### ${trimmed}`);
    } else {
      mdLines.push(trimmed);
    }
  }

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `ring: ${JSON.stringify(ringLabel)}`,
    `type: ${JSON.stringify(type)}`,
    `lang: ${JSON.stringify(lang)}`,
    `year: ${JSON.stringify(year)}`,
    ...(folderName ? [`folder: ${JSON.stringify(folderName)}`] : []),
    ...(fileName ? [`source_file: ${JSON.stringify(fileName)}`] : []),
    ...(fileId ? [`gdrive_file_id: ${JSON.stringify(fileId)}`] : []),
    `extraction_method: ${JSON.stringify(method)}`,
    `synced_at: ${JSON.stringify(syncedAt)}`,
    '---',
    '',
    `# ${title}`,
    ''
  ];
  if (summary) {
    frontmatter.push(`> **Ikhtisar Eksekutif:** ${summary.replace(/\n+/g, ' ')}`, '');
  }
  frontmatter.push(mdLines.join('\n').trim() || '*(Dokumen metadata terindeks — belum ada teks naskah)*', '');
  return frontmatter.join('\n');
}

// Pure-Node PDF Text Extractor (Non-OCR Digital PDF): decompresses FlateDecode streams, parses ToUnicode CMaps & BT..ET text blocks.
function decodePdfLiteralString(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i++;
    if (i >= str.length) break;
    const next = str[i];
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (/[0-7]/.test(next)) {
      let oct = next;
      if (i + 1 < str.length && /[0-7]/.test(str[i + 1])) oct += str[++i];
      if (i + 1 < str.length && /[0-7]/.test(str[i + 1])) oct += str[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else {
      out += next;
    }
  }
  return out;
}

function decodePdfHexString(hex, cmap) {
  const clean = hex.replace(/\s+/g, '');
  if (!clean) return '';
  if (/^feff/i.test(clean)) {
    // UTF-16BE string
    let s = '';
    for (let i = 4; i + 3 < clean.length; i += 4) {
      s += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    }
    return s;
  }
  if (cmap && cmap.size > 0) {
    // Try 4-hex (2-byte) or 2-hex (1-byte) lookup in ToUnicode CMap
    let s = '';
    const step = cmap.__twoByte ? 4 : 2;
    for (let i = 0; i + step <= clean.length; i += step) {
      const code = parseInt(clean.slice(i, i + step), 16);
      if (cmap.has(code)) s += cmap.get(code);
      else if (code >= 32 && code <= 126) s += String.fromCharCode(code);
    }
    if (s) return s;
  }
  let s = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if (code >= 32 && code <= 255) s += String.fromCharCode(code);
  }
  return s;
}

function extractTextFromPdfBuffer(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 16) return '';
    const rawLatin = buf.toString('latin1');
    if (!rawLatin.includes('%PDF-')) return '';

    const decodedStreams = [];
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m;
    while ((m = streamRegex.exec(rawLatin)) !== null) {
      const bodyLatin = m[1];
      const streamBuf = Buffer.from(bodyLatin, 'latin1');
      let decompressed = null;
      try {
        decompressed = zlib.inflateSync(streamBuf).toString('latin1');
      } catch (_) {
        try {
          decompressed = zlib.inflateRawSync(streamBuf).toString('latin1');
        } catch (__) {
          if (bodyLatin.includes('BT') || bodyLatin.includes('beginbfchar')) {
            decompressed = bodyLatin;
          }
        }
      }
      if (decompressed) decodedStreams.push(decompressed);
    }
    // Also include top-level uncompressed content if no streams matched
    if (!decodedStreams.length) decodedStreams.push(rawLatin);

    // 1. Parse any ToUnicode CMap tables first
    const cmap = new Map();
    for (const s of decodedStreams) {
      if (!s.includes('beginbfchar') && !s.includes('beginbfrange')) continue;
      const bfCharBlocks = s.match(/beginbfchar[\s\S]*?endbfchar/g) || [];
      for (const blk of bfCharBlocks) {
        const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let pm;
        while ((pm = pairRe.exec(blk)) !== null) {
          if (pm[1].length >= 4) cmap.__twoByte = true;
          const srcCode = parseInt(pm[1], 16);
          let dst = '';
          for (let i = 0; i + 3 < pm[2].length; i += 4) {
            dst += String.fromCharCode(parseInt(pm[2].slice(i, i + 4), 16));
          }
          if (!dst && pm[2].length === 2) dst = String.fromCharCode(parseInt(pm[2], 16));
          if (dst) cmap.set(srcCode, dst);
        }
      }
      const bfRangeBlocks = s.match(/beginbfrange[\s\S]*?endbfrange/g) || [];
      for (const blk of bfRangeBlocks) {
        const rangeRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let rm;
        while ((rm = rangeRe.exec(blk)) !== null) {
          if (rm[1].length >= 4) cmap.__twoByte = true;
          const start = parseInt(rm[1], 16);
          const end = parseInt(rm[2], 16);
          const targetStart = parseInt(rm[3], 16);
          if (end >= start && end - start <= 512) {
            for (let c = start; c <= end; c++) {
              cmap.set(c, String.fromCharCode(targetStart + (c - start)));
            }
          }
        }
      }
    }

    // 2. Extract text from BT ... ET blocks
    const paragraphs = [];
    for (const s of decodedStreams) {
      const btBlocks = s.match(/BT[\s\S]*?ET/g) || [];
      for (const bt of btBlocks) {
        const chunks = [];
        const tokenRe = /\((?:\\.|[^\\()])*\)|<([0-9a-fA-F\s]+)>|\b(Td|TD|T\*|ET)\b/g;
        let tm;
        while ((tm = tokenRe.exec(bt)) !== null) {
          const tok = tm[0];
          if (tok.startsWith('(') && tok.endsWith(')')) {
            chunks.push(decodePdfLiteralString(tok.slice(1, -1)));
          } else if (tm[1] !== undefined) {
            chunks.push(decodePdfHexString(tm[1], cmap));
          } else if (tm[2] === 'T*' || tm[2] === 'TD') {
            chunks.push('\n');
          }
        }
        const joined = chunks.join('').replace(/[ \t]+/g, ' ').trim();
        if (joined) paragraphs.push(joined);
      }
    }

    return paragraphs
      .join('\n')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (_) {
    return '';
  }
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
      folderRingMap: {}, // { [folderId]: 0 | 1 | 2 | 3 | 'irrelevant' | 'unassigned' }
      fileRingMap: {},   // { [fileId]: 0 | 1 | 2 | 3 | 'irrelevant' | 'unassigned' }
      defaultRing: 0, // Stricter Wins default when syncing root folder directly
      autoPublish: true,
      autoSyncKnowledge: true,
      autoConvertMd: true,
      enablePdfOcr: true,
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
      ringFolders: { 0: '', 1: '', 2: '', 3: '', ...(raw.ringFolders || {}) },
      folderRingMap: (raw.folderRingMap && typeof raw.folderRingMap === 'object') ? { ...raw.folderRingMap } : {},
      fileRingMap: (raw.fileRingMap && typeof raw.fileRingMap === 'object') ? { ...raw.fileRingMap } : {}
    };
  }

  function saveConfig(cfg) {
    cfg.updatedAt = new Date().toISOString();
    writeJson(cfgFile(), cfg);
  }

  function getPortableBundleKey() {
    const seed = process.env.ICOACH_SECRET_KEY || process.env.ADMIN_PASSPHRASE || 'icoach-gdrive-portable-v1';
    return crypto.createHash('sha256').update('gdrive-bundle-v1:' + seed).digest();
  }

  function createPortableBundle(cfg) {
    try {
      const oauth = resolveOAuthParams(cfg);
      const saRaw = (cfg && cfg.sealedServiceAccount && vault.open(cfg.sealedServiceAccount)) || '';
      const apiKeyRaw = (cfg && cfg.sealedApiKey && vault.open(cfg.sealedApiKey)) || '';
      const accessRaw = (cfg && cfg.sealedAccessToken && vault.open(cfg.sealedAccessToken)) || '';
      if (!oauth.refreshToken && !saRaw && !apiKeyRaw && !accessRaw) return null;
      const payload = {
        v: 1,
        enabled: Boolean(cfg.enabled),
        authMode: cfg.authMode || 'oauth2',
        clientEmail: cfg.clientEmail || '',
        projectId: cfg.projectId || '',
        serviceAccountJson: saRaw,
        oauthClientId: oauth.clientId,
        oauthClientSecret: oauth.clientSecret,
        oauthRefreshToken: oauth.refreshToken,
        accessToken: accessRaw,
        accessTokenExpiresAt: cfg.accessTokenExpiresAt || 0,
        oauthRedirectUri: cfg.oauthRedirectUri || '',
        oauthConnectedAt: cfg.oauthConnectedAt || null,
        apiKey: apiKeyRaw,
        rootFolderId: cfg.rootFolderId || '',
        ringFolders: cfg.ringFolders || { 0: '', 1: '', 2: '', 3: '' },
        folderRingMap: cfg.folderRingMap || {},
        fileRingMap: cfg.fileRingMap || {},
        defaultRing: cfg.defaultRing ?? 0,
        autoPublish: Boolean(cfg.autoPublish),
        autoSyncKnowledge: Boolean(cfg.autoSyncKnowledge),
        autoConvertMd: cfg.autoConvertMd !== false,
        enablePdfOcr: cfg.enablePdfOcr !== false,
        autoSyncMinutes: Number(cfg.autoSyncMinutes || 0)
      };
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', getPortableBundleKey(), iv);
      const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `gdb1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
    } catch (_) {
      return null;
    }
  }

  function restorePortableBundle(bundleStr) {
    const raw = String(bundleStr || '').trim();
    if (!raw.startsWith('gdb1.')) throw new Error('Format bundel pemulihan OAuth tidak valid.');
    const parts = raw.split('.');
    if (parts.length !== 4) throw new Error('Bundel pemulihan OAuth rusak.');
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getPortableBundleKey(), iv);
    decipher.setAuthTag(tag);
    const jsonStr = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') throw new Error('Isi bundel pemulihan kosong.');

    const cfg = loadConfig();
    cfg.enabled = parsed.enabled !== false;
    if (parsed.authMode) cfg.authMode = parsed.authMode;
    if (parsed.clientEmail) cfg.clientEmail = parsed.clientEmail;
    if (parsed.projectId) cfg.projectId = parsed.projectId;
    if (parsed.serviceAccountJson) cfg.sealedServiceAccount = vault.seal(parsed.serviceAccountJson);
    if (parsed.oauthClientId) cfg.oauthClientId = parsed.oauthClientId;
    if (parsed.oauthClientSecret) cfg.sealedOauthClientSecret = vault.seal(parsed.oauthClientSecret);
    if (parsed.oauthRefreshToken) cfg.sealedOauthRefreshToken = vault.seal(parsed.oauthRefreshToken);
    if (parsed.accessToken) {
      cfg.sealedAccessToken = vault.seal(parsed.accessToken);
      cfg.accessTokenExpiresAt = Number(parsed.accessTokenExpiresAt || 0);
    }
    if (parsed.oauthRedirectUri) cfg.oauthRedirectUri = parsed.oauthRedirectUri;
    if (parsed.oauthConnectedAt) cfg.oauthConnectedAt = parsed.oauthConnectedAt;
    if (parsed.apiKey) cfg.sealedApiKey = vault.seal(parsed.apiKey);
    if (parsed.rootFolderId !== undefined) cfg.rootFolderId = parsed.rootFolderId;
    if (parsed.ringFolders && typeof parsed.ringFolders === 'object') {
      cfg.ringFolders = { 0: '', 1: '', 2: '', 3: '', ...parsed.ringFolders };
    }
    if (parsed.folderRingMap && typeof parsed.folderRingMap === 'object') {
      cfg.folderRingMap = { ...parsed.folderRingMap };
    }
    if (parsed.fileRingMap && typeof parsed.fileRingMap === 'object') {
      cfg.fileRingMap = { ...parsed.fileRingMap };
    }
    if (parsed.defaultRing !== undefined) cfg.defaultRing = parsed.defaultRing;
    if (parsed.autoPublish !== undefined) cfg.autoPublish = Boolean(parsed.autoPublish);
    if (parsed.autoSyncKnowledge !== undefined) cfg.autoSyncKnowledge = Boolean(parsed.autoSyncKnowledge);
    if (parsed.autoConvertMd !== undefined) cfg.autoConvertMd = Boolean(parsed.autoConvertMd);
    if (parsed.enablePdfOcr !== undefined) cfg.enablePdfOcr = Boolean(parsed.enablePdfOcr);
    if (parsed.autoSyncMinutes !== undefined) cfg.autoSyncMinutes = Number(parsed.autoSyncMinutes || 0);
    saveConfig(cfg);
    cachedToken = null;
    return publicConfigView();
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
    const hasAccessFallback = Boolean(cfg.sealedAccessToken && cfg.sealedAccessToken.data && Number(cfg.accessTokenExpiresAt || 0) > Date.now() + 60000);
    const hasOauth = Boolean(hasOauthId && hasOauthSecret && (hasOauthRefresh || hasAccessFallback));

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
      oauthConnectedAt: cfg.oauthConnectedAt || null,
      lastTokenRefreshAt: cfg.lastTokenRefreshAt || null,
      sessionPersistenceMode: 'auto_refresh_30d_plus',
      sealedConfigBundle: configured ? createPortableBundle(cfg) : null,
      hasApiKey: hasKey,
      apiKeyHint: (cfg.sealedApiKey && cfg.sealedApiKey.hint) || (envKey ? 'ENV:GOOGLE_DRIVE_API_KEY' : ''),
      rootFolderId: cfg.rootFolderId || '',
      ringFolders: cfg.ringFolders || { 0: '', 1: '', 2: '', 3: '' },
      folderRingMap: cfg.folderRingMap || {},
      fileRingMap: cfg.fileRingMap || {},
      defaultRing: [0, 1, 2, 3].includes(Number(cfg.defaultRing)) ? Number(cfg.defaultRing) : 0,
      autoPublish: Boolean(cfg.autoPublish),
      autoSyncKnowledge: Boolean(cfg.autoSyncKnowledge),
      autoConvertMd: cfg.autoConvertMd !== false,
      enablePdfOcr: cfg.enablePdfOcr !== false,
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
    if (data.access_token) {
      const expAt = Date.now() + Number(data.expires_in || 3600) * 1000;
      cfg.sealedAccessToken = vault.seal(String(data.access_token).trim());
      cfg.accessTokenExpiresAt = expAt;
      cachedToken = {
        token: data.access_token,
        expiresAt: expAt
      };
    } else {
      cachedToken = null;
    }
    cfg.authMode = 'oauth2';
    cfg.enabled = true;
    cfg.oauthConnectedAt = new Date().toISOString();
    cfg.lastTokenRefreshAt = cfg.oauthConnectedAt;
    saveConfig(cfg);
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
      const expAt = Date.now() + Number(data.expires_in || 3600) * 1000;
      cachedToken = {
        token: data.access_token,
        expiresAt: expAt
      };
      // If Google rotated the refresh_token or issued a new access_token, persist it so the session stays alive for months
      try {
        const cfg = loadConfig();
        if (data.refresh_token && String(data.refresh_token).trim()) {
          cfg.sealedOauthRefreshToken = vault.seal(String(data.refresh_token).trim());
        }
        cfg.sealedAccessToken = vault.seal(String(data.access_token).trim());
        cfg.accessTokenExpiresAt = expAt;
        cfg.lastTokenRefreshAt = new Date().toISOString();
        saveConfig(cfg);
      } catch (_) {}
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

  // Search files & folders in Google Drive (either within a folder or globally across Drive) with fuzzy scoring.
  async function searchDriveFiles(query, folderId = '', pageSize = 100) {
    const cleanQ = String(query || '').trim();
    const cleanFolderId = folderId ? parseDriveId(folderId) : '';
    const u = new URL(DRIVE_API);
    const clauses = ['trashed = false'];
    if (cleanFolderId) {
      clauses.push(`'${cleanFolderId.replace(/'/g, "\\'")}' in parents`);
    }
    u.searchParams.set('q', clauses.join(' and '));
    u.searchParams.set('fields', 'files(id,name,mimeType,description,modifiedTime,createdTime,size,webViewLink,webContentLink,thumbnailLink,parents)');
    u.searchParams.set('orderBy', 'folder,name');
    u.searchParams.set('pageSize', String(Math.min(Math.max(Number(pageSize) || 120, 1), 500)));
    u.searchParams.set('supportsAllDrives', 'true');
    u.searchParams.set('includeItemsFromAllDrives', 'true');

    const r = await driveFetch(u.toString());
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const errMsg = (data.error && data.error.message) || ('HTTP ' + r.status);
      throw new Error(`Gagal mencari di Google Drive: ${errMsg}`);
    }
    let items = Array.isArray(data.files) ? data.files : [];

    // Also run a targeted name contains query if global search and query >= 2 chars
    if (!cleanFolderId && cleanQ.length >= 2) {
      const firstWord = cleanQ.split(/\s+/)[0].replace(/'/g, "\\'");
      if (firstWord.length >= 2) {
        try {
          const u2 = new URL(DRIVE_API);
          u2.searchParams.set('q', `name contains '${firstWord}' and trashed = false`);
          u2.searchParams.set('fields', 'files(id,name,mimeType,description,modifiedTime,createdTime,size,webViewLink,webContentLink,thumbnailLink,parents)');
          u2.searchParams.set('pageSize', '100');
          u2.searchParams.set('supportsAllDrives', 'true');
          u2.searchParams.set('includeItemsFromAllDrives', 'true');
          const r2 = await driveFetch(u2.toString());
          if (r2.ok) {
            const d2 = await r2.json().catch(() => ({}));
            const seenIds = new Set(items.map((x) => x.id));
            for (const f of (Array.isArray(d2.files) ? d2.files : [])) {
              if (!seenIds.has(f.id)) {
                seenIds.add(f.id);
                items.push(f);
              }
            }
          }
        } catch (_) {}
      }
    }

    if (cleanQ) {
      items = items
        .map((item) => {
          const nameScore = fuzzyScore(cleanQ, item.name || '');
          const descScore = item.description ? Math.round(fuzzyScore(cleanQ, item.description) * 0.6) : 0;
          return { ...item, fuzzyScore: Math.max(nameScore, descScore) };
        })
        .filter((item) => item.fuzzyScore > 0)
        .sort((a, b) => b.fuzzyScore - a.fuzzyScore);
    }

    const folders = items.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    const files = items.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder');
    return { query: cleanQ, folderId: cleanFolderId, folders, files, total: items.length };
  }

  // Read/extract text content from a Google Drive file (including DOCX, PDF Non-OCR, and PDF OCR).
  async function readFileContent(fileOrId, opts = {}) {
    const meta = typeof fileOrId === 'object' && fileOrId && fileOrId.id
      ? fileOrId
      : await getFileMeta(fileOrId);
    const id = meta.id;
    const mime = String(meta.mimeType || '').toLowerCase();
    const name = String(meta.name || '');

    let text = '';
    let extractionMethod = 'text';

    if (mime === 'application/vnd.google-apps.document' || mime === 'application/vnd.google-apps.presentation') {
      extractionMethod = 'gdoc';
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}/export`);
      u.searchParams.set('mimeType', 'text/plain');
      const r = await driveFetch(u.toString());
      if (r.ok) text = await r.text();
    } else if (mime === 'application/vnd.google-apps.spreadsheet') {
      extractionMethod = 'gsheet';
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}/export`);
      u.searchParams.set('mimeType', 'text/csv');
      const r = await driveFetch(u.toString());
      if (r.ok) text = await r.text();
    } else if (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      /\.(txt|md|markdown|csv|json)$/i.test(name)
    ) {
      extractionMethod = /\.md|markdown$/i.test(name) ? 'markdown' : 'text';
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
      u.searchParams.set('alt', 'media');
      u.searchParams.set('supportsAllDrives', 'true');
      const r = await driveFetch(u.toString());
      if (r.ok) text = await r.text();
    } else if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      /\.docx$/i.test(name)
    ) {
      extractionMethod = 'docx';
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
      u.searchParams.set('alt', 'media');
      u.searchParams.set('supportsAllDrives', 'true');
      const r = await driveFetch(u.toString());
      if (r.ok) {
        const ab = await r.arrayBuffer();
        text = extractTextFromDocxBuffer(Buffer.from(ab));
      }
    } else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
      extractionMethod = 'pdf_text';
      const u = new URL(`${DRIVE_API}/${encodeURIComponent(id)}`);
      u.searchParams.set('alt', 'media');
      u.searchParams.set('supportsAllDrives', 'true');
      const r = await driveFetch(u.toString());
      let pdfBuf = null;
      if (r.ok) {
        if (typeof r.arrayBuffer === 'function') {
          const ab = await r.arrayBuffer();
          pdfBuf = Buffer.from(ab);
        } else if (typeof r.text === 'function') {
          pdfBuf = Buffer.from(await r.text(), 'latin1');
        }
      }
      if (pdfBuf && pdfBuf.length > 0) {
        if (!opts.forceOcr) {
          text = extractTextFromPdfBuffer(pdfBuf);
        }
        const alphaCount = String(text || '').replace(/[^a-zA-Z0-9]/g, '').length;
        // If native PDF text is empty/sparse (scanned image PDF) or forceOcr is requested, trigger OCR!
        const cfg = loadConfig();
        if ((alphaCount < 25 || opts.forceOcr) && cfg.enablePdfOcr !== false) {
          let ocrText = '';
          // OCR Engine 1: Claude Multimodal PDF Vision OCR (works with read-only Google Drive scope)
          if (typeof opts.ocrFn === 'function') {
            try {
              ocrText = await opts.ocrFn(pdfBuf, name);
            } catch (_) {}
          } else if (ctx.ai && typeof ctx.ai.ocrPdfBuffer === 'function') {
            try {
              ocrText = await ctx.ai.ocrPdfBuffer(pdfBuf, name);
            } catch (_) {}
          }
          // OCR Engine 2: Google Drive /export or description fallback if available
          if (!ocrText && meta.description) {
            ocrText = String(meta.description);
          }
          if (ocrText && String(ocrText).trim().length > alphaCount) {
            text = String(ocrText).trim();
            extractionMethod = 'pdf_ocr';
          }
        }
      }
    }

    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    return {
      meta,
      text: text.slice(0, 200000),
      extracted: Boolean(text),
      extractionMethod
    };
  }

  const isRingNum = (v) => v !== null && v !== undefined && v !== '' && v !== false && v !== 'unassigned' && v !== 'irrelevant' && [0, 1, 2, 3].includes(Number(v));

  // Resolve effective Ring assignment for a folder (0, 1, 2, 3, 'irrelevant', or 'unassigned')
  function resolveFolderRing(folderId, folderName = '', cfg = loadConfig()) {
    const cleanId = parseDriveId(folderId);
    if (!cleanId) return 'unassigned';
    // 1. Check explicit per-ring folder config
    for (const r of [0, 1, 2, 3]) {
      if (cfg.ringFolders && parseDriveId(cfg.ringFolders[r]) === cleanId) return r;
    }
    // 2. Check folderRingMap
    if (cfg.folderRingMap && cfg.folderRingMap[cleanId] !== undefined) {
      const mapped = cfg.folderRingMap[cleanId];
      if (isRingNum(mapped)) {
        return Number(mapped);
      }
      if (mapped === 'irrelevant' || mapped === 'unassigned') return mapped;
    }
    // 3. Check explicit tag in folder name (e.g. "Ring 3 - Publik", "[R0]", "[Irrelevant]")
    const byName = inferRingFromName(folderName, null);
    if (byName !== null) return byName;
    return 'unassigned';
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

    // 2. Folders mapped via folderRingMap (0..3)
    if (cfg.folderRingMap && typeof cfg.folderRingMap === 'object') {
      for (const [fidRaw, mappedRing] of Object.entries(cfg.folderRingMap)) {
        const fid = parseDriveId(fidRaw);
        if (!fid || seen.has(fid)) continue;
        if (isRingNum(mappedRing)) {
          seen.add(fid);
          targets.push({ folderId: fid, folderName: `Folder Terpetakan (R${mappedRing})`, ring: Number(mappedRing), source: 'folder_map' });
        }
      }
    }

    // 3. Root folder & its direct subfolders
    const rootId = parseDriveId(cfg.rootFolderId);
    if (rootId) {
      const rootChildren = await listFolderChildren(rootId, 100);
      if (!seen.has(rootId)) {
        seen.add(rootId);
        targets.push({
          folderId: rootId,
          folderName: 'Root Folder',
          ring: isRingNum(cfg.defaultRing) ? Number(cfg.defaultRing) : 0,
          source: 'root_direct',
          preloadedFiles: rootChildren.files
        });
      }
      for (const sub of rootChildren.folders) {
        if (seen.has(sub.id)) continue;
        const explicitMap = cfg.folderRingMap && cfg.folderRingMap[sub.id];
        if (explicitMap === 'irrelevant' || explicitMap === 'unassigned') continue;
        seen.add(sub.id);
        const fallbackRing = isRingNum(explicitMap) ? Number(explicitMap) : (isRingNum(cfg.defaultRing) ? Number(cfg.defaultRing) : 0);
        const inferred = inferRingFromName(sub.name, fallbackRing);
        if (inferred === 'irrelevant') continue;
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
    resolveFolderRing,
    fuzzyScore,
    inferWorkType,
    inferLang,
    cleanTitleFromFilename,
    convertToMarkdownDocument,
    extractTextFromPdfBuffer,
    getFileMeta,
    listFolderChildren,
    searchDriveFiles,
    readFileContent,
    discoverRingFolders,
    setupAutoSyncTimer,
    buildOAuthConsentUrl,
    verifyOAuthState,
    exchangeOAuthCode,
    createPortableBundle,
    restorePortableBundle,
    setCustomFetch: (fn) => { customFetch = fn; },
    clearTokenCache: () => { cachedToken = null; }
  };
};
