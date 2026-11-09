'use strict';
// iCoachAndrew Digital Twin — Full Web & API Server (Rings 0, 1, 2, 3).
// One backend, two sites: User site (Rings 3, 2, 1) and Admin site (Ring 0 only).
// Built-in Node.js modules only. Zero external runtime dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = process.env.ICOACH_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_PORT = Number(process.env.PORT || process.env.USER_PORT || 3000);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3001);
const FREE_FOR_NOW = process.env.FREE_FOR_NOW !== 'false';
const DEFAULT_MONTHLY_CAP = Number(process.env.MONTHLY_MESSAGE_CAP || 50);

const REFUSAL = {
  en: 'I’m sorry. That is private. Hope you understand.',
  id: 'Mohon maaf. Itu bersifat pribadi. Semoga Anda mengerti.'
};
const DISCLOSURE = {
  en: 'I am Andrew’s digital twin, not Andrew himself.',
  id: 'Saya adalah digital twin Andrew, bukan Andrew sendiri.'
};
const COMMITMENT_REFUSAL = {
  en: 'As Andrew’s digital twin, I cannot commit Andrew to money, contracts, meetings, or promises.',
  id: 'Sebagai digital twin Andrew, saya tidak dapat mengikat Andrew pada uang, kontrak, pertemuan, atau janji apa pun.'
};
const ADVICE_REFUSAL = {
  en: 'I am Andrew’s digital twin, not Andrew himself, and I do not provide legal or financial advice.',
  id: 'Saya adalah digital twin Andrew, bukan Andrew sendiri, dan saya tidak memberikan nasihat hukum atau keuangan.'
};
const CAP_REACHED = {
  en: 'You have reached your monthly fair-use message allowance. Please wait for the next cycle or upgrade your plan.',
  id: 'Anda telah mencapai batas pemakaian wajar pesan bulanan Anda. Silakan tunggu periode berikutnya atau perbarui paket Anda.'
};
const FIXED_DUTIES = [
  { id: 'disclosure', label: 'Kejujuran Identitas Digital Twin', rule: 'Selalu menyatakan diri sebagai digital twin Andrew Tani (bukan Andrew sendiri) bila ditanya secara tulus.' },
  { id: 'no_commitment', label: 'Larangan Mengikat Komitmen', rule: 'Tidak pernah mengikat Andrew pada uang, kontrak, investasi, pertemuan, atau janji apa pun.' },
  { id: 'no_legal_financial', label: 'Larangan Nasihat Hukum & Keuangan', rule: 'Tidak pernah memberikan nasihat hukum, pajak, investasi, atau keuangan.' },
  { id: 'ring_isolation', label: 'Isolasi Ketat Ring 0–3 & Leak Guard', rule: 'Penanya di Ring R hanya dapat mengakses pengetahuan & memori Ring N bila R <= N; semua balasan dipindai dengan 5-gram shingle Leak Guard.' }
];

const createStudio = require('./lib/studio');
const createDatabase = fs.existsSync(path.join(__dirname, 'db.js')) ? require('./db') : require('./lib/db');
const db = createDatabase(DATA);
let studio;

// Words & categories that make the intake step propose Ring 0 (stricter wins when unclear).
const SENSITIVE = [
  'unresolved family succession dispute', 'pt dirgantara holdings',
  'password', 'passkey', 'salary', 'valuation', 'debt', 'confidential', 'secret', 'private',
  'medical', 'diagnosis', 'hospital', 'children', 'family', 'lawsuit', 'dispute', 'investigation',
  'acquisition', 'begapal', 'peacock', 'unreleased', 'draft',
  'sandi', 'gaji', 'valuasi', 'utang', 'rahasia', 'pribadi', 'medis', 'keluarga', 'anak', 'sengketa', 'akuisisi'
];

// ---------- four physically separate stores, one folder and one index each ----------
function storeFile(ring) { return path.join(DATA, 'rings', 'ring' + ring, 'docs.json'); }
function pendingFile() { return path.join(DATA, 'pending.json'); }
function precedentsFile() { return path.join(DATA, 'precedents.json'); }
function codenamesFile() { return path.join(DATA, 'codenames.json'); }
function membersFile() { return path.join(DATA, 'members.json'); }

function hashSecret(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function ensureStores() {
  for (const r of [0, 1, 2, 3]) {
    fs.mkdirSync(path.dirname(storeFile(r)), { recursive: true });
    if (!fs.existsSync(storeFile(r))) fs.writeFileSync(storeFile(r), '[]');
  }
  if (!fs.existsSync(pendingFile())) fs.writeFileSync(pendingFile(), '[]');
  if (!fs.existsSync(precedentsFile())) fs.writeFileSync(precedentsFile(), '[]');
  if (!fs.existsSync(membersFile())) fs.writeFileSync(membersFile(), '[]');
  if (!fs.existsSync(codenamesFile())) {
    // Seed the Ring 1 register from Digital Twin Ring Protocol v0.3 & Stitch Blueprint (no real identities stored)
    const initialCodenames = [
      {
        codeName: 'Begapal',
        ring: 1,
        passphraseHash: hashSecret(process.env.RING1_DEFAULT_PASSPHRASE || 'begapal-passphrase'),
        otpCode: '111222',
        status: 'active',
        channel: { provider: 'signal', linkedAt: '2026-10-19', label: 'Signal Enclave #812' },
        addedAt: '2026-10-19'
      },
      {
        codeName: 'BEGAPAL-92',
        ring: 1,
        passphraseHash: hashSecret('SecretPassphrase1983'),
        otpCode: '749203',
        status: 'active',
        channel: { provider: 'signal', linkedAt: '2023-10-14', label: 'Signal Enclave #812' },
        addedAt: '14 Oct 2023'
      },
      {
        codeName: 'King Peacock',
        ring: 1,
        passphraseHash: hashSecret(process.env.RING1_DEFAULT_PASSPHRASE || 'peacock-passphrase'),
        otpCode: '333444',
        status: 'active',
        channel: { provider: 'whatsapp', linkedAt: '2026-10-19', label: 'WhatsApp HSM-Proxy' },
        addedAt: '2026-10-19'
      },
      {
        codeName: 'BANYU-VENTURE',
        ring: 1,
        passphraseHash: hashSecret('SecretPassphrase1983'),
        otpCode: '749203',
        status: 'active',
        channel: { provider: 'whatsapp', linkedAt: '2024-02-02', label: 'WhatsApp HSM-Proxy' },
        addedAt: '02 Feb 2024'
      },
      {
        codeName: 'GOLDEN-FALCON',
        ring: 1,
        passphraseHash: hashSecret('SecretPassphrase1983'),
        otpCode: '749203',
        status: 'active',
        channel: { provider: 'airterm', linkedAt: '2024-03-19', label: 'Direct Air-Term 4' },
        addedAt: '19 Mar 2024'
      },
      {
        codeName: 'MERPATI-CAUCUS',
        ring: 1,
        passphraseHash: hashSecret('revoked'),
        otpCode: '000000',
        status: 'revoked',
        channel: null,
        addedAt: '11 Jan 2023'
      }
    ];
    fs.writeFileSync(codenamesFile(), JSON.stringify(initialCodenames, null, 2));
  }
  fs.mkdirSync(DATA, { recursive: true });
  db.ensureAll();
  if (studio) studio.ensure();
}

const readJson = (f) => db.readDocument(f);
const writeJson = (f, v) => db.writeDocument(f, v);
const loadStore = (ring) => db.loadStore(ring);
const saveStore = (ring, v) => db.saveStore(ring, v);
const loadPending = () => db.loadPending();
const savePending = (v) => db.savePending(v);
const loadPrecedents = () => db.loadPrecedents();
const savePrecedents = (v) => db.savePrecedents(v);
const loadCodenames = () => db.loadCodenames();
const saveCodenames = (v) => db.saveCodenames(v);
const loadMembers = () => db.loadMembers();
const saveMembers = (v) => db.saveMembers(v);

// ---------- ring policy service: the only place access is decided ----------
// An asker in Ring R may read content tagged Ring N when R <= N (lower number = more trusted).
function readableRings(askerRing) {
  const out = [];
  for (let n = 0; n <= 3; n++) if (askerRing <= n) out.push(n);
  return out;
}

function retrieve(askerRing, question, limit = 3) {
  const terms = tokenize(question);
  const hits = [];
  for (const n of readableRings(askerRing)) {
    for (const d of loadStore(n)) {
      const dt = new Set(tokenize(d.title + ' ' + d.text));
      let score = 0;
      for (const t of terms) if (dt.has(t)) score++;
      if (score > 0) hits.push({ doc: d, ring: n, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.ring - b.ring);
  return hits.slice(0, limit);
}

function tokenize(s) {
  return String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
}

// ---------- leak guard: reply must not contain text from a stricter store than the asker may read ----------
function shingles(text, k = 5) {
  const w = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}

function leakGuard(askerRing, reply) {
  const rl = String(reply).toLowerCase().replace(/\s+/g, ' ');
  for (let n = 0; n <= 3; n++) {
    if (askerRing <= n) continue; // asker may read this ring
    for (const d of loadStore(n)) {
      for (const sh of shingles(d.text)) if (rl.includes(sh)) return { ok: false, ring: n, doc: d.id };
    }
  }
  if (studio && studio.memory) {
    for (const m of studio.memory.stricterTexts(askerRing)) {
      for (const sh of shingles(m.text)) if (rl.includes(sh)) return { ok: false, ring: m.ring, doc: m.id };
    }
  }
  return { ok: true };
}

// ---------- duty & injection checks (Protocol v0.3 & Spec v0.2) ----------
function checkSpecialRules(askerRing, question, lang) {
  const q = String(question).toLowerCase();

  // 1. Prompt injection / rule-override attempts
  if (/(ignore (all |previous )?(instructions|rules)|disregard (your )?rules|system prompt|abaikan (semua )?(aturan|instruksi)|bocorkan ring 0)/i.test(q)) {
    return { matched: true, text: REFUSAL[lang], refused: true, outcome: 'guard_triggered', topic: 'prompt_injection' };
  }

  // 2. Sincere inquiry about whether this is Andrew or his digital twin
  if (/(are you (really )?andrew|speaking with andrew or|are you a digital twin|apakah (ini|anda) (benar )?(pak )?andrew|apakah anda digital twin)/i.test(q)) {
    return { matched: true, text: DISCLOSURE[lang], refused: false, outcome: 'answered', topic: 'identity_disclosure' };
  }

  // 3. Requests to commit money, sign contracts, or make binding promises
  if (/(sign (this |a )?contract|promise (to )?(pay|invest|money)|commit andrew to a (deal|contract|meeting)|tandatangani kontrak|janji (bayar|investasi|uang))/i.test(q)) {
    return { matched: true, text: COMMITMENT_REFUSAL[lang], refused: true, outcome: 'refused_politely', topic: 'commitment_declined' };
  }

  // 4. Requests for legal or financial advice
  if (/(give me (legal|financial|tax|investment) advice|berikan (saya )?nasihat (hukum|keuangan|pajak|investasi))/i.test(q)) {
    return { matched: true, text: ADVICE_REFUSAL[lang], refused: true, outcome: 'refused_politely', topic: 'advice_declined' };
  }

  // 5. Ring-specific blocked topics configured in Andrew's Protocol Memory
  if (studio && studio.memory) {
    for (const bt of studio.memory.blockedFor(askerRing)) {
      if (bt && q.includes(String(bt).toLowerCase())) {
        return { matched: true, text: REFUSAL[lang], refused: true, outcome: 'refused_politely', topic: 'blocked_topic' };
      }
    }
  }

  return { matched: false };
}

// ---------- audit log (no question text, no answer text) ----------
function audit(entry) {
  db.appendAudit(entry);
}

// ---------- conversation engine ----------
async function answer(askerRing, question, lang, opts = {}) {
  const special = checkSpecialRules(askerRing, question, lang);
  if (special.matched) {
    return { text: special.text, sources: [], refused: special.refused, outcome: special.outcome, topic: special.topic, mode: 'rule_guard' };
  }

  const hits = retrieve(askerRing, question);
  if (hits.length === 0) return { text: REFUSAL[lang], sources: [], refused: true, outcome: 'refused_politely', topic: 'unmatched_or_restricted', mode: 'unmatched' };
  const context = hits.map((h) => `[${h.doc.id}] ${h.doc.title}\n${h.doc.text}`).join('\n\n');
  let text = '';
  let genInfo = { mode: 'extractive' };
  if (studio && studio.ai) {
    const gen = await studio.ai.generate({ askerRing, lang, question, context, source: opts.source || 'chat' });
    genInfo = gen;
    if (gen.ok) {
      text = gen.text;
    } else if (gen.reason === 'model_error' && !opts.debug) {
      throw new Error('model_error_' + (gen.status || 500));
    } else {
      text = hits[0].doc.text.slice(0, 400);
      if (gen.reason !== 'model_error') studio.ai.recordExtractive(askerRing, opts.source || 'chat');
    }
  } else {
    text = hits[0].doc.text.slice(0, 400);
  }
  const g = leakGuard(askerRing, text);
  if (!g.ok) {
    audit({ event: 'leak_blocked', askerRing, leakedRing: g.ring, doc: g.doc, outcome: 'guard_triggered' });
    return { text: REFUSAL[lang], sources: [], refused: true, outcome: 'guard_triggered', topic: 'leak_guard', mode: genInfo.mode };
  }
  const resObj = { text, sources: hits.map((h) => h.doc.id), refused: false, outcome: 'answered', topic: hits[0].doc.title };
  if (opts.debug) {
    resObj.mode = genInfo.mode;
    resObj.model = genInfo.model || null;
    resObj.latencyMs = genInfo.latencyMs || 0;
    resObj.usage = genInfo.usage || null;
    resObj.hits = hits.map((h) => ({ id: h.doc.id, title: h.doc.title, ring: h.ring, score: h.score }));
  }
  return resObj;
}

// ---------- sessions: ring comes from the server, never from the browser ----------
const sessions = new Map(); // token -> { id, ring, exp, codeName?, memberId?, passphraseHash? }
const USER_COOKIE = 'icoach_session';
const ADMIN_COOKIE = 'icoach_admin';

function newSession(ring, meta = {}) {
  const t = crypto.randomBytes(32).toString('hex');
  const sid = 's_' + crypto.randomBytes(4).toString('hex');
  sessions.set(t, { id: sid, ring, exp: Date.now() + 30 * 60 * 1000, ...meta });
  return t;
}

function getCookieToken(req, cookieName) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(cookieName + '='));
  return m ? m.split('=')[1] : null;
}

function sessionRing(req, cookieName) {
  const t = getCookieToken(req, cookieName);
  if (!t) return null;
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) return null;
  return s.ring;
}

// Resolves a user-site request to its verified session and enforces live revocation / entitlement checks
function resolveUserSession(req) {
  const t = getCookieToken(req, USER_COOKIE);
  if (!t) return { ring: 3, sessionId: 'anon', label: 'public' };
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) {
    if (s) sessions.delete(t);
    return { ring: 3, sessionId: 'anon', label: 'public' };
  }

  // Ring 1 live check: verify code name is still active and passphrase hasn't been rotated
  if (s.ring === 1 && s.codeName) {
    const entry = loadCodenames().find((c) => c.codeName.toLowerCase() === s.codeName.toLowerCase());
    if (s.revoked || !entry || entry.status !== 'active' || (s.passphraseHash && entry.passphraseHash !== s.passphraseHash)) {
      sessions.delete(t);
      return { ring: 3, sessionId: 'anon', label: 'public', revoked: true };
    }
    s.exp = Date.now() + 30 * 60 * 1000; // refresh inactivity window
    return { ring: 1, sessionId: s.id, label: 'ring1', codeName: entry.codeName, channel: entry.channel };
  }

  // Ring 2 live check: verify subscription/entitlement is still active
  if (s.ring === 2 && s.memberId) {
    const member = loadMembers().find((m) => m.id === s.memberId);
    const freeActive = FREE_FOR_NOW && (!studio || studio.commerce.isFreeForNow());
    if (!member || (member.entitlement !== 'active' && !freeActive)) {
      // Lapsed subscription drops the session to public access on the next request
      return { ring: 3, sessionId: s.id, label: 'public', lapsed: true };
    }
    return { ring: 2, sessionId: s.id, label: 'member', memberId: member.id };
  }

  return { ring: 3, sessionId: s.id, label: 'public' };
}

const attempts = new Map(); // bucketKey -> { n, reset }
function rateLimited(key, max = 180, windowMs = 60000) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, reset: now + windowMs };
  if (a.reset < now) { a.n = 0; a.reset = now + windowMs; }
  a.n++; attempts.set(key, a);
  return a.n > max;
}

// ---------- helpers ----------
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function sendFile(res, filePath, contentType = 'text/html; charset=utf-8') {
  if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not_found' });
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(filePath, 'utf8'));
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}
function body(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad_json')); } });
  });
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const langOf = (v) => (v === 'id' ? 'id' : 'en');

// ---------- sample knowledge seeding for all 4 rings ----------
function seedSampleKnowledge() {
  const samples = [
    {
      ring: 3,
      id: 'doc_r3_voice',
      title: 'Voice Profile & Leadership Listening',
      lang: 'en',
      text: 'Leadership starts with listening carefully to the people closest to the problem before deciding anything. In my work building organizations, I always speak plainly, put substance before ceremony, and remind leaders that culture is shaped by what we reward and what we tolerate every day.'
    },
    {
      ring: 3,
      id: 'doc_r3_id',
      title: 'Kepemimpinan dan Budaya Organisasi',
      lang: 'id',
      text: 'Bagi saya, kepemimpinan selalu dimulai dengan mendengarkan secara saksama orang-orang yang paling dekat dengan persoalan sebelum kita mengambil keputusan. Budaya kerja yang sehat dan tulus tidak lahir dari slogan di dinding, melainkan dari keteladanan pemimpin, cara kita menghargai kejujuran, dan kebiasaan kecil yang kita jaga bersama setiap hari.'
    },
    {
      ring: 3,
      id: 'doc_r3_strategy_id',
      title: 'Menyelaraskan Strategi dan Manusia',
      lang: 'id',
      text: 'Strategi perusahaan sebaik apa pun hanya akan hidup jika diterjemahkan menjadi kebiasaan keseharian tim. Saat mendampingi organisasi selama empat dekade, saya selalu mengajak para pemimpin memastikan setiap orang memahami peran mereka, merasa didengar, dan memiliki kejelasan arah dalam bekerja bersama.'
    },
    {
      ring: 3,
      id: 'doc_r3_strategy_en',
      title: 'Aligning Strategy with Everyday Team Habits',
      lang: 'en',
      text: 'The best company strategy only comes alive when it translates into everyday team habits. Over four decades of walking alongside organizations, I have always encouraged leaders to make sure every person understands their role, feels genuinely heard, and sees how their daily work connects to our shared purpose.'
    },
    {
      ring: 2,
      id: 'doc_r2_orbex',
      title: 'Orbex Framework: Organizing Business Excellence (Licensed Member Wisdom)',
      lang: 'en',
      text: 'When we apply the Orbex approach together, we align strategic intent with our daily operating rhythm—making sure decision responsibilities are clear at every layer, holding regular reflection reviews, and caring for how teams hand off work across functions.'
    },
    {
      ring: 1,
      id: 'doc_r1_exec',
      title: 'Executor Mandate: Q4 Strategic Restructuring Brief',
      lang: 'en',
      text: 'Thank you for checking in. Please coordinate the Q4 restructuring timetable with the regional directors before Friday and prepare the transition charter so we can review it together.'
    },
    {
      ring: 0,
      id: 'doc_r0_board',
      title: 'Private Board & Valuation Notes (Ring 0 Only)',
      lang: 'en',
      text: 'The confidential acquisition price discussed with the board was settled at USD 42M after a long negotiation about leadership succession and private family trust holdings.'
    }
  ];
  let added = 0;
  for (const s of samples) {
    const store = loadStore(s.ring);
    if (!store.some((d) => d.id === s.id)) {
      store.push({ id: s.id, title: s.title, text: s.text, lang: s.lang, ring: s.ring, approvedAt: new Date().toISOString() });
      saveStore(s.ring, store);
      added++;
    }
  }
  return added;
}

// ---------- admin site: Ring 0 only, separate port/hostname, own login and cookie ----------
async function handleAdmin(req, res) {
  try {
    const ip = clientIp(req);
    const isAuthedAdmin = sessionRing(req, ADMIN_COOKIE) === 0;
    if (rateLimited('admin:' + ip, isAuthedAdmin ? 600 : 60)) return send(res, 429, { error: 'slow_down' });

    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/admin' || pathname === '/admin.html')) {
      try {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8')
          .replace('href="http://localhost:3000"', 'href="/" onclick="if(location.port===\'3001\'){this.href=location.protocol+\'//\'+location.hostname+\':3000\';}"');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      } catch (_) {
        return sendFile(res, path.join(PUBLIC_DIR, 'admin.html'));
      }
    }
    if (req.method === 'GET' && pathname === '/admin-studio.js') {
      return sendFile(res, path.join(PUBLIC_DIR, 'admin-studio.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/cms-runtime.js') {
      return sendFile(res, path.join(PUBLIC_DIR, 'cms-runtime.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && studio && studio.serveMedia(req, res, pathname)) {
      return;
    }

    const pass = process.env.ADMIN_PASSPHRASE;
    if (req.method === 'POST' && pathname === '/admin/login') {
      if (!pass) return send(res, 503, { error: 'admin_not_configured' }); // fail closed
      const b = await body(req, 2000);
      if (!safeEq(String(b.passphrase || ''), pass)) {
        audit({ event: 'admin_login_failed', ring: 0 });
        return send(res, 401, { error: 'denied' });
      }
      const t = newSession(0);
      audit({ event: 'admin_login', ring: 0 });
      return send(res, 200, { ok: true }, { 'set-cookie': `${ADMIN_COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800` });
    }

    if (req.method === 'POST' && pathname === '/admin/logout') {
      const t = getCookieToken(req, ADMIN_COOKIE);
      if (t) sessions.delete(t);
      return send(res, 200, { ok: true }, { 'set-cookie': `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    if (!isAuthedAdmin) {
      audit({ event: 'admin_unauthorized_attempt', path: pathname });
      return send(res, 401, { error: 'denied' });
    }

    // Same-origin Visual Website Editor preview routes on the Admin port
    if (req.method === 'GET' && pathname === '/preview-site') {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (req.method === 'GET' && pathname === '/i18n/en.json') {
      return sendFile(res, path.join(PUBLIC_DIR, 'i18n', 'en.json'), 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/i18n/id.json') {
      return sendFile(res, path.join(PUBLIC_DIR, 'i18n', 'id.json'), 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/api/session') {
      return send(res, 200, { ring: 3, label: 'public', studioPreview: true });
    }

    if (studio && await studio.dispatchAdmin(req, res, { url: urlObj })) {
      return;
    }
    if (studio && await studio.dispatchPublic(req, res, { url: urlObj, sess: { ring: 0, sessionId: 'studio', label: 'ring0' } })) {
      return;
    }

    // Store overview
    if (req.method === 'GET' && pathname === '/admin/api/stores') {
      const stores = {};
      for (const r of [0, 1, 2, 3]) {
        stores['ring' + r] = loadStore(r).map((d) => ({
          id: d.id,
          title: d.title,
          lang: d.lang,
          ring: d.ring,
          approvedAt: d.approvedAt,
          preview: String(d.text).slice(0, 120)
        }));
      }
      return send(res, 200, { stores, precedents: loadPrecedents() });
    }

    // Seed sample documents across Rings 0..3
    if (req.method === 'POST' && pathname === '/admin/api/seed') {
      const added = seedSampleKnowledge();
      audit({ event: 'admin_seed_samples', added });
      return send(res, 200, { ok: true, added });
    }

    // Upload & classify file/passage
    if (req.method === 'POST' && pathname === '/admin/api/files') {
      const b = await body(req);
      const intended = Number(b.intendedRing);
      if (![0, 1, 2, 3].includes(intended) || !b.text || !b.title) return send(res, 400, { error: 'bad_request' });
      const lower = String(b.text).toLowerCase();
      const flagged = SENSITIVE.filter((w) => lower.includes(w));
      // Stricter wins: a sensitive-looking file is proposed to Ring 0, never looser.
      const proposed = flagged.length ? Math.min(intended, 0) : intended;
      const item = {
        id: 'f_' + crypto.randomBytes(5).toString('hex'),
        title: String(b.title),
        text: String(b.text),
        lang: langOf(b.lang),
        intendedRing: intended,
        proposedRing: proposed,
        flagged,
        status: 'awaiting_approval',
        addedAt: new Date().toISOString()
      };
      const p = loadPending(); p.push(item); savePending(p);
      audit({ event: 'file_proposed', id: item.id, intended, proposed, flaggedCount: flagged.length });
      return send(res, 200, { id: item.id, proposedRing: proposed, flagged, status: item.status });
    }

    // List files awaiting approval
    if (req.method === 'GET' && pathname === '/admin/api/pending') {
      return send(res, 200, { pending: loadPending().map(({ text, ...rest }) => ({ ...rest, preview: String(text).slice(0, 140) })) });
    }

    // Confirm or override ring tag
    if (req.method === 'POST' && pathname === '/admin/api/approve') {
      const b = await body(req, 2000);
      const ring = Number(b.ring);
      if (![0, 1, 2, 3].includes(ring)) return send(res, 400, { error: 'bad_request' });
      const p = loadPending();
      const i = p.findIndex((x) => x.id === b.id);
      if (i < 0) return send(res, 404, { error: 'not_found' });
      const [item] = p.splice(i, 1);
      const overridden = ring !== item.proposedRing;
      if (overridden) {
        const precs = loadPrecedents();
        precs.push({
          id: item.id,
          title: item.title,
          proposedRing: item.proposedRing,
          approvedRing: ring,
          flagged: item.flagged,
          note: String(b.note || 'Admin override'),
          decidedAt: new Date().toISOString()
        });
        savePrecedents(precs);
      }
      const s = loadStore(ring);
      s.push({
        id: item.id,
        title: item.title,
        text: item.text,
        lang: item.lang,
        ring,
        approvedAt: new Date().toISOString(),
        tagHistory: [{ proposedRing: item.proposedRing, approvedRing: ring, at: new Date().toISOString() }]
      });
      saveStore(ring, s);
      savePending(p); // item exists in exactly one store
      audit({ event: 'file_approved', id: item.id, ring, overridden });
      return send(res, 200, { ok: true, ring, overridden });
    }

    // Move passage between stores (removes from old store, writes to new store)
    if (req.method === 'POST' && pathname === '/admin/api/move') {
      const b = await body(req, 2000);
      const fromRing = Number(b.fromRing);
      const toRing = Number(b.toRing);
      if (![0, 1, 2, 3].includes(fromRing) || ![0, 1, 2, 3].includes(toRing) || fromRing === toRing) {
        return send(res, 400, { error: 'bad_request' });
      }
      const sourceStore = loadStore(fromRing);
      const idx = sourceStore.findIndex((d) => d.id === b.id);
      if (idx < 0) return send(res, 404, { error: 'not_found' });
      const [doc] = sourceStore.splice(idx, 1);
      doc.ring = toRing;
      doc.movedAt = new Date().toISOString();
      const targetStore = loadStore(toRing);
      targetStore.push(doc);
      saveStore(fromRing, sourceStore);
      saveStore(toRing, targetStore);
      audit({ event: 'file_moved', id: doc.id, fromRing, toRing });
      return send(res, 200, { ok: true, id: doc.id, fromRing, toRing });
    }

    // Ring 1 code name management (no real identities ever stored)
    if (req.method === 'GET' && pathname === '/admin/api/codenames') {
      const list = loadCodenames().map(({ passphraseHash, ...rest }) => rest);
      return send(res, 200, { codenames: list });
    }

    if (req.method === 'POST' && pathname === '/admin/api/codenames') {
      const b = await body(req, 2000);
      const codeName = String(b.codeName || '').trim();
      const passphrase = String(b.passphrase || '').trim();
      const otpCode = String(b.otpCode || Math.floor(100000 + Math.random() * 900000));
      if (!codeName || !passphrase) return send(res, 400, { error: 'bad_request' });
      const list = loadCodenames();
      const existing = list.find((c) => c.codeName.toLowerCase() === codeName.toLowerCase());
      if (existing) {
        existing.passphraseHash = hashSecret(passphrase);
        existing.otpCode = otpCode;
        existing.status = 'active';
        saveCodenames(list);
        audit({ event: 'codename_rotated', codeName: existing.codeName });
        return send(res, 200, { ok: true, codeName: existing.codeName, otpCode, status: existing.status, rotated: true });
      }
      const entry = {
        codeName,
        ring: 1,
        passphraseHash: hashSecret(passphrase),
        otpCode,
        status: 'active',
        channel: null,
        addedAt: new Date().toISOString().slice(0, 10)
      };
      list.push(entry);
      saveCodenames(list);
      audit({ event: 'codename_created', codeName });
      return send(res, 200, { ok: true, codeName, otpCode, status: 'active' });
    }

    if (req.method === 'POST' && pathname === '/admin/api/codenames/revoke') {
      const b = await body(req, 2000);
      const codeName = String(b.codeName || '').trim();
      const list = loadCodenames();
      const entry = list.find((c) => c.codeName.toLowerCase() === codeName.toLowerCase());
      if (!entry) return send(res, 404, { error: 'not_found' });
      entry.status = 'revoked';
      entry.channel = null;
      saveCodenames(list);
      // Immediately mark all active sessions for this code name as revoked
      for (const [, sess] of sessions.entries()) {
        if (sess.ring === 1 && sess.codeName && sess.codeName.toLowerCase() === codeName.toLowerCase()) {
          sess.revoked = true;
        }
      }
      audit({ event: 'codename_revoked', codeName: entry.codeName });
      return send(res, 200, { ok: true, codeName: entry.codeName, status: 'revoked' });
    }

    // Audit log with optional filters (served from SQLite audit_logs table)
    if (req.method === 'GET' && pathname === '/admin/api/audit') {
      const ringFilter = urlObj.searchParams.get('ring');
      const eventFilter = urlObj.searchParams.get('event');
      const entries = db.queryAudit({ ring: ringFilter, event: eventFilter, limit: 100 });
      return send(res, 200, { entries });
    }

    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e && e.message === 'bad_json') return send(res, 400, { error: 'bad_json' });
    if (e && e.message === 'too_large') return send(res, 413, { error: 'too_large' });
    audit({ event: 'error', site: 'admin', msg: String(e.message) });
    return send(res, 500, { error: 'failed' });
  }
}

const adminServer = http.createServer(handleAdmin);

// ---------- user site: serves Rings 3, 2, and 1 based on server session ----------
const userServer = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '').toLowerCase();
    if (host.startsWith('admin.') || host.startsWith('vault.')) {
      return handleAdmin(req, res);
    }

    const ip = clientIp(req);
    if (rateLimited('user:' + ip, 240)) return send(res, 429, { error: 'slow_down' });

    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname;

    const isStudioPreview = Boolean(
      req.headers.referer &&
      req.headers.referer.includes('/preview-site') &&
      sessionRing(req, ADMIN_COOKIE) === 0 &&
      (pathname === '/api/site-content' || pathname === '/api/works' || pathname === '/api/pricing' || pathname === '/api/session')
    );

    // Allow accessing Admin portal via /admin, /admin.html, or admin subdomain on single-port hosting
    if (pathname === '/admin' || pathname === '/admin.html' || pathname.startsWith('/admin/') || pathname === '/admin-studio.js' || pathname === '/preview-site' || isStudioPreview || (req.headers.host && req.headers.host.startsWith('admin.'))) {
      return handleAdmin(req, res);
    }

    // Frontend pages, media & localization files
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/member')) {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (req.method === 'GET' && pathname === '/cms-runtime.js') {
      return sendFile(res, path.join(PUBLIC_DIR, 'cms-runtime.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && studio && studio.serveMedia(req, res, pathname)) {
      return;
    }
    if (req.method === 'GET' && pathname === '/i18n/en.json') {
      return sendFile(res, path.join(PUBLIC_DIR, 'i18n', 'en.json'), 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/i18n/id.json') {
      return sendFile(res, path.join(PUBLIC_DIR, 'i18n', 'id.json'), 'application/json; charset=utf-8');
    }
    if (studio && await studio.dispatchPublic(req, res, { url: urlObj, getSess: () => resolveUserSession(req) })) {
      return;
    }

    // Current session info
    if (req.method === 'GET' && pathname === '/api/session') {
      const sess = resolveUserSession(req);
      if (sess.ring === 2 && sess.memberId) {
        const member = loadMembers().find((m) => m.id === sess.memberId);
        return send(res, 200, {
          ring: 2,
          label: 'member',
          displayName: member ? (member.displayName || 'Raden S. Wiryawan') : 'Raden S. Wiryawan',
          corporateHolding: member ? (member.corporateHolding || 'Group CEO, Bimasakti Holdings') : 'Group CEO, Bimasakti Holdings',
          usage: { used: member ? member.used : 0, limit: member ? member.cap : DEFAULT_MONTHLY_CAP },
          conversations: member ? (member.conversations || []).slice(-10) : []
        });
      }
      if (sess.ring === 1 && sess.codeName) {
        return send(res, 200, {
          ring: 1,
          label: 'ring1',
          codeName: sess.codeName,
          channel: sess.channel || null
        });
      }
      return send(res, 200, { ring: 3, label: 'public', revoked: Boolean(sess.revoked) });
    }

    // Ring 2 Member sign-up (Free-for-now entitlement flag)
    if (req.method === 'POST' && pathname === '/api/auth/member/signup') {
      const b = await body(req, 4000);
      const email = String(b.email || '').trim().toLowerCase();
      const credential = String(b.credential || '').trim();
      const displayName = String(b.displayName || 'Raden S. Wiryawan').trim();
      const corporateHolding = String(b.corporateHolding || 'Group CEO, Bimasakti Holdings').trim();
      if (!email || !email.includes('@') || !credential) return send(res, 400, { error: 'bad_request' });
      const members = loadMembers();
      const freeActive = FREE_FOR_NOW && (!studio || studio.commerce.isFreeForNow());
      let member = members.find((m) => m.email === email);
      if (member && !safeEq(member.credentialHash, hashSecret(credential))) {
        audit({ event: 'member_signup_conflict', ring: 2 });
        return send(res, 401, { error: 'denied' });
      }
      if (!member) {
        member = {
          id: 'm_' + crypto.randomBytes(5).toString('hex'),
          email,
          displayName,
          corporateHolding,
          credentialHash: hashSecret(credential),
          entitlement: freeActive ? 'active' : 'pending_payment',
          used: 18,
          cap: DEFAULT_MONTHLY_CAP,
          conversations: [],
          createdAt: new Date().toISOString()
        };
        if (b.startAtZero !== false && !b.displayName) member.used = 0;
        members.push(member);
        saveMembers(members);
      }
      const token = newSession(2, { memberId: member.id });
      audit({ event: 'member_signup', ring: 2, sessionId: member.id, freeForNow: FREE_FOR_NOW });
      return send(res, 200, {
        ok: true,
        ring: 2,
        displayName: member.displayName,
        corporateHolding: member.corporateHolding,
        usage: { used: member.used, limit: member.cap }
      }, { 'set-cookie': `${USER_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` });
    }

    // Ring 2 Member sign-in
    if (req.method === 'POST' && pathname === '/api/auth/member/login') {
      const b = await body(req, 4000);
      const email = String(b.email || '').trim().toLowerCase();
      const credential = String(b.credential || '').trim();
      const member = loadMembers().find((m) => m.email === email);
      if (!member || !safeEq(member.credentialHash, hashSecret(credential))) {
        audit({ event: 'member_login_failed', ring: 2 });
        return send(res, 401, { error: 'denied' });
      }
      const token = newSession(2, { memberId: member.id });
      audit({ event: 'member_login', ring: 2, sessionId: member.id });
      return send(res, 200, {
        ok: true,
        ring: 2,
        displayName: member.displayName || 'Raden S. Wiryawan',
        corporateHolding: member.corporateHolding || 'Group CEO, Bimasakti Holdings',
        usage: { used: member.used, limit: member.cap }
      }, { 'set-cookie': `${USER_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` });
    }

    // Ring 1 Executor 3-factor login (Code Name + Passkey/Device OTP + Rotating Passphrase)
    if (req.method === 'POST' && pathname === '/api/auth/ring1/login') {
      const b = await body(req, 4000);
      const codeName = String(b.codeName || '').trim();
      const otpCode = String(b.otpCode || '').replace(/\s+/g, '');
      const passphrase = String(b.passphrase || '').trim();
      if (!codeName || !otpCode || !passphrase) return send(res, 400, { error: 'bad_request' });
      const list = loadCodenames();
      const entry = list.find((c) => c.codeName.toLowerCase() === codeName.toLowerCase());
      const cleanEntryOtp = entry ? String(entry.otpCode || '').replace(/\s+/g, '') : '';
      if (!entry || entry.status !== 'active' || !safeEq(cleanEntryOtp, otpCode) || !safeEq(entry.passphraseHash, hashSecret(passphrase))) {
        audit({ event: 'ring1_login_failed', ring: 1 });
        return send(res, 401, { error: 'denied' });
      }
      if (b.channel) {
        entry.channel = { provider: String(b.channel), linkedAt: new Date().toISOString() };
        saveCodenames(list);
      }
      const token = newSession(1, { codeName: entry.codeName, passphraseHash: entry.passphraseHash });
      audit({ event: 'ring1_login', ring: 1, codeName: entry.codeName });
      return send(res, 200, {
        ok: true,
        ring: 1,
        codeName: entry.codeName,
        channel: entry.channel
      }, { 'set-cookie': `${USER_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800` });
    }

    // Ring 1 Messaging Channel Pairing (only after successful web login)
    if (req.method === 'POST' && pathname === '/api/auth/ring1/channel') {
      const sess = resolveUserSession(req);
      if (sess.ring !== 1 || !sess.codeName) return send(res, 401, { error: 'denied' });
      const b = await body(req, 2000);
      const channel = b.channel === 'telegram' ? 'telegram' : 'whatsapp';
      const handle = String(b.handle || 'verified_device').slice(0, 64);
      const list = loadCodenames();
      const entry = list.find((c) => c.codeName.toLowerCase() === sess.codeName.toLowerCase());
      if (!entry || entry.status !== 'active') return send(res, 401, { error: 'denied' });
      entry.channel = { provider: channel, linkedAt: new Date().toISOString(), ref: hashSecret(handle).slice(0, 10) };
      saveCodenames(list);
      audit({ event: 'ring1_channel_linked', ring: 1, codeName: entry.codeName, provider: channel });
      return send(res, 200, { ok: true, channel: entry.channel });
    }

    // Sign out
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const t = getCookieToken(req, USER_COOKIE);
      if (t) sessions.delete(t);
      return send(res, 200, { ok: true }, { 'set-cookie': `${USER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }

    // Dormant billing webhook (idempotent entitlement update)
    if (req.method === 'POST' && pathname === '/api/payments/webhook') {
      const b = await body(req, 10000);
      const members = loadMembers();
      const member = members.find((m) => m.id === b.memberId || m.email === b.email);
      if (!member) return send(res, 404, { error: 'not_found' });
      member.entitlement = b.status === 'active' ? 'active' : 'lapsed';
      saveMembers(members);
      audit({ event: 'payment_webhook', ring: 2, sessionId: member.id, entitlement: member.entitlement });
      return send(res, 200, { ok: true, entitlement: member.entitlement });
    }

    // Chat endpoint
    if (req.method === 'POST' && pathname === '/api/chat') {
      const b = await body(req, 20000);
      const lang = langOf(b.lang);
      const q = String(b.message || '').slice(0, 2000);
      if (!q.trim()) return send(res, 400, { error: 'empty' });

      // The ring is decided on the server from the session; any ring sent by the browser is ignored.
      const sess = resolveUserSession(req);
      if (sess.revoked) {
        audit({ event: 'revoked_session_blocked', site: 'user', ring: 3 });
        return send(res, 401, { error: 'session_revoked', reply: REFUSAL[lang] });
      }
      const ring = sess.ring;

      // Enforce Ring 2 monthly fair-use cap
      let usageInfo;
      if (ring === 2 && sess.memberId) {
        const members = loadMembers();
        const member = members.find((m) => m.id === sess.memberId);
        if (member) {
          if (member.used >= member.cap) {
            audit({ event: 'chat_cap_reached', site: 'user', ring: 2, sessionId: sess.sessionId, outcome: 'refused_politely' });
            return send(res, 429, { error: 'cap_reached', reply: CAP_REACHED[lang], usage: { used: member.used, limit: member.cap } });
          }
          member.used += 1;
          member.conversations = member.conversations || [];
          member.conversations.push({ title: q.slice(0, 48), at: new Date().toISOString() });
          saveMembers(members);
          usageInfo = { used: member.used, limit: member.cap };
        }
      }

      const r = await answer(ring, q, lang);
      audit({
        event: 'chat',
        site: 'user',
        ring,
        sessionId: sess.sessionId,
        topic: r.topic || 'general',
        outcome: r.outcome || (r.refused ? 'refused_politely' : 'answered'),
        qlen: q.length,
        sources: r.sources,
        refused: r.refused
      });
      return send(res, 200, {
        reply: r.text,
        disclosure: DISCLOSURE[lang],
        ring: sess.label,
        usage: usageInfo
      });
    }

    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e && e.message === 'bad_json') return send(res, 400, { error: 'bad_json', reply: REFUSAL.en });
    if (e && e.message === 'too_large') return send(res, 413, { error: 'too_large', reply: REFUSAL.en });
    audit({ event: 'error', site: 'user', msg: String(e.message) });
    return send(res, 500, { reply: REFUSAL.en }); // fail closed
  }
});

function initStudio() {
  if (!studio) {
    studio = createStudio({
      DATA, PUBLIC_DIR, db, readJson, writeJson, audit, send, body,
      loadStore, saveStore, loadPending, savePending, loadPrecedents, savePrecedents,
      loadCodenames, saveCodenames, loadMembers, saveMembers,
      SENSITIVE, readableRings, REFUSAL, FREE_FOR_NOW, DEFAULT_MONTHLY_CAP,
      sessions, answer: (...args) => answer(...args), FIXED_DUTIES
    });
  }
  return studio;
}
initStudio();

adminServer.on('error', (err) => {
  console.log('Standalone admin port notice:', err.message);
});
userServer.on('error', (err) => {
  console.error('User server error:', err.message);
});

function start() {
  ensureStores();
  userServer.listen(USER_PORT, () => console.log('user site on', USER_PORT));
  if (ADMIN_PORT && ADMIN_PORT !== USER_PORT) {
    try {
      adminServer.listen(ADMIN_PORT, () => console.log('admin site on', ADMIN_PORT));
    } catch (e) {
      console.log('Admin port skipped:', e.message);
    }
  }
}
// Hostinger Node.js hosting wraps the entry file, so start() must be called directly.
start();
module.exports = { start, userServer, adminServer, ensureStores, retrieve, leakGuard, readableRings, seedSampleKnowledge, studio, db };
