'use strict';
/* Steadfast কুরিয়ার: /api/sf (অ্যাডমিন প্রক্সি) + /api/sf-webhook (Steadfast থেকে স্ট্যাটাস আপডেট) */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, cfg, Timestamp } = require('./firebase');
const { requireAdmin } = require('./auth');

const router = express.Router();
const BASE = 'https://portal.packzy.com/api/v1/';
const lim = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: 'অনেক বেশি অনুরোধ — একটু পরে চেষ্টা করুন', code: 'rate_limited' } });

/* অ্যাডমিন শুধু এই পথগুলোতেই যেতে পারবে */
const PATH_OK = /^(?:get_balance|create_order|create_order\/bulk-order|status_by_cid\/\d{1,15}|status_by_invoice\/[A-Za-z0-9_-]{1,40}|status_by_trackingcode\/[A-Za-z0-9_-]{1,40}|return_requests|payments|police_stations)$/;
const inflight = new Map();   // একই invoice-এর বুকিং দুবার একসাথে গেলে আটকায়

router.post('/sf', lim(60 * 1000, 120), requireAdmin, express.json({ limit: '200kb' }), async (req, res) => {
  const { path, method, body } = req.body || {};
  const m = String(method || 'GET').toUpperCase();
  if (!PATH_OK.test(String(path || '')) || !['GET', 'POST'].includes(m)) return res.status(400).json({ error: 'এই API পথ অনুমোদিত নয়' });
  let lockKey = null;
  try {
    const c = await cfg('private/courier', 0);
    if (!c.key || !c.secret) return res.status(400).json({ error: 'Steadfast API Key/Secret সেভ করা নেই' });
    if (path === 'create_order' && body && body.invoice) {
      lockKey = String(body.invoice);
      if (inflight.has(lockKey)) return res.status(409).json({ error: 'এই অর্ডারের বুকিং চলছে — একটু অপেক্ষা করুন' });
      inflight.set(lockKey, Date.now());
    }
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
    let r, text;
    try {
      r = await fetch(BASE + path, { method: m, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Api-Key': c.key, 'Secret-Key': c.secret }, ...(m === 'POST' && body ? { body: JSON.stringify(body) } : {}), signal: ctl.signal });
      text = await r.text();
    } finally { clearTimeout(t); }
    let j; try { j = JSON.parse(text); } catch (e) { return res.status(502).json({ error: 'Steadfast থেকে ভুল রেসপন্স (HTTP ' + r.status + ')' }); }
    res.json(j);
  } catch (e) {
    res.status(502).json({ error: e.name === 'AbortError' ? 'Steadfast সময়মতো সাড়া দেয়নি' : 'Steadfast-এর সাথে সংযোগ যায়নি' });
  } finally { if (lockKey) setTimeout(() => inflight.delete(lockKey), 5000); }
});

/* ---- Webhook ---- */
const SFM = { pending: 'confirmed', in_review: 'confirmed', hold: 'shipped', delivered: 'delivered', partial_delivered: 'delivered', cancelled: 'returned', delivered_approval_pending: 'shipped', partial_delivered_approval_pending: 'shipped', cancelled_approval_pending: 'shipped', unknown_approval_pending: 'shipped' };
const RK = { pending: 0, confirmed: 1, shipped: 2, delivered: 3, returned: 3, cancelled: 3 };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

router.post('/sf-webhook', lim(60 * 1000, 300), express.json({ limit: '50kb' }), async (req, res) => {
  try {
    const c = await cfg('private/courier', 10000);
    if (!c.webhookToken) return res.status(503).json({ status: 'error', message: 'Webhook token সেট করা নেই' });
    const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
    if (!m || !safeEq(m[1], c.webhookToken)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

    const b = req.body || {};
    const invoice = String(b.invoice || ''), cid = Number(b.consignment_id) || 0;
    let snap = null;
    if (/^BF-[A-Z0-9]{4,20}$/.test(invoice)) { const q = await db.collection('orders').where('orderId', '==', invoice).limit(1).get(); if (!q.empty) snap = q.docs[0]; }
    if (!snap && cid) { const q = await db.collection('orders').where('courier.cid', '==', cid).limit(1).get(); if (!q.empty) snap = q.docs[0]; }
    if (!snap) return res.json({ status: 'success', message: 'Webhook received (order not found).' });   // Steadfast বারবার রিট্রাই না করুক

    const o = snap.data(), upd = {};
    if (b.notification_type === 'tracking_update') {
      if (b.tracking_message) upd['courier.lastMsg'] = String(b.tracking_message).slice(0, 300);
    } else if (b.status) {
      const st = String(b.status).slice(0, 60);
      upd['courier.live'] = st; upd['courier.syncedAt'] = Date.now();
      const ns = SFM[st];
      if (ns && (RK[ns] || 0) > (RK[o.status] || 0)) upd.status = ns;
    }
    if (Object.keys(upd).length) {
      await snap.ref.update(upd);
      const rc = {}; if (upd['courier.live']) rc.live = upd['courier.live']; if (upd.status) rc.status = upd.status;
      if (Object.keys(rc).length && o.orderId) await db.collection('receipts').doc(o.orderId).set(rc, { merge: true }).catch(() => {});
    }
    res.json({ status: 'success', message: 'Webhook received successfully.' });
  } catch (e) { console.error('sf-webhook:', e); res.status(500).json({ status: 'error', message: 'Server error' }); }
});

module.exports = router;
