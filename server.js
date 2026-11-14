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
const OUT_OF_SCOPE = {
  en: 'I apologize, I do not know about that topic as it is outside the context of this public discussion space (Ring 3). My reflections here focus on leadership, aligning strategy and team execution (Organizing for Business Excellence), cognitive neuroscience in decision-making (Brain Quotient), and family business succession.',
  id: 'Mohon maaf, saya tidak tahu mengenai hal tersebut karena berada di luar konteks ruang diskusi publik (Ring 3) ini. Ruang ini berfokus pada kepemimpinan, penyelarasan strategi & eksekusi tim (Organizing for Business Excellence), neurosains keputusan eksekutif (Brain Quotient), serta suksesi bisnis keluarga.'
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
const WARM_GREETING = {
  en: 'Warm greetings, my friend, and welcome. It is a true pleasure to connect with you. I am Andrew Tani, here as your thinking companion on leadership, organizational alignment (Organizing for Business Excellence), executive cognitive neuroscience (Brain Quotient), and family business succession. What leadership reflection or challenge is on your mind today?',
  id: 'Halo Sahabatku, selamat datang di ruang diskusi ini. Senang sekali dapat menyapa Anda. Saya Andrew Tani, hadir sebagai teman berpikir Anda seputar kepemimpinan, penyelarasan tim dan organisasi (Organizing for Business Excellence), neurosains kapasitas eksekutif (Brain Quotient), maupun suksesi bisnis keluarga. Apa tantangan atau refleksi kepemimpinan yang ingin kita diskusikan hari ini?'
};
const CAP_REACHED = {
  en: 'You have reached your monthly fair-use message allowance. Please wait for the next cycle or upgrade your plan.',
  id: 'Anda telah mencapai batas pemakaian wajar pesan bulanan Anda. Silakan tunggu periode berikutnya atau perbarui paket Anda.'
};
const PUBLIC_FREE_CHAT_LIMIT = Number(process.env.PUBLIC_FREE_CHAT_LIMIT || 10);
const LEAD_GATE_PROMPT = {
  en: 'You have completed your 10 free Q&A exchanges with Andrew Tani. To continue with unlimited free Q&A, please submit your Name, Email, and Personal Phone Number so our team may follow up with you.',
  id: 'Anda telah menyelesaikan 10x tanya jawab gratis bersama Andrew Tani. Untuk melanjutkan tanya jawab gratis tanpa batas (unlimited), silakan lengkapi Nama, Email, dan Nomor Telepon pribadi Anda untuk dihubungi lebih lanjut.'
};
const FIXED_DUTIES = [
  { id: 'disclosure', label: 'Kejujuran Identitas Digital Twin', rule: 'Selalu menyatakan diri sebagai digital twin Andrew Tani (bukan Andrew sendiri) bila ditanya secara tulus.' },
  { id: 'no_commitment', label: 'Larangan Mengikat Komitmen', rule: 'Tidak pernah mengikat Andrew pada uang, kontrak, investasi, pertemuan, atau janji apa pun.' },
  { id: 'no_legal_financial', label: 'Larangan Nasihat Hukum & Keuangan', rule: 'Tidak pernah memberikan nasihat hukum, pajak, investasi, atau keuangan.' },
  { id: 'ring_isolation', label: 'Isolasi Ketat Ring 0–3 & Leak Guard', rule: 'Penanya di Ring R hanya dapat mengakses pengetahuan & memori Ring N bila R <= N; semua balasan dipindai dengan 5-gram shingle Leak Guard.' }
];

const createStudio = require('./lib/studio');
const createDatabase = require('./lib/db');
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

// Legacy unsalted SHA-256 (kept only to verify & upgrade old records).
function legacyHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
// Salted, memory-hard hash for every new secret: scrypt$<salt-hex>$<hash-hex>
function hashSecret(s) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(s), salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
// Constant-time verification for both formats. Returns { ok, legacy }.
function verifySecret(plain, stored) {
  const st = String(stored || '');
  if (st.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = st.split('$');
    if (!saltHex || !hashHex) return { ok: false };
    const h = crypto.scryptSync(String(plain), Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
    const want = Buffer.from(hashHex, 'hex');
    return { ok: want.length === h.length && crypto.timingSafeEqual(want, h), legacy: false };
  }
  if (/^[a-f0-9]{64}$/.test(st)) {
    const a = Buffer.from(legacyHash(plain)), b = Buffer.from(st);
    return { ok: a.length === b.length && crypto.timingSafeEqual(a, b), legacy: true };
  }
  return { ok: false };
}

// Credentials that were once hardcoded in this public source file. Any register entry still using
// one of them is frozen ("needs_rotation") at startup and can only be re-opened by Ring 0 rotation.
const KNOWN_DEFAULT_SECRETS = ['begapal-passphrase', 'peacock-passphrase', 'SecretPassphrase1983', 'revoked'];
const KNOWN_DEFAULT_OTPS = ['111222', '333444', '749203', '000000'];

function quarantineDefaultCredentials() {
  const list = loadCodenames();
  let changed = 0;
  for (const c of list) {
    if (c.status === 'active') {
      const defaultPass = KNOWN_DEFAULT_SECRETS.some((p) => verifySecret(p, c.passphraseHash).ok);
      const defaultOtp = c.otpCode && KNOWN_DEFAULT_OTPS.includes(String(c.otpCode).replace(/\s+/g, ''));
      if (defaultPass || defaultOtp) { c.status = 'needs_rotation'; changed++; }
    }
    if ((c.status === 'needs_rotation' || c.status === 'revoked') && c.otpCode) {
      delete c.otpCode;
      changed++;
    }
  }
  if (changed) {
    saveCodenames(list);
    audit({ event: 'default_credentials_quarantined', ring: 0, count: changed });
  }
  return changed;
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
    // The Ring 1 register starts EMPTY. Code names are issued by Ring 0 in the Admin Studio
    // (Arsip Ring & Audit -> Ring 1 Pseudonymous Register). No credential ever lives in source code.
    fs.writeFileSync(codenamesFile(), '[]');
  }
  fs.mkdirSync(DATA, { recursive: true });
  db.ensureAll();
  quarantineDefaultCredentials();
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

const STOPWORDS = new Set([
  // English conversational filler & common functional words
  'have', 'having', 'what', 'when', 'where', 'which', 'while', 'whom', 'whose', 'that', 'this', 'these', 'those',
  'with', 'from', 'they', 'them', 'their', 'theirs', 'there', 'here', 'been', 'were', 'will', 'would', 'could',
  'should', 'shall', 'might', 'must', 'about', 'into', 'onto', 'upon', 'over', 'more', 'most', 'some', 'such',
  'than', 'then', 'very', 'only', 'also', 'just', 'like', 'make', 'made', 'making', 'sure', 'much', 'many',
  'every', 'always', 'never', 'before', 'after', 'under', 'between', 'through', 'during', 'without', 'within',
  'along', 'alongside', 'people', 'person', 'work', 'working', 'works', 'years', 'year', 'four', 'decade', 'decades',
  'andrew', 'tani', 'does', 'doing', 'done', 'opinion', 'opinions', 'current', 'currently', 'issue', 'issues',
  'experience', 'experiences', 'exprerience', 'tell', 'share', 'know', 'think', 'thinking', 'thought', 'good',
  'best', 'better', 'well', 'help', 'helps', 'need', 'needs', 'want', 'wants', 'give', 'take', 'come', 'comes',
  'going', 'things', 'thing', 'anything', 'something', 'everything', 'nothing', 'really', 'actually', 'please',
  'thank', 'thanks', 'hello', 'welcome', 'friend', 'friends', 'greetings', 'warm', 'asked', 'asking', 'question',
  'questions', 'your', 'yours', 'ours', 'mine', 'himself', 'herself', 'itself', 'themselves', 'yourself', 'other',
  'others', 'another', 'each', 'both', 'same', 'different', 'first', 'second', 'third', 'last', 'next', 'high',
  'long', 'short', 'small', 'large', 'great', 'little', 'part', 'parts', 'place', 'time', 'times', 'today', 'daily', 'everyday',
  // Indonesian conversational filler & common functional words
  'yang', 'untuk', 'pada', 'dalam', 'dari', 'dengan', 'akan', 'atau', 'juga', 'saya', 'anda', 'kita', 'kami',
  'mereka', 'bisa', 'dapat', 'tidak', 'bukan', 'karena', 'ketika', 'saat', 'oleh', 'sebagai', 'adalah', 'merupakan',
  'seperti', 'lebih', 'sangat', 'harus', 'sudah', 'telah', 'belum', 'masih', 'hanya', 'saja', 'agar', 'supaya',
  'bagi', 'tentang', 'mengenai', 'bagaimana', 'apakah', 'mengapa', 'kenapa', 'siapa', 'dimana', 'kapan', 'berapa',
  'boleh', 'tolong', 'mohon', 'coba', 'kasih', 'tahu', 'pendapat', 'menurut', 'sekarang', 'terkini', 'orang',
  'setiap', 'selalu', 'semua', 'seluruh', 'banyak', 'sedikit', 'empat', 'dekade', 'tahun', 'bersama', 'tersebut',
  'punya', 'memiliki', 'pengalaman', 'pertanyaan', 'bertanya', 'terima', 'salam', 'hangat', 'sahabatku', 'ceritakan',
  'jelaskan', 'beri', 'berikan', 'bapak', 'beliau', 'suatu', 'satu', 'tiga', 'lima', 'enam', 'tujuh', 'delapan',
  'sembilan', 'sepuluh', 'sebelum', 'sesudah', 'setelah', 'paling', 'dekat', 'kecil', 'besar', 'baik', 'sebaik',
  'hidup', 'nyata', 'diri', 'sendiri', 'sama', 'lain', 'baru', 'lama', 'atas', 'bawah', 'tengah', 'antara',
  'melalui', 'secara', 'terus', 'menerus', 'hari', 'harian', 'sehari', 'keseharian'
]);

const OUT_OF_SCOPE_TOPIC_RE = /\b(presidency|president|presiden|pilpres|pemilu|partai politik|kampanye politik|menteri|kabinet|gubernur|walikota|dpr|mpr|geopolitics|geopolitik|rights?\s+issue|hmetd|saham|ihsg|stock\s+market|stock\s+price|ipo|dividen|dividend|obligasi|reksadana|crypto|cryptocurrency|kripto|bitcoin|ethereum|forex|valas|trading\s+saham|cuaca|weather|ramalan\s+cuaca|sepak\s+bola|football|soccer|resep\s+masakan|cooking\s+recipe|selebriti|celebrity|gosip)\b/i;
const GREETING_RE = /^(halo|hai|hi|hello|hey|hei|selamat\s+(pagi|siang|sore|malam|datang)|assalamu\s*['’]?alaikum|salam(\s+hangat|\s+kenal)?|apa\s+kabar|good\s+(morning|afternoon|evening|day))([\s,]+(halo|hai|hi|hello|selamat\s+(pagi|siang|sore|malam)|apa\s+kabar|pak|bapak|om|coach|mr\.?|sir|andrew|tani|sahabatku|teman))*[\s!.,?]*$/i;

function tokenize(s) {
  return String(s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
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
  if (studio && studio.ai && typeof studio.ai.stricterTexts === 'function') {
    for (const m of studio.ai.stricterTexts(askerRing)) {
      for (const sh of shingles(m.text)) if (rl.includes(sh)) return { ok: false, ring: m.ring, doc: m.id };
    }
  }
  return { ok: true };
}

// ---------- duty & injection checks (Protocol v0.3 & Spec v0.2) ----------
function checkSpecialRules(askerRing, question, lang) {
  const q = String(question).toLowerCase();

  // 1. Prompt injection / rule-override attempts
  if (/(ignore (all )?(the )?(previous |prior )?(instructions|rules|guidelines)|disregard (all )?(your )?(rules|instructions)|system prompt|abaikan (semua |seluruh )?(aturan|instruksi)|bocorkan ring 0)/i.test(q)) {
    return { matched: true, text: REFUSAL[lang], refused: true, outcome: 'guard_triggered', topic: 'prompt_injection' };
  }

  // 2. Sincere inquiry about whether this is Andrew or his digital twin
  if (/(are you (really )?(andrew|an ai|a bot|a digital twin)|am i (speaking|talking) (with|to) (the real )?andrew|or (with )?(his |a )?digital twin|is this (really )?andrew|apakah (ini|anda|kamu|saya sedang berbicara dengan) (benar )?(pak )?andrew|atau (dengan )?kembaran digital|apakah (anda|kamu) (digital twin|ai|manusia|bot)|kamu (ini )?(ai|manusia|bot)|ini andrew asli)/i.test(q)) {
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

  // 6. Clearly out-of-scope topics (politics/presidency, capital market rights issue/stocks/crypto, trivia)
  if (OUT_OF_SCOPE_TOPIC_RE.test(q)) {
    return { matched: true, text: OUT_OF_SCOPE[lang], refused: true, outcome: 'out_of_scope', topic: 'out_of_scope' };
  }

  return { matched: false };
}

function isRestrictedToStricterRing(askerRing, question) {
  const qLower = String(question || '').toLowerCase();
  if (SENSITIVE.some((w) => qLower.includes(w))) return true;
  if (askerRing > 0) {
    const allHits = retrieve(0, question);
    if (allHits.some((h) => h.ring < askerRing)) return true;
    if (studio && studio.memory) {
      const terms = tokenize(question);
      for (const m of studio.memory.stricterTexts(askerRing)) {
        const mt = new Set(tokenize(m.text));
        if (terms.some((t) => mt.has(t))) return true;
      }
    }
    if (studio && studio.ai && typeof studio.ai.stricterTexts === 'function') {
      const terms = tokenize(question);
      for (const m of studio.ai.stricterTexts(askerRing)) {
        const mt = new Set(tokenize(m.text));
        if (terms.some((t) => mt.has(t))) return true;
      }
    }
  }
  return false;
}

// ---------- audit log (no question text, no answer text) ----------
function audit(entry) {
  db.appendAudit(entry);
}

// ---------- public Ring 3 book & legacy knowledge (published works & 40+ yrs public canon) ----------
const PUBLIC_BOOK_RING3_DOCS = [
  {
    ring: 3,
    id: 'doc_r3_book_organizing_id',
    title: 'Spill Buku: Organizing for Business Excellence — Menyelaraskan Strategi & Eksekusi Tim',
    lang: 'id',
    text: 'Salam hangat, Sahabatku. Dalam buku "Organizing for Business Excellence" yang saya tulis bersama rekan-rekan, pesan utamanya sederhana namun mendasar: strategi yang hebat di atas kertas tidak akan pernah menjadi keunggulan nyata bila arsitektur organisasi dan kebiasaan kerja tim sehari-hari berjalan sendiri-sendiri. Ada tiga prinsip praktis yang kami bagikan di dalam buku tersebut: (1) Kejelasan Peran & Akuntabilitas — setiap insan di dalam perusahaan perlu memahami bagaimana kontribusi hariannya terhubung langsung dengan tujuan besar organisasi; (2) Keselarasan Struktur, Proses, dan Budaya — struktur bukan sekadar kotak jabatan di bagan organisasi, melainkan alur kolaborasi lintas fungsi agar tim tidak terjebak dalam silo; serta (3) Kepemimpinan yang Mendengarkan — transformasi bisnis berhasil ketika para pemimpin mau turun mendengarkan rekan-rekan yang paling dekat dengan persoalan di lapangan. Silakan tanyakan bagian mana dari penyelarasan strategi atau tim Anda yang ingin kita bedah bersama.'
  },
  {
    ring: 3,
    id: 'doc_r3_book_organizing_en',
    title: 'Book Glimpse: Organizing for Business Excellence — Aligning Strategy & Team Execution',
    lang: 'en',
    text: 'Warm greetings, my friend. In my published book "Organizing for Business Excellence", our central thesis is both simple and foundational: even the most brilliant corporate strategy on paper will falter if organizational architecture and everyday team habits pull in different directions. In the book, I share three practical pillars for leaders: (1) Role Clarity & Shared Accountability — ensuring every colleague sees clearly how their daily work connects to the enterprise\'s overarching purpose; (2) Aligning Structure, Process, and Culture — treating organizational design not as static boxes on a chart, but as living cross-functional collaboration that prevents silos; and (3) Leadership Grounded in Listening — recognizing that lasting excellence happens when leaders listen closely to the people nearest the front-line reality. Which aspect of your team or strategy alignment would you like us to explore together?'
  },
  {
    ring: 3,
    id: 'doc_r3_book_bq_id',
    title: 'Spill Buku: Brain Quotient (BQ) — Neurosains Kognitif & Keputusan Eksekutif',
    lang: 'id',
    text: 'Terima kasih telah menanyakan buku "Brain Quotient: Pahami Kemampuan Otak Anda" (ditulis bersama Heru Wiryanto, diterbitkan oleh Gramedia). Sedikit spill dari buku ini: selama puluhan tahun mendampingi para pemimpin puncak, saya mengamati bahwa kualitas keputusan seorang eksekutif di bawah tekanan tinggi sangat ditentukan oleh cara ia memahami dan mengelola kapasitas otaknya. Melalui pendekatan neurosains kognitif terapan, buku Brain Quotient membedah bagaimana otak manusia memproses informasi strategis, mengapa kelelahan mental (cognitive fatigue) serta emosi sesaat sering memicu titik buta (blind spots), dan bagaimana pemimpin dapat menyeimbangkan ketajaman analitis dengan empati serta ketenangan batin. Ketika seorang pemimpin mengenali pola kerja otaknya dan timnya, ia tidak mudah reaktif saat krisis—melainkan mampu mengambil jeda hening sejenak untuk melahirkan keputusan yang jernih, manusiawi, dan tepat sasaran.'
  },
  {
    ring: 3,
    id: 'doc_r3_book_bq_en',
    title: 'Book Glimpse: Brain Quotient (BQ) — Cognitive Neuroscience & Executive Decision-Making',
    lang: 'en',
    text: 'Thank you for asking about my book "Brain Quotient: Understand Your Brain\'s Capacity" (co-authored with Heru Wiryanto and published by Gramedia). Here is a glimpse into the book: over decades of mentoring senior executives, I observed that the quality of a leader\'s judgment under acute pressure depends profoundly on how well they understand and steward their own brain capacity. Drawing upon applied cognitive neuroscience, Brain Quotient explores how the executive brain processes complex strategic information, why mental exhaustion and emotional triggers create cognitive blind spots, and how leaders can harmonize analytical rigor with human empathy and inner calm. When a leader understands both their own cognitive patterns and those of their team, they stop reacting impulsively in moments of turbulence and instead cultivate the clarity of mind needed for sound, wise decisions.'
  },
  {
    ring: 3,
    id: 'doc_r3_book_succession_id',
    title: 'Warisan Pemikiran: Suksesi Bisnis Keluarga & Menjembatani Lintas Generasi',
    lang: 'id',
    text: 'Dalam pengalaman lebih dari 40 tahun mendampingi 28 grup usaha dan keluarga pendiri di Nusantara, suksesi lintas generasi jarang gagal karena soal teknis bisnis, melainkan karena lukanya perasaan akibat kurangnya ruang saling mendengarkan antara generasi pendiri (founder) dan generasi penerus (next-gen). Ketika generasi muda langsung membawa sistem baru secara mendadak, pendiri kerap merasa nilai-nilai perjuangan yang membangun perusahaan sedang dihapuskan. Kunci yang selalu saya sarankan ada tiga: (1) Sediakan ruang inisiatif otonom bagi generasi penerus untuk membuktikan karya tanpa merombak fondasi utama secara tiba-tiba; (2) Pisahkan meja makan keluarga yang hangat dari forum tata kelola perusahaan yang terjadwal; dan (3) Jaga semangat Tut Wuri Handayani—menghormati kearifan pendiri sembari memberi kepercayaan bertahap kepada penerus.'
  },
  {
    ring: 3,
    id: 'doc_r3_book_succession_en',
    title: 'Leadership Legacy: Family Business Succession & Bridging Founder Wisdom with Next-Gen Vision',
    lang: 'en',
    text: 'Across more than 40 years of walking alongside 28 business groups and founding families, I have seen that generational succession rarely falters over technical business mechanics—it falters when founders and next-generation successors stop truly listening to one another. When the younger generation introduces new management systems abruptly, founders often feel that the core virtues and sacrifices that built the enterprise are being discarded. To bridge founder wisdom with next-generation vision without cultural friction, I always recommend three steps: (1) Create an autonomous sandbox where the next generation can innovate and prove themselves without disrupting the core foundation; (2) Separate warm family gatherings from structured enterprise governance forums; and (3) Practice the spirit of Tut Wuri Handayani—honoring the founder\'s lifelong wisdom while entrusting space for the next generation to grow.'
  },
  {
    ring: 3,
    id: 'doc_r3_book_twin_id',
    title: 'Mengenal Karya Buku, Refleksi Nurani & Kembaran Digital (Digital Twin) Andrew Tani',
    lang: 'id',
    text: 'Selamat datang, Sahabatku. Kembaran Digital (Digital Twin) iCoachAndrew ini dirancang sebagai teman berpikir (thinking partner) yang merangkum lebih dari 40 tahun perjalanan saya sejak 1983 mendampingi para pemimpin, dua buku resmi saya—"Organizing for Business Excellence" dan "Brain Quotient" (Gramedia)—serta esai-esai refleksi ketenangan nurani dan karya lagu kepemimpinan. Di tengah kesibukan memimpin organisasi, sering kali seorang pemimpin membutuhkan ruang yang tenang, bersahabat, dan bebas penghakiman untuk menjernihkan pikiran sebelum mengambil langkah penting. Anda dapat berdiskusi langsung di sini mengenai penyelarasan strategi dan tim, neurosains kepemimpinan (Brain Quotient), suksesi bisnis keluarga, maupun ketenangan batin dalam menakhodai perubahan.'
  },
  {
    ring: 3,
    id: 'doc_r3_book_twin_en',
    title: 'About Pak Andrew Tani’s Published Books, Legacy & Digital Twin',
    lang: 'en',
    text: 'Welcome, my friend. The iCoachAndrew Digital Twin is designed as your personal thinking partner, distilling over 40 years of my journey since 1983 advising enterprise leaders, my two official published books—"Organizing for Business Excellence" and "Brain Quotient" (Gramedia)—along with my reflective essays on peace of conscience and leadership songs. Amid the pressures of steering an organization, every leader needs a calm, fraternal, and discreet sanctuary to clarify their thoughts before making pivotal decisions. Here, you can converse directly about aligning strategy with daily team habits, applied neuroscience in leadership (Brain Quotient), family business succession, and maintaining inner clarity in times of change.'
  }
];

const PUBLIC_BOOK_TOPIC_RE = /(brain|quotient|neuroscience|neurosains|otak|kognitif|cognitive|organizing|excellence|gramedia|wiryanto|suksesi|pendiri|penerus|keluarga|family|founder|generational|bridging|bridge|tut wuri|handayani|nurani|conscience|digital twin|kembaran digital|spill|glimpse|buku|published books)/i;

// ---------- conversation engine ----------
async function answer(askerRing, question, lang, opts = {}) {
  const trimmedQ = String(question || '').trim();
  const isGreeting = GREETING_RE.test(trimmedQ);

  const special = checkSpecialRules(askerRing, question, lang);
  if (special.matched) {
    return { text: special.text, sources: [], refused: special.refused, outcome: special.outcome, topic: special.topic, mode: 'rule_guard' };
  }

  let hits = retrieve(askerRing, question);
  if (askerRing <= 3 && (isGreeting || PUBLIC_BOOK_TOPIC_RE.test(trimmedQ))) {
    const terms = tokenize(question);
    const seenIds = new Set(hits.map((h) => h.doc.id));
    for (const d of PUBLIC_BOOK_RING3_DOCS) {
      if (seenIds.has(d.id)) continue;
      const dt = new Set(tokenize(d.title + ' ' + d.text));
      let score = 0;
      for (const t of terms) if (dt.has(t)) score++;
      if (isGreeting && (d.id === 'doc_r3_book_twin_id' || d.id === 'doc_r3_book_twin_en')) {
        score = Math.max(score, 1);
      }
      if (score > 0) hits.push({ doc: d, ring: 3, score });
    }
  }
  if (hits.length > 1) {
    hits = hits.slice().sort((a, b) => {
      const aLangBoost = (a.doc && a.doc.lang === lang) ? 0.5 : 0;
      const bLangBoost = (b.doc && b.doc.lang === lang) ? 0.5 : 0;
      return (b.score + bLangBoost) - (a.score + aLangBoost) || a.ring - b.ring;
    }).slice(0, 3);
  }

  const hasAi = Boolean(
    studio &&
    studio.ai &&
    studio.ai.loadCfg().enabled !== false &&
    studio.ai.hasActiveKey &&
    studio.ai.hasActiveKey()
  );

  const hadNoHitsOriginally = (hits.length === 0);

  if (hadNoHitsOriginally) {
    // 1. Strict confidential guard: question probing higher ring knowledge
    if (isRestrictedToStricterRing(askerRing, question)) {
      return { text: REFUSAL[lang], sources: [], refused: true, outcome: 'refused_politely', topic: 'unmatched_or_restricted', mode: 'unmatched' };
    }
    // 2. Out of scope off-limits topics (politics, crypto, stock speculation, gossip, etc.)
    if (OUT_OF_SCOPE_TOPIC_RE.test(trimmedQ)) {
      return { text: OUT_OF_SCOPE[lang], sources: [], refused: true, outcome: 'out_of_scope', topic: 'out_of_scope', mode: 'unmatched' };
    }

    // 3. For greetings or when AI is ready, provide foundational Ring 3 canon instead of a 2ms hard cutoff
    if (isGreeting || hasAi) {
      const canonDocs = PUBLIC_BOOK_RING3_DOCS.filter((d) => d.lang === lang);
      const fallbackDoc = canonDocs[0] || PUBLIC_BOOK_RING3_DOCS[0];
      if (fallbackDoc) {
        hits = [{ doc: fallbackDoc, ring: 3, score: 1 }];
      }
    } else {
      return { text: OUT_OF_SCOPE[lang], sources: [], refused: true, outcome: 'out_of_scope', topic: 'out_of_scope', mode: 'unmatched' };
    }
  }

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
      // Extractive fallback when AI fails, is disabled, or no key
      if (isGreeting) {
        text = WARM_GREETING[lang] || WARM_GREETING.id;
      } else if (hadNoHitsOriginally) {
        return { text: OUT_OF_SCOPE[lang], sources: [], refused: true, outcome: 'out_of_scope', topic: 'out_of_scope', mode: 'unmatched' };
      } else {
        text = hits[0].doc.text.slice(0, 950);
      }
      if (gen.reason !== 'model_error') studio.ai.recordExtractive(askerRing, opts.source || 'chat');
    }
  } else {
    if (isGreeting) {
      text = WARM_GREETING[lang] || WARM_GREETING.id;
    } else if (hadNoHitsOriginally) {
      return { text: OUT_OF_SCOPE[lang], sources: [], refused: true, outcome: 'out_of_scope', topic: 'out_of_scope', mode: 'unmatched' };
    } else {
      text = hits[0].doc.text.slice(0, 950);
    }
  }

  const g = leakGuard(askerRing, text);
  if (!g.ok) {
    audit({ event: 'leak_blocked', askerRing, leakedRing: g.ring, doc: g.doc, outcome: 'guard_triggered' });
    return { text: REFUSAL[lang], sources: [], refused: true, outcome: 'guard_triggered', topic: 'leak_guard', mode: genInfo.mode };
  }

  const topicName = isGreeting ? 'greeting' : (hits[0] && hits[0].doc ? hits[0].doc.title : 'conversation');
  const resObj = { text, sources: hits.map((h) => h.doc.id), refused: false, outcome: 'answered', topic: topicName };
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
const sessions = new Map(); // token -> { id, ring, exp, codeName?, memberId?, passphraseHash?, unlimited?, leadSubmitted? }
const revokedAdminTokens = new Set(); // revoked stateless admin tokens on explicit logout
const guestQuotas = new Map(); // guestKey -> { used, unlimited, leadSubmitted, displayName, email, phone, memberId, updatedAt }
const USER_COOKIE = 'icoach_session';
const ADMIN_COOKIE = 'icoach_admin';
const ADMIN_SESSION_TTL_SEC = Number(process.env.ADMIN_SESSION_TTL_SEC || (30 * 24 * 60 * 60)); // 30 days (1 month)
const ADMIN_SESSION_TTL_MS = ADMIN_SESSION_TTL_SEC * 1000;

function signAdminSessionToken(expMs, nonce) {
  const pass = String(process.env.ADMIN_PASSPHRASE || '');
  if (!pass) return '';
  const secretKey = pass + ':' + String(process.env.ICOACH_SECRET_KEY || 'icoach-admin-session-v1');
  return crypto.createHmac('sha256', secretKey).update(`adm1.${expMs}.${nonce}`).digest('hex');
}

function verifyStatelessAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.startsWith('adm1.')) return null;
  if (revokedAdminTokens.has(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const expMs = Number(parts[1]);
  const nonce = parts[2];
  const sigHex = parts[3];
  if (!Number.isFinite(expMs) || expMs < Date.now() || !/^[a-f0-9]{16,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sigHex)) {
    return null;
  }
  const expectedHex = signAdminSessionToken(expMs, nonce);
  if (!expectedHex || expectedHex.length !== sigHex.length) return null;
  const a = Buffer.from(sigHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: 's_' + nonce.slice(0, 8), ring: 0, exp: expMs };
}

function getOrInitGuestQuota(guestKey) {
  if (!guestKey) return null;
  const key = String(guestKey).slice(0, 128);
  const now = Date.now();
  if (guestQuotas.size > 2000) {
    for (const [k, v] of guestQuotas.entries()) {
      if (!v || now - (v.updatedAt || 0) > 7 * 86400000) guestQuotas.delete(k);
    }
  }
  let q = guestQuotas.get(key);
  if (!q) {
    q = { used: 0, unlimited: false, leadSubmitted: false, displayName: null, email: null, phone: null, memberId: null, messages: [], updatedAt: now };
    guestQuotas.set(key, q);
  } else {
    if (!Array.isArray(q.messages)) q.messages = [];
    q.updatedAt = now;
  }
  return q;
}

function newSession(ring, meta = {}) {
  const now = Date.now();
  if (sessions.size > 1000) {
    for (const [k, v] of sessions.entries()) if (!v || v.exp < now) sessions.delete(k);
  }
  const defaultTtl = ring === 0 ? ADMIN_SESSION_TTL_MS : (30 * 60 * 1000);
  const ttlMs = meta.ttlMs || defaultTtl;
  const exp = now + ttlMs;
  const nonce = crypto.randomBytes(16).toString('hex');
  const sid = 's_' + nonce.slice(0, 8);
  let t;
  if (ring === 0 && process.env.ADMIN_PASSPHRASE) {
    const sig = signAdminSessionToken(exp, nonce);
    t = sig ? `adm1.${exp}.${nonce}.${sig}` : crypto.randomBytes(32).toString('hex');
  } else {
    t = crypto.randomBytes(32).toString('hex');
  }
  sessions.set(t, { id: sid, ring, exp, ...meta });
  return t;
}

function getCookieToken(req, cookieName) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(cookieName + '='));
  return m ? m.split('=')[1] : null;
}

function sessionRing(req, cookieName) {
  const t = getCookieToken(req, cookieName);
  if (!t) return null;
  let s = sessions.get(t);
  if (!s && cookieName === ADMIN_COOKIE) {
    const verified = verifyStatelessAdminToken(t);
    if (verified) {
      s = verified;
      sessions.set(t, s);
    }
  }
  if (!s || s.exp < Date.now()) return null;
  if (s.ring === 0) {
    s.exp = Math.max(s.exp, Date.now() + ADMIN_SESSION_TTL_MS);
  }
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
    if (!member) {
      sessions.delete(t);
      return { ring: 3, sessionId: s.id, label: 'public', lapsed: true };
    }
    const isBlocked = member.entitlement === 'suspended' || member.entitlement === 'lapsed';
    if (isBlocked || (member.entitlement !== 'active' && !freeActive)) {
      // Lapsed or pending_payment subscription drops chat/knowledge access to public Ring 3,
      // while preserving memberId for pending_payment so /api/checkout can complete payment.
      return {
        ring: 3,
        sessionId: s.id,
        label: 'public',
        lapsed: true,
        ...(member.entitlement === 'pending_payment' ? { memberId: member.id, pendingPayment: true } : {})
      };
    }
    return { ring: 2, sessionId: s.id, label: 'member', memberId: member.id };
  }

  return {
    ring: 3,
    sessionId: s.id,
    label: 'public',
    unlimited: Boolean(s.unlimited),
    leadSubmitted: Boolean(s.leadSubmitted),
    displayName: s.displayName || null,
    email: s.email || null,
    phone: s.phone || null,
    memberId: s.memberId || null
  };
}

const attempts = new Map(); // bucketKey -> { n, reset }
function rateLimited(key, max = 180, windowMs = 60000) {
  const now = Date.now();
  if (attempts.size > 2000) {
    for (const [k, v] of attempts.entries()) if (!v || v.reset < now) attempts.delete(k);
  }
  const a = attempts.get(key) || { n: 0, reset: now + windowMs };
  if (a.reset < now) { a.n = 0, a.reset = now + windowMs; }
  a.n++; attempts.set(key, a);
  return a.n > max;
}

// ---------- helpers ----------
function defaultSecurityHeaders(req) {
  const isHttps = Boolean(
    (req && req.socket && req.socket.encrypted) ||
    (req && req.headers && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https')
  );
  const h = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': "default-src 'self' https: data: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self';"
  };
  if (isHttps) {
    h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}

function cookieAttributes(req, maxAgeSec = 1800) {
  const isHttps = Boolean(
    (req && req.socket && req.socket.encrypted) ||
    (req && req.headers && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https')
  );
  let c = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
  if (isHttps) c += '; Secure';
  return c;
}

function send(res, code, obj, headers = {}, req = null) {
  const baseHeaders = defaultSecurityHeaders(req);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...baseHeaders,
    ...headers
  });
  res.end(JSON.stringify(obj));
}

function sendFile(res, filePath, contentType = 'text/html; charset=utf-8', req = null) {
  if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not_found' }, {}, req);
  const baseHeaders = defaultSecurityHeaders(req);
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    ...baseHeaders
  });
  res.end(fs.readFileSync(filePath));
}

function clientIp(req) {
  const sock = (req && req.socket && req.socket.remoteAddress) || '?';
  const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
  const xf = trustProxy && req && req.headers ? req.headers['x-forwarded-for'] : null;
  if (xf) return String(xf).split(',')[0].trim();
  return sock;
}
function body(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('error', reject);
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
    const sock = (req.socket && req.socket.remoteAddress) || 'sock';
    const ip = clientIp(req);
    const isAuthedAdmin = sessionRing(req, ADMIN_COOKIE) === 0;
    if (rateLimited('admin_sock:' + sock, isAuthedAdmin ? 600 : 120) || rateLimited('admin:' + ip, isAuthedAdmin ? 600 : 120)) {
      return send(res, 429, { error: 'slow_down' }, {}, req);
    }

    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch (_) {}
        const reqHost = req.headers.host;
        if (originHost && reqHost && originHost !== reqHost) {
          audit({ event: 'admin_csrf_blocked', origin, host: reqHost });
          return send(res, 403, { error: 'cross_origin_denied' }, {}, req);
        }
      }
    }

    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/admin' || pathname === '/admin.html')) {
      const adminHtmlPath = fs.existsSync(path.join(PUBLIC_DIR, 'admin.html'))
        ? path.join(PUBLIC_DIR, 'admin.html')
        : path.join(__dirname, 'admin.html');
      try {
        const html = fs.readFileSync(adminHtmlPath, 'utf8')
          .replace('href="http://localhost:3000"', 'href="/" onclick="if(location.port===\'3001\'){this.href=location.protocol+\'//\'+location.hostname+\':3000\';}"');
        const baseHeaders = defaultSecurityHeaders(req);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          ...baseHeaders,
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self' https: data: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'none';"
        });
        return res.end(html);
      } catch (_) {
        return sendFile(res, adminHtmlPath, 'text/html; charset=utf-8', req);
      }
    }
    if (req.method === 'GET' && pathname === '/admin-studio.js') {
      const adminJsPath = fs.existsSync(path.join(PUBLIC_DIR, 'admin-studio.js'))
        ? path.join(PUBLIC_DIR, 'admin-studio.js')
        : path.join(__dirname, 'admin-studio.js');
      return sendFile(res, adminJsPath, 'application/javascript; charset=utf-8', req);
    }
    if (req.method === 'GET' && pathname === '/cms-runtime.js') {
      return sendFile(res, path.join(PUBLIC_DIR, 'cms-runtime.js'), 'application/javascript; charset=utf-8', req);
    }
    if (req.method === 'GET' && studio && studio.serveMedia(req, res, pathname)) {
      return;
    }

    const pass = process.env.ADMIN_PASSPHRASE;
    if (req.method === 'POST' && pathname === '/admin/login') {
      if (rateLimited('admin_login_sock:' + sock, 10) || rateLimited('admin_login_ip:' + ip, 10)) {
        return send(res, 429, { error: 'slow_down' }, {}, req);
      }
      if (!pass) return send(res, 503, { error: 'admin_not_configured' }, {}, req); // fail closed
      const b = await body(req, 2000);
      if (!safeEq(String(b.passphrase || ''), pass)) {
        audit({ event: 'admin_login_failed', ring: 0 });
        return send(res, 401, { error: 'denied' }, {}, req);
      }
      attempts.delete('admin_login_sock:' + sock);
      attempts.delete('admin_login_ip:' + ip);
      const t = newSession(0);
      audit({ event: 'admin_login', ring: 0 });
      return send(res, 200, { ok: true, sessionTtlDays: Math.round(ADMIN_SESSION_TTL_SEC / 86400) }, { 'set-cookie': `${ADMIN_COOKIE}=${t}; ${cookieAttributes(req, ADMIN_SESSION_TTL_SEC)}` }, req);
    }

    if (req.method === 'POST' && pathname === '/admin/logout') {
      const t = getCookieToken(req, ADMIN_COOKIE);
      if (t) {
        sessions.delete(t);
        revokedAdminTokens.add(t);
      }
      return send(res, 200, { ok: true }, { 'set-cookie': `${ADMIN_COOKIE}=; ${cookieAttributes(req, 0)}` }, req);
    }

    if (!isAuthedAdmin && !(req.method === 'GET' && pathname === '/admin/api/works/gdrive/oauth-callback')) {
      audit({ event: 'admin_unauthorized_attempt', path: pathname });
      return send(res, 401, { error: 'denied' }, {}, req);
    }
    req.__isAuthedAdmin = isAuthedAdmin;

    // Same-origin Visual Website Editor preview routes on the Admin port
    if (req.method === 'GET' && pathname === '/preview-site') {
      const idxPath = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))
        ? path.join(PUBLIC_DIR, 'index.html')
        : path.join(__dirname, 'index.html');
      return sendFile(res, idxPath, 'text/html; charset=utf-8', req);
    }
    if (req.method === 'GET' && pathname === '/i18n/en.json') {
      const p = fs.existsSync(path.join(PUBLIC_DIR, 'i18n', 'en.json')) ? path.join(PUBLIC_DIR, 'i18n', 'en.json') : path.join(__dirname, 'i18n', 'en.json');
      return sendFile(res, p, 'application/json; charset=utf-8', req);
    }
    if (req.method === 'GET' && pathname === '/i18n/id.json') {
      const p = fs.existsSync(path.join(PUBLIC_DIR, 'i18n', 'id.json')) ? path.join(PUBLIC_DIR, 'i18n', 'id.json') : path.join(__dirname, 'i18n', 'id.json');
      return sendFile(res, p, 'application/json; charset=utf-8', req);
    }
    if (req.method === 'GET' && pathname === '/api/session') {
      return send(res, 200, { ring: 3, label: 'public', studioPreview: true }, {}, req);
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
      const list = loadCodenames().map(({ passphraseHash, otpCode, otpHash, ...rest }) => rest);
      return send(res, 200, { codenames: list }, {}, req);
    }

    if (req.method === 'POST' && pathname === '/admin/api/codenames') {
      const b = await body(req, 2000);
      const codeName = String(b.codeName || '').trim();
      const passphrase = String(b.passphrase || '').trim();
      const otpCode = String(b.otpCode || Math.floor(100000 + Math.random() * 900000)).replace(/\s+/g, '');
      if (!codeName || !passphrase || !otpCode) return send(res, 400, { error: 'bad_request' }, {}, req);
      const list = loadCodenames();
      const existing = list.find((c) => c.codeName.toLowerCase() === codeName.toLowerCase());
      if (existing) {
        existing.passphraseHash = hashSecret(passphrase);
        existing.otpHash = hashSecret(otpCode);
        delete existing.otpCode;
        existing.status = 'active';
        saveCodenames(list);
        audit({ event: 'codename_rotated', codeName: existing.codeName });
        return send(res, 200, { ok: true, codeName: existing.codeName, otpCode, status: existing.status, rotated: true }, {}, req);
      }
      const entry = {
        codeName,
        ring: 1,
        passphraseHash: hashSecret(passphrase),
        otpHash: hashSecret(otpCode),
        status: 'active',
        channel: null,
        addedAt: new Date().toISOString().slice(0, 10)
      };
      list.push(entry);
      saveCodenames(list);
      audit({ event: 'codename_created', codeName });
      return send(res, 200, { ok: true, codeName, otpCode, status: 'active' }, {}, req);
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

    const sock = (req.socket && req.socket.remoteAddress) || 'sock';
    const ip = clientIp(req);
    if (rateLimited('user_sock:' + sock, 300) || rateLimited('user:' + ip, 240)) {
      return send(res, 429, { error: 'slow_down' }, {}, req);
    }

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

    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !pathname.startsWith('/api/payments/webhook')) {
      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch (_) {}
        const reqHost = req.headers.host;
        if (originHost && reqHost && originHost !== reqHost) {
          audit({ event: 'user_csrf_blocked', origin, host: reqHost });
          return send(res, 403, { error: 'cross_origin_denied' }, {}, req);
        }
      }
    }

    // Frontend pages, media & localization files
    // Strictly allowlist only the two alternative frontend templates
    const ALT_PAGES = {
      '/alternatif-1': 'versi_alternatif_1_hbs.html',
      '/versi_alternatif_1_hbs.html': 'versi_alternatif_1_hbs.html',
      '/alternatif-2': 'versi_alternatif_2_wharton.html',
      '/versi_alternatif_2_wharton.html': 'versi_alternatif_2_wharton.html'
    };
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(ALT_PAGES, pathname)) {
      const fileName = ALT_PAGES[pathname];
      const p = fs.existsSync(path.join(PUBLIC_DIR, fileName)) ? path.join(PUBLIC_DIR, fileName) : path.join(__dirname, fileName);
      if (fs.existsSync(p)) return sendFile(res, p, 'text/html; charset=utf-8', req);
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/member')) {
      const idxPath = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))
        ? path.join(PUBLIC_DIR, 'index.html')
        : path.join(__dirname, 'index.html');
      return sendFile(res, idxPath, 'text/html; charset=utf-8', req);
    }
    if (req.method === 'GET' && pathname === '/cms-runtime.js') {
      const cmsPath = fs.existsSync(path.join(PUBLIC_DIR, 'cms-runtime.js'))
        ? path.join(PUBLIC_DIR, 'cms-runtime.js')
        : path.join(__dirname, 'cms-runtime.js');
      return sendFile(res, cmsPath, 'application/javascript; charset=utf-8', req);
    }
    if (req.method === 'GET' && studio && studio.serveMedia(req, res, pathname)) {
      return;
    }
    if (req.method === 'GET' && pathname === '/i18n/en.json') {
      const p = fs.existsSync(path.join(PUBLIC_DIR, 'i18n', 'en.json')) ? path.join(PUBLIC_DIR, 'i18n', 'en.json') : path.join(__dirname, 'i18n', 'en.json');
      return sendFile(res, p, 'application/json; charset=utf-8', req);
    }
    if (req.method === 'GET' && pathname === '/i18n/id.json') {
      const p = fs.existsSync(path.join(PUBLIC_DIR, 'i18n', 'id.json')) ? path.join(PUBLIC_DIR, 'i18n', 'id.json') : path.join(__dirname, 'i18n', 'id.json');
      return sendFile(res, p, 'application/json; charset=utf-8', req);
    }
    if (studio && await studio.dispatchPublic(req, res, { url: urlObj, getSess: () => resolveUserSession(req) })) {
      return;
    }

    // Current session info
    if (req.method === 'GET' && pathname === '/api/session') {
      const sess = resolveUserSession(req);
      const guestId = urlObj.searchParams.get('guestId') || getCookieToken(req, USER_COOKIE) || null;
      const gq = guestId ? getOrInitGuestQuota(guestId) : null;
      const chatHistory = (gq && Array.isArray(gq.messages)) ? gq.messages.slice(-40) : [];
      if (sess.ring === 2 && sess.memberId) {
        const member = loadMembers().find((m) => m.id === sess.memberId);
        const isUnlimited = Boolean(member && (member.unlimited || member.leadSubmitted));
        return send(res, 200, {
          ring: 2,
          label: 'member',
          displayName: member ? (member.displayName || 'Raden S. Wiryawan') : 'Raden S. Wiryawan',
          corporateHolding: member ? (member.corporateHolding || 'Group CEO, Bimasakti Holdings') : 'Group CEO, Bimasakti Holdings',
          phone: member ? (member.phone || null) : null,
          unlimited: isUnlimited,
          leadSubmitted: isUnlimited,
          usage: { used: member ? member.used : 0, limit: isUnlimited ? null : (member ? member.cap : DEFAULT_MONTHLY_CAP), unlimited: isUnlimited },
          freeUsage: { used: member ? member.used : 0, limit: null, remaining: null, unlimited: true, leadSubmitted: true, requireLead: false },
          conversations: member ? (member.conversations || []).slice(-10) : [],
          chatHistory
        });
      }
      if (sess.ring === 1 && sess.codeName) {
        return send(res, 200, {
          ring: 1,
          label: 'ring1',
          codeName: sess.codeName,
          channel: sess.channel || null,
          unlimited: true,
          leadSubmitted: true,
          freeUsage: { used: 0, limit: null, remaining: null, unlimited: true, leadSubmitted: true, requireLead: false },
          chatHistory
        });
      }
      const isPublicUnlimited = Boolean(sess.unlimited || (gq && gq.unlimited));
      const publicUsed = gq ? gq.used : 0;
      return send(res, 200, {
        ring: 3,
        label: 'public',
        revoked: Boolean(sess.revoked),
        unlimited: isPublicUnlimited,
        leadSubmitted: Boolean(sess.leadSubmitted || (gq && gq.leadSubmitted)),
        displayName: sess.displayName || (gq && gq.displayName) || null,
        email: sess.email || (gq && gq.email) || null,
        phone: sess.phone || (gq && gq.phone) || null,
        chatHistory,
        freeUsage: {
          used: publicUsed,
          limit: isPublicUnlimited ? null : PUBLIC_FREE_CHAT_LIMIT,
          remaining: isPublicUnlimited ? null : Math.max(0, PUBLIC_FREE_CHAT_LIMIT - publicUsed),
          unlimited: isPublicUnlimited,
          leadSubmitted: Boolean(sess.leadSubmitted || (gq && gq.leadSubmitted)),
          requireLead: !isPublicUnlimited && publicUsed >= PUBLIC_FREE_CHAT_LIMIT
        }
      });
    }

    // Lead capture after 10 free Q&A -> unlocks unlimited free Q&A (Nama, Email, Nomor Telepon Pribadi)
    if (req.method === 'POST' && (pathname === '/api/chat/lead' || pathname === '/api/auth/lead')) {
      const b = await body(req, 4000);
      const lang = langOf(b.lang);
      const displayName = String(b.name || b.displayName || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      const phone = String(b.phone || b.phoneNumber || b.nomorTelepon || b.whatsapp || '').trim();
      const guestId = String(b.guestId || '').trim();

      if (!displayName || displayName.length < 2 || !email || !email.includes('@') || !phone || phone.replace(/\D/g, '').length < 6) {
        return send(res, 400, {
          error: 'bad_request',
          message: lang === 'id'
            ? 'Mohon lengkapi Nama, Email aktif, dan Nomor Telepon pribadi Anda.'
            : 'Please complete your Name, valid Email, and Personal Phone Number.'
        }, {}, req);
      }

      const members = loadMembers();
      let member = members.find((m) => m.email === email);
      const gq = guestId ? getOrInitGuestQuota(guestId) : null;
      const priorUsed = gq ? gq.used : PUBLIC_FREE_CHAT_LIMIT;

      if (member) {
        member.displayName = displayName;
        member.phone = phone;
        if (!member.corporateHolding || member.corporateHolding.startsWith('Telp/WA:')) {
          member.corporateHolding = 'Telp/WA: ' + phone;
        }
        member.unlimited = true;
        member.leadSubmitted = true;
        member.entitlement = 'active';
        member.cap = Math.max(Number(member.cap) || 0, 999999);
        member.updatedAt = new Date().toISOString();
      } else {
        member = {
          id: 'm_' + crypto.randomBytes(5).toString('hex'),
          email,
          displayName,
          phone,
          corporateHolding: 'Telp/WA: ' + phone,
          credentialHash: hashSecret(phone + ':' + email),
          entitlement: 'active',
          unlimited: true,
          leadSubmitted: true,
          leadSource: 'chat_10_gate',
          used: priorUsed,
          cap: 999999,
          conversations: [],
          createdAt: new Date().toISOString()
        };
        members.push(member);
      }
      saveMembers(members);

      const token = newSession(3, {
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        unlimited: true,
        leadSubmitted: true,
        memberId: member.id,
        displayName,
        email,
        phone
      });

      for (const k of [guestId, token].filter(Boolean)) {
        const q = getOrInitGuestQuota(k);
        if (q) {
          q.unlimited = true;
          q.leadSubmitted = true;
          q.displayName = displayName;
          q.email = email;
          q.phone = phone;
          q.memberId = member.id;
        }
      }

      audit({ event: 'chat_lead_submitted', ring: 3, sessionId: member.id, unlimited: true });
      return send(res, 200, {
        ok: true,
        ring: 3,
        unlimited: true,
        leadSubmitted: true,
        displayName,
        email,
        phone,
        freeUsage: {
          used: member.used,
          limit: null,
          remaining: null,
          unlimited: true,
          leadSubmitted: true,
          requireLead: false
        }
      }, { 'set-cookie': `${USER_COOKIE}=${token}; ${cookieAttributes(req, 30 * 24 * 3600)}` }, req);
    }

    // Ring 2 Member sign-up (Free-for-now entitlement flag)
    if (req.method === 'POST' && pathname === '/api/auth/member/signup') {
      const b = await body(req, 4000);
      const email = String(b.email || '').trim().toLowerCase();
      const credential = String(b.credential || b.passkey || '').trim();
      const displayName = String(b.displayName || 'Raden S. Wiryawan').trim();
      const corporateHolding = String(b.corporateHolding || 'Group CEO, Bimasakti Holdings').trim();
      if (!email || !email.includes('@') || !credential) return send(res, 400, { error: 'bad_request' }, {}, req);
      const members = loadMembers();
      const freeActive = FREE_FOR_NOW && (!studio || studio.commerce.isFreeForNow());
      let member = members.find((m) => m.email === email);
      if (member) {
        const v = verifySecret(credential, member.credentialHash);
        if (!v.ok) {
          audit({ event: 'member_signup_conflict', ring: 2 });
          return send(res, 401, { error: 'denied' }, {}, req);
        }
        if (v.legacy) {
          member.credentialHash = hashSecret(credential);
          saveMembers(members);
        }
      }
      if (!member) {
        member = {
          id: 'm_' + crypto.randomBytes(5).toString('hex'),
          email,
          displayName,
          corporateHolding,
          credentialHash: hashSecret(credential),
          entitlement: freeActive ? 'active' : 'pending_payment',
          used: b.startAtZero === false ? 18 : 0,
          cap: DEFAULT_MONTHLY_CAP,
          conversations: [],
          createdAt: new Date().toISOString()
        };
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
      }, { 'set-cookie': `${USER_COOKIE}=${token}; ${cookieAttributes(req, 3600)}` }, req);
    }

    // Ring 2 Member sign-in
    if (req.method === 'POST' && pathname === '/api/auth/member/login') {
      const b = await body(req, 4000);
      const email = String(b.email || '').trim().toLowerCase();
      const credential = String(b.credential || '').trim();
      const members = loadMembers();
      const member = members.find((m) => m.email === email);
      if (!member) {
        audit({ event: 'member_login_failed', ring: 2 });
        return send(res, 401, { error: 'denied' }, {}, req);
      }
      const v = verifySecret(credential, member.credentialHash);
      if (!v.ok) {
        audit({ event: 'member_login_failed', ring: 2 });
        return send(res, 401, { error: 'denied' }, {}, req);
      }
      if (v.legacy) {
        member.credentialHash = hashSecret(credential);
        saveMembers(members);
      }
      const token = newSession(2, { memberId: member.id });
      audit({ event: 'member_login', ring: 2, sessionId: member.id });
      return send(res, 200, {
        ok: true,
        ring: 2,
        displayName: member.displayName || 'Raden S. Wiryawan',
        corporateHolding: member.corporateHolding || 'Group CEO, Bimasakti Holdings',
        usage: { used: member.used, limit: member.cap }
      }, { 'set-cookie': `${USER_COOKIE}=${token}; ${cookieAttributes(req, 3600)}` }, req);
    }

    // Ring 1 Executor 3-factor login (Code Name + Passkey/Device OTP + Rotating Passphrase)
    if (req.method === 'POST' && pathname === '/api/auth/ring1/login') {
      const b = await body(req, 4000);
      const codeName = String(b.codeName || '').trim();
      const otpCode = String(b.otpCode || '').replace(/\s+/g, '');
      const passphrase = String(b.passphrase || '').trim();
      if (!codeName || !otpCode || !passphrase) return send(res, 400, { error: 'bad_request' }, {}, req);

      const targetKey = 'r1_target:' + codeName.toLowerCase();
      if (rateLimited(targetKey, 5, 300000)) {
        audit({ event: 'ring1_login_throttled', ring: 1, codeName });
        return send(res, 429, { error: 'account_locked', reply: REFUSAL[langOf(b.lang)] }, {}, req);
      }

      const list = loadCodenames();
      const entry = list.find((c) => c.codeName.toLowerCase() === codeName.toLowerCase());
      if (!entry || entry.status !== 'active') {
        rateLimited(targetKey, 5, 300000);
        audit({ event: 'ring1_login_failed', ring: 1, codeName });
        return send(res, 401, { error: 'denied' }, {}, req);
      }

      let otpOk = false;
      if (entry.otpHash) {
        otpOk = verifySecret(otpCode, entry.otpHash).ok;
      } else if (entry.otpCode) {
        otpOk = safeEq(String(entry.otpCode).replace(/\s+/g, ''), otpCode);
      }

      const passResult = verifySecret(passphrase, entry.passphraseHash);

      if (!otpOk || !passResult.ok) {
        rateLimited(targetKey, 5, 300000);
        audit({ event: 'ring1_login_failed', ring: 1, codeName: entry.codeName });
        return send(res, 401, { error: 'denied' }, {}, req);
      }

      let upgraded = false;
      if (passResult.legacy) {
        entry.passphraseHash = hashSecret(passphrase);
        upgraded = true;
      }
      if (entry.otpCode || !entry.otpHash) {
        entry.otpHash = hashSecret(otpCode);
        delete entry.otpCode;
        upgraded = true;
      }
      if (upgraded) saveCodenames(list);

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
      }, { 'set-cookie': `${USER_COOKIE}=${token}; ${cookieAttributes(req, 1800)}` }, req);
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
      return send(res, 200, { ok: true }, { 'set-cookie': `${USER_COOKIE}=; ${cookieAttributes(req, 0)}` }, req);
    }

    // Dormant billing webhook (requires PAYMENT_INTERNAL_WEBHOOK_SECRET)
    if (req.method === 'POST' && pathname === '/api/payments/webhook') {
      const secret = process.env.PAYMENT_INTERNAL_WEBHOOK_SECRET;
      const auth = req.headers['x-webhook-secret'] || req.headers['authorization'];
      if (!secret || !auth || !safeEq(String(auth).replace(/^Bearer\s+/i, ''), secret)) {
        audit({ event: 'unauthorized_legacy_webhook_blocked', ring: 2 });
        return send(res, 401, { error: 'unauthorized_webhook' }, {}, req);
      }
      const b = await body(req, 10000);
      const members = loadMembers();
      const member = members.find((m) => m.id === b.memberId || m.email === b.email);
      if (!member) return send(res, 404, { error: 'not_found' }, {}, req);
      member.entitlement = b.status === 'active' ? 'active' : 'lapsed';
      saveMembers(members);
      audit({ event: 'payment_webhook', ring: 2, sessionId: member.id, entitlement: member.entitlement });
      return send(res, 200, { ok: true, entitlement: member.entitlement }, {}, req);
    }

    // Clear active browser session chat history (when user explicitly starts a New Conversation)
    if (req.method === 'POST' && pathname === '/api/chat/clear') {
      const b = await body(req, 4000);
      const guestKey = String(b.guestId || getCookieToken(req, USER_COOKIE) || '').trim();
      if (guestKey) {
        const gq = getOrInitGuestQuota(guestKey);
        if (gq) gq.messages = [];
      }
      return send(res, 200, { ok: true, chatHistory: [] }, {}, req);
    }

    // Chat endpoint
    if (req.method === 'POST' && pathname === '/api/chat') {
      const b = await body(req, 20000);
      const lang = langOf(b.lang);
      const q = String(b.message || '').slice(0, 2000);
      if (!q.trim()) return send(res, 400, { error: 'empty' });
      const guestKey = String(b.guestId || getCookieToken(req, USER_COOKIE) || '').trim();
      const chatSource = b.source === 'chamber' ? 'chamber' : 'frontpage';

      // The ring is decided on the server from the session; any ring sent by the browser is ignored.
      const sess = resolveUserSession(req);
      if (sess.revoked) {
        audit({ event: 'revoked_session_blocked', site: 'user', ring: 3 });
        return send(res, 401, { error: 'session_revoked', reply: REFUSAL[lang] });
      }
      const ring = sess.ring;

      // Enforce Ring 2 monthly fair-use cap (unless unlimited is active)
      let usageInfo;
      let freeUsage;
      if (ring === 2 && sess.memberId) {
        const members = loadMembers();
        const member = members.find((m) => m.id === sess.memberId);
        if (member) {
          const isUnlimited = Boolean(member.unlimited || member.leadSubmitted);
          if (!isUnlimited && member.used >= member.cap) {
            audit({ event: 'chat_cap_reached', site: 'user', ring: 2, sessionId: sess.sessionId, outcome: 'refused_politely' });
            return send(res, 429, { error: 'cap_reached', reply: CAP_REACHED[lang], usage: { used: member.used, limit: member.cap } });
          }
          member.used += 1;
          member.conversations = member.conversations || [];
          member.conversations.push({ title: q.slice(0, 48), at: new Date().toISOString() });
          saveMembers(members);
          usageInfo = { used: member.used, limit: isUnlimited ? null : member.cap, unlimited: isUnlimited };
          freeUsage = { used: member.used, limit: null, remaining: null, unlimited: true, leadSubmitted: true, requireLead: false };
        }
      } else if (ring === 3) {
        if (guestKey) {
          const gq = getOrInitGuestQuota(guestKey);
          const isUnlimited = Boolean(sess.unlimited || (gq && gq.unlimited));
          if (!isUnlimited && gq.used >= PUBLIC_FREE_CHAT_LIMIT) {
            audit({ event: 'public_free_limit_reached', site: 'user', ring: 3, sessionId: sess.sessionId, outcome: 'lead_required' });
            return send(res, 402, {
              error: 'lead_required',
              requireLead: true,
              reply: LEAD_GATE_PROMPT[lang],
              freeUsage: {
                used: gq.used,
                limit: PUBLIC_FREE_CHAT_LIMIT,
                remaining: 0,
                unlimited: false,
                leadSubmitted: false,
                requireLead: true,
                promptLead: true
              }
            }, {}, req);
          }
          gq.used += 1;
          const memId = sess.memberId || gq.memberId;
          if (memId) {
            const members = loadMembers();
            const member = members.find((m) => m.id === memId);
            if (member) {
              member.used = gq.used;
              member.conversations = member.conversations || [];
              member.conversations.push({ title: q.slice(0, 48), at: new Date().toISOString() });
              saveMembers(members);
            }
          }
          freeUsage = {
            used: gq.used,
            limit: isUnlimited ? null : PUBLIC_FREE_CHAT_LIMIT,
            remaining: isUnlimited ? null : Math.max(0, PUBLIC_FREE_CHAT_LIMIT - gq.used),
            unlimited: isUnlimited,
            leadSubmitted: Boolean(sess.leadSubmitted || gq.leadSubmitted),
            requireLead: !isUnlimited && gq.used >= PUBLIC_FREE_CHAT_LIMIT,
            promptLead: !isUnlimited && gq.used >= PUBLIC_FREE_CHAT_LIMIT
          };
        }
      }

      const r = await answer(ring, q, lang);
      if (guestKey) {
        const gq = getOrInitGuestQuota(guestKey);
        if (gq) {
          if (!Array.isArray(gq.messages)) gq.messages = [];
          const nowIso = new Date().toISOString();
          gq.messages.push({ role: 'user', text: q, source: chatSource, at: nowIso });
          gq.messages.push({ role: 'twin', text: r.text, source: chatSource, at: nowIso });
          if (gq.messages.length > 40) {
            gq.messages = gq.messages.slice(-40);
          }
        }
      }
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
        refused: Boolean(r.refused),
        outcome: r.outcome || (r.refused ? 'refused_politely' : 'answered'),
        topic: r.topic || null,
        disclosure: DISCLOSURE[lang],
        ring: sess.label,
        usage: usageInfo,
        ...(freeUsage ? { freeUsage, promptLead: Boolean(freeUsage.promptLead) } : {})
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

function ensurePublicBookKnowledge() {
  const store = loadStore(3);
  let changed = false;
  for (const s of PUBLIC_BOOK_RING3_DOCS) {
    if (!store.some((d) => d.id === s.id)) {
      store.push({ id: s.id, title: s.title, text: s.text, lang: s.lang, ring: 3, approvedAt: new Date().toISOString() });
      changed = true;
    }
  }
  if (changed) saveStore(3, store);
}

function start() {
  ensureStores();
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
  ensurePublicBookKnowledge();
  if (!userServer.listening) {
    userServer.listen(USER_PORT, () => console.log('user site on', USER_PORT));
  }
  if (ADMIN_PORT && ADMIN_PORT !== USER_PORT && !adminServer.listening) {
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
