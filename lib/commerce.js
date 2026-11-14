'use strict';
// Ring 0 Studio — Payment gateways (Midtrans, Xendit, Stripe, manual transfer), pricing plans, coupons, orders.
// Gateway secrets are sealed in the vault; webhooks are verified per provider and fail closed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./sanitize');

const SECRET_FIELDS = { midtrans: ['serverKey'], xendit: ['secretKey', 'callbackToken'], stripe: ['secretKey', 'webhookSecret'], manual: [] };
const PUBLIC_FIELDS = { midtrans: ['merchantId', 'clientKey'], xendit: ['publicKey'], stripe: ['publishableKey'], manual: ['bankName', 'accountNo', 'accountName', 'instructions'] };
const ZERO_DECIMAL_STRIPE = ['jpy', 'krw', 'vnd', 'clp', 'pyg', 'ugx', 'xaf', 'xof'];

module.exports = function createCommerce(ctx) {
  const { DATA, readJson, writeJson, audit, send, body, vault, loadMembers, saveMembers, FREE_FOR_NOW, DEFAULT_MONTHLY_CAP } = ctx;
  const file = () => path.join(DATA, 'commerce.json');
  const txFile = () => path.join(DATA, 'transactions.json');

  function ensure() {
    if (!fs.existsSync(file())) {
      writeJson(file(), {
        currency: 'IDR', taxPercent: 0, freeForNow: FREE_FOR_NOW, checkoutRequiresMember: true,
        successUrl: '/?pembayaran=berhasil',
        gateways: {
          midtrans: { enabled: false, mode: 'sandbox', merchantId: '', clientKey: '', serverKey: null },
          xendit: { enabled: false, mode: 'test', publicKey: '', secretKey: null, callbackToken: null },
          stripe: { enabled: false, mode: 'test', publishableKey: '', secretKey: null, webhookSecret: null },
          manual: { enabled: true, mode: 'live', bankName: 'BCA', accountNo: '', accountName: '', instructions: 'Transfer sesuai nominal, lalu kirim bukti transfer. Keanggotaan diaktifkan setelah dana kami terima.' }
        },
        plans: [
          { id: 'plan_open', name: 'Ruang Diskusi Terbuka', tagline: 'Untuk siapa saja yang ingin mulai berbincang.', ring: 3, priceMonthly: 0, priceYearly: 0, messageCap: 0,
            features: ['Tanya-jawab dari karya yang sudah terbit', 'Tanpa perlu mendaftar'], highlight: false, active: true, purchasable: false, order: 0, ctaLabel: 'Mulai Berbincang' },
          { id: 'plan_member', name: 'Keanggotaan Eksekutif', tagline: 'Pendampingan strategis yang lebih dalam dan personal.', ring: 2, priceMonthly: 750000, priceYearly: 7500000, messageCap: 50,
            features: ['Materi khusus anggota (Orbex Framework)', '50 sesi diskusi per bulan', 'Riwayat percakapan tersimpan'], highlight: true, active: true, purchasable: true, order: 1, ctaLabel: 'Bergabung Sekarang' },
          { id: 'plan_member_plus', name: 'Eksekutif Plus', tagline: 'Untuk pemimpin yang berdiskusi hampir setiap hari.', ring: 2, priceMonthly: 1500000, priceYearly: 15000000, messageCap: 150,
            features: ['Semua manfaat Keanggotaan Eksekutif', '150 sesi diskusi per bulan', 'Prioritas sesi refleksi'], highlight: false, active: true, purchasable: true, order: 2, ctaLabel: 'Pilih Plus' },
          { id: 'plan_invite', name: 'Lingkaran Sahabat Dekat', tagline: 'Hanya melalui undangan pribadi Pak Andrew.', ring: 1, priceMonthly: 0, priceYearly: 0, messageCap: 0,
            features: ['Akses dengan kode undangan', 'Pendampingan pribadi'], highlight: false, active: true, purchasable: false, order: 3, ctaLabel: 'Masuk dengan Undangan' }
        ],
        coupons: [{ code: 'SAHABAT10', percentOff: 10, amountOff: 0, expiresAt: null, maxRedemptions: 100, redeemed: 0, active: true }],
        updatedAt: new Date().toISOString()
      });
    }
    if (!fs.existsSync(txFile())) writeJson(txFile(), []);
  }
  const load = () => { ensure(); return readJson(file()); };
  const save = (v) => { v.updatedAt = new Date().toISOString(); writeJson(file(), v); };
  const loadTx = () => { ensure(); return readJson(txFile()); };
  const saveTx = (v) => writeJson(txFile(), v);

  const isFreeForNow = () => Boolean(load().freeForNow);
  function capForPlan(planId) {
    const p = load().plans.find((x) => x.id === planId);
    return p && p.messageCap > 0 ? p.messageCap : DEFAULT_MONTHLY_CAP;
  }

  function maskedGateways(c) {
    const out = {};
    for (const [prov, g] of Object.entries(c.gateways)) {
      const o = { enabled: g.enabled, mode: g.mode };
      for (const f of PUBLIC_FIELDS[prov]) o[f] = g[f] || '';
      for (const f of SECRET_FIELDS[prov]) o[f] = g[f] ? { set: true, hint: vault.hint(g[f]) } : { set: false, hint: '' };
      out[prov] = o;
    }
    return out;
  }

  const secretOf = (c, prov, f) => vault.open(c.gateways[prov][f]);
  const basic = (k) => 'Basic ' + Buffer.from(k + ':').toString('base64');
  const hosts = (c) => ({
    midtransApi: c.gateways.midtrans.mode === 'production' ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com',
    midtransSnap: c.gateways.midtrans.mode === 'production' ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com'
  });

  async function timedFetch(url, opts = {}, ms = 15000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
  }

  function sanitizePlan(p, i) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    return {
      id: /^plan_[a-z0-9_]{2,40}$/.test(p.id) ? p.id : 'plan_' + crypto.randomBytes(4).toString('hex'),
      name: S.plain(p.name, 80) || 'Paket Baru',
      tagline: S.plain(p.tagline, 200),
      ring: [1, 2, 3].includes(Number(p.ring)) ? Number(p.ring) : 2,
      priceMonthly: n(p.priceMonthly), priceYearly: n(p.priceYearly), messageCap: n(p.messageCap),
      features: (Array.isArray(p.features) ? p.features : String(p.features || '').split('\n')).map((f) => S.plain(f, 160)).filter(Boolean).slice(0, 12),
      highlight: Boolean(p.highlight), active: p.active !== false, purchasable: Boolean(p.purchasable) && Number(p.ring) === 2,
      order: Number.isFinite(Number(p.order)) ? Number(p.order) : i,
      ctaLabel: S.plain(p.ctaLabel, 40) || 'Pilih Paket',
      badge: S.plain(p.badge, 30)
    };
  }

  function priceQuote(c, plan, cycle, couponCode) {
    const base = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
    let discount = 0, coupon = null;
    if (couponCode) {
      const cp = c.coupons.find((x) => x.code.toUpperCase() === String(couponCode).toUpperCase().trim());
      const valid = cp && cp.active && (!cp.expiresAt || Date.parse(cp.expiresAt) > Date.now()) && (!cp.maxRedemptions || cp.redeemed < cp.maxRedemptions);
      if (valid) { coupon = cp.code; discount = Math.min(base, Math.round(base * (cp.percentOff || 0) / 100) + (cp.amountOff || 0)); }
      else return { error: 'coupon_invalid' };
    }
    const sub = base - discount;
    const tax = Math.round(sub * (Number(c.taxPercent) || 0) / 100);
    return { base, discount, tax, total: sub + tax, coupon, currency: c.currency };
  }

  function activateOrder(tx) {
    const c = load();
    const plan = c.plans.find((p) => p.id === tx.planId);
    const members = loadMembers();
    const m = members.find((x) => x.id === tx.memberId || (tx.email && x.email === tx.email));
    if (m) {
      m.entitlement = 'active';
      m.planId = tx.planId;
      m.cap = plan && plan.messageCap > 0 ? plan.messageCap : DEFAULT_MONTHLY_CAP;
      m.renewsAt = new Date(Date.now() + (tx.cycle === 'yearly' ? 365 : 30) * 86400000).toISOString();
      saveMembers(members);
    }
    if (tx.coupon) { const cp = c.coupons.find((x) => x.code === tx.coupon); if (cp) { cp.redeemed = (cp.redeemed || 0) + 1; save(c); } }
    audit({ event: 'payment_activated', ring: 2, orderId: tx.id, gateway: tx.gateway, memberFound: Boolean(m) });
  }

  function updateTx(orderId, status, providerRef) {
    const list = loadTx();
    const tx = list.find((t) => t.id === orderId);
    if (!tx) return null;
    const wasPaid = tx.status === 'paid';
    tx.status = status;
    if (providerRef) tx.providerRef = providerRef;
    tx.updatedAt = new Date().toISOString();
    if (status === 'paid' && !wasPaid) { tx.paidAt = tx.updatedAt; saveTx(list); activateOrder(tx); }
    else saveTx(list); // idempotent: a repeated "paid" webhook never re-activates
    return tx;
  }

  function rawBody(req, limit = 200000) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('error', reject);
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  // ---------- admin routes ----------
  const admin = {
    'GET /admin/api/commerce': (req, res) => {
      const c = load();
      return send(res, 200, { ...c, gateways: maskedGateways(c), webhookPaths: { midtrans: '/api/payments/webhook/midtrans', xendit: '/api/payments/webhook/xendit', stripe: '/api/payments/webhook/stripe' } });
    },

    'POST /admin/api/commerce/settings': async (req, res) => {
      const b = await body(req, 8000);
      const c = load();
      if (b.currency && /^[A-Z]{3}$/.test(b.currency)) c.currency = b.currency;
      if (b.taxPercent !== undefined) c.taxPercent = Math.min(50, Math.max(0, Number(b.taxPercent) || 0));
      if (b.freeForNow !== undefined) c.freeForNow = Boolean(b.freeForNow);
      if (b.checkoutRequiresMember !== undefined) c.checkoutRequiresMember = Boolean(b.checkoutRequiresMember);
      if (b.successUrl !== undefined) c.successUrl = S.safeUrl(b.successUrl) || '/';
      save(c);
      audit({ event: 'commerce_settings_updated', ring: 0, freeForNow: c.freeForNow });
      return send(res, 200, { ok: true });
    },

    'POST /admin/api/commerce/gateway': async (req, res) => {
      const b = await body(req, 20000);
      const prov = String(b.provider || '');
      if (!SECRET_FIELDS[prov]) return send(res, 400, { error: 'bad_provider' });
      const c = load();
      const g = c.gateways[prov];
      if (b.enabled !== undefined) g.enabled = Boolean(b.enabled);
      if (b.mode) g.mode = ['sandbox', 'test', 'production', 'live'].includes(b.mode) ? b.mode : g.mode;
      const fields = b.fields || {};
      for (const f of PUBLIC_FIELDS[prov]) if (fields[f] !== undefined) g[f] = S.plain(fields[f], f === 'instructions' ? 1200 : 200);
      for (const f of SECRET_FIELDS[prov]) {
        const v = fields[f];
        if (typeof v === 'string' && v.trim() && !v.includes('••••')) g[f] = vault.seal(v.trim());
      }
      for (const f of Array.isArray(b.clear) ? b.clear : []) if (SECRET_FIELDS[prov].includes(f)) g[f] = null;
      save(c);
      audit({ event: 'gateway_updated', ring: 0, provider: prov, enabled: g.enabled, mode: g.mode });
      return send(res, 200, { ok: true, gateway: maskedGateways(c)[prov] });
    },

    'POST /admin/api/commerce/gateway/test': async (req, res) => {
      const b = await body(req, 2000);
      const prov = String(b.provider || '');
      const c = load();
      const started = Date.now();
      try {
        let ok = false, detail = '';
        if (prov === 'midtrans') {
          const k = secretOf(c, 'midtrans', 'serverKey'); if (!k) return send(res, 400, { error: 'missing_secret' });
          const r = await timedFetch(hosts(c).midtransApi + '/v2/icoach-ping-' + Date.now() + '/status', { headers: { authorization: basic(k), accept: 'application/json' } });
          const j = await r.json().catch(() => ({}));
          ok = r.ok && String(j.status_code) !== '401'; detail = j.status_message || 'HTTP ' + r.status;
        } else if (prov === 'xendit') {
          const k = secretOf(c, 'xendit', 'secretKey'); if (!k) return send(res, 400, { error: 'missing_secret' });
          const r = await timedFetch('https://api.xendit.co/balance', { headers: { authorization: basic(k) } });
          const j = await r.json().catch(() => ({}));
          ok = r.ok; detail = ok ? 'Saldo terbaca' : (j.message || 'HTTP ' + r.status);
        } else if (prov === 'stripe') {
          const k = secretOf(c, 'stripe', 'secretKey'); if (!k) return send(res, 400, { error: 'missing_secret' });
          const r = await timedFetch('https://api.stripe.com/v1/balance', { headers: { authorization: 'Bearer ' + k } });
          const j = await r.json().catch(() => ({}));
          ok = r.ok; detail = ok ? 'Akun Stripe terhubung (' + (j.livemode ? 'live' : 'test') + ')' : ((j.error && j.error.message) || 'HTTP ' + r.status);
        } else if (prov === 'manual') {
          const g = c.gateways.manual; ok = Boolean(g.accountNo && g.accountName); detail = ok ? 'Rekening lengkap' : 'Nomor & nama rekening belum diisi';
        } else return send(res, 400, { error: 'bad_provider' });
        audit({ event: 'gateway_tested', ring: 0, provider: prov, ok });
        return send(res, 200, { ok, detail, latencyMs: Date.now() - started });
      } catch (e) {
        return send(res, 200, { ok: false, detail: e.name === 'AbortError' ? 'timeout' : String(e.message), latencyMs: Date.now() - started });
      }
    },

    'POST /admin/api/commerce/plans': async (req, res) => {
      const b = await body(req, 100000);
      if (!Array.isArray(b.plans)) return send(res, 400, { error: 'bad_request' });
      const c = load();
      c.plans = b.plans.slice(0, 20).map(sanitizePlan).sort((a, x) => a.order - x.order);
      save(c);
      audit({ event: 'pricing_updated', ring: 0, plans: c.plans.length });
      return send(res, 200, { ok: true, plans: c.plans });
    },

    'POST /admin/api/commerce/coupons': async (req, res) => {
      const b = await body(req, 60000);
      if (!Array.isArray(b.coupons)) return send(res, 400, { error: 'bad_request' });
      const c = load();
      c.coupons = b.coupons.slice(0, 100).map((x) => ({
        code: String(x.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30),
        percentOff: Math.min(100, Math.max(0, Number(x.percentOff) || 0)),
        amountOff: Math.max(0, Math.round(Number(x.amountOff) || 0)),
        expiresAt: x.expiresAt && !Number.isNaN(Date.parse(x.expiresAt)) ? new Date(x.expiresAt).toISOString() : null,
        maxRedemptions: Math.max(0, Math.round(Number(x.maxRedemptions) || 0)),
        redeemed: Math.max(0, Math.round(Number(x.redeemed) || 0)),
        active: x.active !== false
      })).filter((x) => x.code);
      save(c);
      audit({ event: 'coupons_updated', ring: 0, count: c.coupons.length });
      return send(res, 200, { ok: true, coupons: c.coupons });
    },

    'GET /admin/api/commerce/transactions': (req, res) => {
      const list = loadTx().slice().reverse();
      const paid = list.filter((t) => t.status === 'paid');
      const m = new Date().toISOString().slice(0, 7);
      return send(res, 200, {
        transactions: list.slice(0, 300),
        totals: { count: list.length, paid: paid.length, pending: list.filter((t) => t.status === 'pending').length, revenue: paid.reduce((s, t) => s + t.amount, 0), revenueMonth: paid.filter((t) => (t.paidAt || '').startsWith(m)).reduce((s, t) => s + t.amount, 0) }
      });
    },

    'POST /admin/api/commerce/transactions/mark': async (req, res) => {
      const b = await body(req, 2000);
      if (!['paid', 'failed', 'expired', 'refunded', 'pending'].includes(b.status)) return send(res, 400, { error: 'bad_request' });
      const tx = updateTx(b.id, b.status, 'manual:ring0');
      if (!tx) return send(res, 404, { error: 'not_found' });
      audit({ event: 'transaction_marked', ring: 0, orderId: tx.id, status: b.status });
      return send(res, 200, { ok: true, transaction: tx });
    }
  };

  // ---------- public routes ----------
  const pub = {
    'GET /api/pricing': (req, res) => {
      const c = load();
      const gateways = Object.entries(c.gateways).filter(([, g]) => g.enabled).map(([p, g]) => ({
        provider: p, mode: g.mode,
        ...(p === 'midtrans' ? { clientKey: g.clientKey } : {}),
        ...(p === 'stripe' ? { publishableKey: g.publishableKey } : {}),
        ...(p === 'manual' ? { bankName: g.bankName, accountNo: g.accountNo, accountName: g.accountName, instructions: g.instructions } : {})
      }));
      return send(res, 200, { currency: c.currency, taxPercent: c.taxPercent, freeForNow: c.freeForNow, plans: c.plans.filter((p) => p.active), gateways });
    },

    'POST /api/coupon/check': async (req, res) => {
      const b = await body(req, 2000);
      const c = load();
      const plan = c.plans.find((p) => p.id === b.planId && p.active);
      if (!plan) return send(res, 404, { error: 'plan_not_found' });
      const q = priceQuote(c, plan, b.cycle, b.coupon);
      return send(res, q.error ? 400 : 200, q);
    },

    'POST /api/checkout': async (req, res, { sess }) => {
      const b = await body(req, 4000);
      const c = load();
      const plan = c.plans.find((p) => p.id === b.planId && p.active && p.purchasable);
      if (!plan) return send(res, 404, { error: 'plan_not_found' });
      const members = loadMembers();
      const member = sess.memberId ? members.find((m) => m.id === sess.memberId) : null;
      if (c.checkoutRequiresMember && !member) return send(res, 401, { error: 'member_required' });
      const prov = String(b.gateway || '');
      const g = c.gateways[prov];
      if (!g || !g.enabled) return send(res, 400, { error: 'gateway_unavailable' });
      const cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';
      const q = priceQuote(c, plan, cycle, b.coupon);
      if (q.error) return send(res, 400, q);
      if (q.total <= 0) return send(res, 400, { error: 'nothing_to_pay' });
      const orderId = 'ICA-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const email = member ? member.email : S.plain(b.email, 160);
      const origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'localhost');
      const successUrl = /^https?:/.test(c.successUrl) ? c.successUrl : origin + c.successUrl;
      const tx = { id: orderId, memberId: member ? member.id : null, email, planId: plan.id, planName: plan.name, cycle, amount: q.total, currency: c.currency, discount: q.discount, tax: q.tax, coupon: q.coupon, gateway: prov, mode: g.mode, status: 'pending', createdAt: new Date().toISOString() };
      const out = { orderId, amount: q.total, currency: c.currency, gateway: prov };
      try {
        if (prov === 'midtrans') {
          const r = await timedFetch(hosts(c).midtransSnap + '/snap/v1/transactions', {
            method: 'POST', headers: { authorization: basic(secretOf(c, 'midtrans', 'serverKey')), 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ transaction_details: { order_id: orderId, gross_amount: q.total }, item_details: [{ id: plan.id, price: q.total, quantity: 1, name: (plan.name + ' (' + cycle + ')').slice(0, 50) }], customer_details: { email }, callbacks: { finish: successUrl } })
          });
          const j = await r.json(); if (!r.ok) throw new Error((j.error_messages || []).join('; ') || 'midtrans_' + r.status);
          tx.providerRef = j.token; out.snapToken = j.token; out.redirectUrl = j.redirect_url;
        } else if (prov === 'xendit') {
          const r = await timedFetch('https://api.xendit.co/v2/invoices', {
            method: 'POST', headers: { authorization: basic(secretOf(c, 'xendit', 'secretKey')), 'content-type': 'application/json' },
            body: JSON.stringify({ external_id: orderId, amount: q.total, payer_email: email || undefined, description: plan.name + ' (' + cycle + ')', currency: c.currency, success_redirect_url: successUrl })
          });
          const j = await r.json(); if (!r.ok) throw new Error(j.message || 'xendit_' + r.status);
          tx.providerRef = j.id; out.redirectUrl = j.invoice_url;
        } else if (prov === 'stripe') {
          const cur = c.currency.toLowerCase();
          const unit = ZERO_DECIMAL_STRIPE.includes(cur) ? q.total : q.total * 100;
          const form = new URLSearchParams({ mode: 'payment', success_url: successUrl, cancel_url: origin + '/', client_reference_id: orderId, 'metadata[orderId]': orderId,
            'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': cur, 'line_items[0][price_data][unit_amount]': String(unit), 'line_items[0][price_data][product_data][name]': plan.name + ' (' + cycle + ')' });
          if (email) form.set('customer_email', email);
          const r = await timedFetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { authorization: 'Bearer ' + secretOf(c, 'stripe', 'secretKey'), 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
          const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'stripe_' + r.status);
          tx.providerRef = j.id; out.redirectUrl = j.url;
        } else if (prov === 'manual') {
          out.instructions = { bankName: g.bankName, accountNo: g.accountNo, accountName: g.accountName, note: g.instructions, reference: orderId };
        }
      } catch (e) {
        audit({ event: 'checkout_failed', ring: 2, gateway: prov, msg: String(e.message).slice(0, 120) });
        return send(res, 502, { error: 'gateway_error', detail: String(e.message).slice(0, 200) });
      }
      const list = loadTx(); list.push(tx); saveTx(list);
      audit({ event: 'checkout_created', ring: 2, orderId, gateway: prov, amount: q.total });
      return send(res, 200, out);
    },

    'POST /api/payments/webhook/midtrans': async (req, res) => {
      const raw = await rawBody(req);
      const c = load();
      const key = secretOf(c, 'midtrans', 'serverKey');
      if (!key) return send(res, 503, { error: 'not_configured' });
      let j;
      try { j = JSON.parse(raw || '{}'); } catch (_) { return send(res, 400, { error: 'bad_json' }); }
      const expected = crypto.createHash('sha512').update(String(j.order_id) + String(j.status_code) + String(j.gross_amount) + key).digest('hex');
      if (!j.signature_key || expected.length !== String(j.signature_key).length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(j.signature_key)))) {
        audit({ event: 'webhook_rejected', ring: 0, provider: 'midtrans' });
        return send(res, 401, { error: 'bad_signature' });
      }
      const st = j.transaction_status;
      const status = (st === 'settlement' || (st === 'capture' && j.fraud_status !== 'deny')) ? 'paid' : st === 'pending' ? 'pending' : st === 'expire' ? 'expired' : 'failed';
      const tx = updateTx(j.order_id, status, j.transaction_id);
      return send(res, 200, { ok: true, found: Boolean(tx) });
    },

    'POST /api/payments/webhook/xendit': async (req, res) => {
      const raw = await rawBody(req);
      const c = load();
      const token = secretOf(c, 'xendit', 'callbackToken');
      const got = String(req.headers['x-callback-token'] || '');
      if (!token) return send(res, 503, { error: 'not_configured' });
      if (got.length !== token.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token))) {
        audit({ event: 'webhook_rejected', ring: 0, provider: 'xendit' });
        return send(res, 401, { error: 'bad_token' });
      }
      let j;
      try { j = JSON.parse(raw || '{}'); } catch (_) { return send(res, 400, { error: 'bad_json' }); }
      const status = ['PAID', 'SETTLED'].includes(j.status) ? 'paid' : j.status === 'EXPIRED' ? 'expired' : 'pending';
      const tx = updateTx(j.external_id, status, j.id);
      return send(res, 200, { ok: true, found: Boolean(tx) });
    },

    'POST /api/payments/webhook/stripe': async (req, res) => {
      const raw = await rawBody(req);
      const c = load();
      const secret = secretOf(c, 'stripe', 'webhookSecret');
      if (!secret) return send(res, 503, { error: 'not_configured' });
      const sig = String(req.headers['stripe-signature'] || '');
      const t = (/t=(\d+)/.exec(sig) || [])[1];
      const v1s = [...sig.matchAll(/v1=([a-f0-9]+)/g)].map((m) => m[1]);
      const expected = t ? crypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex') : '';
      const ok = t && Math.abs(Date.now() / 1000 - Number(t)) < 600 && v1s.some((v) => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
      if (!ok) { audit({ event: 'webhook_rejected', ring: 0, provider: 'stripe' }); return send(res, 401, { error: 'bad_signature' }); }
      let ev;
      try { ev = JSON.parse(raw || '{}'); } catch (_) { return send(res, 400, { error: 'bad_json' }); }
      const obj = (ev.data && ev.data.object) || {};
      const orderId = obj.client_reference_id || (obj.metadata && obj.metadata.orderId);
      let tx = null;
      if (ev.type === 'checkout.session.completed' && obj.payment_status === 'paid') tx = updateTx(orderId, 'paid', obj.id);
      else if (ev.type === 'checkout.session.expired') tx = updateTx(orderId, 'expired', obj.id);
      return send(res, 200, { ok: true, found: Boolean(tx) });
    }
  };

  function summary() {
    const c = load();
    const tx = loadTx();
    const paid = tx.filter((t) => t.status === 'paid');
    return {
      freeForNow: c.freeForNow, currency: c.currency,
      gatewaysEnabled: Object.entries(c.gateways).filter(([, g]) => g.enabled).map(([p]) => p),
      plansActive: c.plans.filter((p) => p.active).length,
      revenue: paid.reduce((s, t) => s + t.amount, 0), pending: tx.filter((t) => t.status === 'pending').length
    };
  }

  return { ensure, admin, pub, isFreeForNow, capForPlan, summary };
};
