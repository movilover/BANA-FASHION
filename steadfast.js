'use strict';
/**
 * Steadfast কুরিয়ার
 *   POST /api/sf          অ্যাডমিন প্যানেল → Steadfast API প্রক্সি (API Key/Secret সার্ভারেই থাকে, শুধু অ্যাডমিন ব্যবহার করতে পারে)
 *   POST /api/sf-webhook  Steadfast → আপনার সাইট (Bearer Token দিয়ে সুরক্ষিত) — প্যানেল বন্ধ থাকলেও স্ট্যাটাস আপডেট হয়
 *
 * API Key, Secret, Webhook Token থাকে Firestore  private/courier  এ।
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, requireAdmin } = require('../lib/firebase');

const router = express.Router();
const BASE = 'https://portal.packzy.com/api/v1/';
const lim = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'অনেক বেশি রিকোয়েস্ট' } });

let _cache = null;
async function courierCfg() {
  if (_cache && Date.now() - _cache.t < 30_000) return _cache.v;
  const s = await db.doc('private/courier').get();
  _cache = { t: Date.now(), v: s.exists ? s.data() : {} };
  return _cache.v;
}

const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/* ---------------- অ্যাডমিন প্রক্সি (শুধু অনুমোদিত ৩টি কল) ---------------- */
router.post('/api/sf', lim(60_000, 90), requireAdmin, express.json({ limit: '50kb' }), async (req, res) => {
  try {
    const { path = '', method = 'GET', body } = req.body || {};
    const m = String(method).toUpperCase(), p = String(path);
    let payload;

    if (m === 'GET' && p === 'get_balance') { /* ok */ }
    else if (m === 'GET' && /^status_by_cid\/\d{1,20}$/.test(p)) { /* ok */ }
    else if (m === 'POST' && p === 'create_order') {
      const b = body || {};
      const s = (v, n) => String(v == null ? '' : v).slice(0, n);
      payload = {
        invoice: s(b.invoice, 40), recipient_name: s(b.recipient_name, 100),
        recipient_phone: s(b.recipient_phone, 20), recipient_address: s(b.recipient_address, 250),
        cod_amount: Math.max(0, Math.round(Number(b.cod_amount) || 0)), note: s(b.note, 300)
      };
      if (!payload.invoice || !payload.recipient_name || !/^\d{11}$/.test(payload.recipient_phone) || !payload.recipient_address)
        return res.status(400).json({ error: 'অর্ডারের তথ্য অসম্পূর্ণ' });
    } else return res.status(400).json({ error: 'এই কলের অনুমতি নেই' });

    const c = await courierCfg();
    if (!c.key || !c.secret) return res.status(400).json({ error: 'Steadfast API Key/Secret সেভ করা নেই' });

    const r = await fetch(BASE + p, {
      method: m,
      headers: { 'Api-Key': c.key, 'Secret-Key': c.secret, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(20_000)
    });
    const j = await r.json().catch(() => null);
    if (!j) return res.status(502).json({ error: 'Steadfast থেকে ভুল রেসপন্স (HTTP ' + r.status + ')' });
    res.status(r.ok ? 200 : r.status).json(j);
  } catch (e) {
    console.error('[sf]', e.message);
    res.status(502).json({ error: 'Steadfast-এর সাথে যোগাযোগ করা যায়নি' });
  }
});

/* ---------------- Steadfast Webhook ---------------- */
const SFM = { pending: 'confirmed', in_review: 'confirmed', hold: 'shipped', delivered: 'delivered', partial_delivered: 'delivered', cancelled: 'returned', delivered_approval_pending: 'shipped', partial_delivered_approval_pending: 'shipped', cancelled_approval_pending: 'shipped', unknown_approval_pending: 'shipped' };
const RK = { pending: 0, confirmed: 1, shipped: 2, delivered: 3, returned: 3, cancelled: 3 };

router.post('/api/sf-webhook', lim(60_000, 120), express.json({ limit: '100kb' }), async (req, res) => {
  try {
    const c = await courierCfg();
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!c.webhookToken || c.webhookToken.length < 16 || !tok || !safeEq(tok, c.webhookToken))
      return res.status(401).json({ status: 'error', message: 'Unauthorized' });

    const b = req.body || {};
    const type = String(b.notification_type || '');
    const cid = Number(b.consignment_id), invoice = String(b.invoice || '');

    /* অর্ডার খোঁজা: consignment id দিয়ে, না পেলে invoice (= orderId) দিয়ে */
    let snap = null;
    if (Number.isFinite(cid) && cid > 0) { const q = await db.collection('orders').where('courier.cid', '==', cid).limit(1).get(); if (!q.empty) snap = q.docs[0]; }
    if (!snap && /^BF-[A-Z0-9]{4,20}$/.test(invoice)) { const q = await db.collection('orders').where('orderId', '==', invoice).limit(1).get(); if (!q.empty) snap = q.docs[0]; }
    if (!snap) return res.json({ status: 'success', message: 'Webhook received successfully.' });   // অর্ডার নেই — Steadfast যেন বারবার না পাঠায়

    const o = snap.data(), upd = {}, rec = {};
    if (type === 'delivery_status') {
      const st = String(b.status || '').slice(0, 60);
      if (st) {
        upd['courier.live'] = st; upd['courier.syncedAt'] = Date.now(); rec.live = st;
        const ns = SFM[st];
        if (ns && RK[ns] > (RK[o.status] ?? 0)) { upd.status = ns; rec.status = ns; }
      }
    } else if (type === 'tracking_update') {
      upd['courier.lastMsg'] = String(b.tracking_message || '').slice(0, 300);
      upd['courier.syncedAt'] = Date.now();
    }
    if (Object.keys(upd).length) await snap.ref.update(upd);
    if (Object.keys(rec).length && o.orderId) await db.collection('receipts').doc(o.orderId).set(rec, { merge: true });

    res.json({ status: 'success', message: 'Webhook received successfully.' });
  } catch (e) {
    console.error('[sf-webhook]', e.message);
    res.status(500).json({ status: 'error', message: 'server error' });
  }
});

module.exports = router;
