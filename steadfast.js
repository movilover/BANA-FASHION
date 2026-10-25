'use strict';
/* POST /api/sf          — অ্যাডমিন: Steadfast প্রক্সি (Key/Secret সার্ভারে Firestore থেকে; শুধু allowlist পাথ)
   POST /api/sf-webhook  — Steadfast থেকে আসে; Bearer টোকেন মিললে তবেই অর্ডারের স্ট্যাটাস আপডেট */
const router = require('express').Router();
const { db } = require('../lib/firebase');
const { requireAdmin, safeEqual } = require('../lib/auth');

const BASE = 'https://portal.packzy.com/api/v1/';
const PATHS = /^(get_balance|create_order|status_by_cid\/\d{1,15}|status_by_invoice\/[A-Za-z0-9_-]{1,40}|status_by_trackingcode\/[A-Za-z0-9_-]{1,40})$/;
const SFM = { pending: 'confirmed', in_review: 'confirmed', hold: 'shipped', delivered: 'delivered', partial_delivered: 'delivered', cancelled: 'returned',
  delivered_approval_pending: 'shipped', partial_delivered_approval_pending: 'shipped', cancelled_approval_pending: 'shipped', unknown_approval_pending: 'shipped' };
const RANK = { pending: 0, confirmed: 1, shipped: 2, delivered: 3, returned: 3, cancelled: 3 };

let cc = { t: 0, v: null };
async function courierCfg() {
  if (cc.v && Date.now() - cc.t < 30_000) return cc.v;
  const s = await db.doc('private/courier').get();
  cc = { t: Date.now(), v: s.exists ? s.data() : {} };
  return cc.v;
}

router.post('/sf', requireAdmin, async (req, res) => {
  try {
    const { path, method, body } = req.body || {};
    if (typeof path !== 'string' || !PATHS.test(path)) return res.status(400).json({ error: 'অনুমোদিত নয় এমন পাথ' });
    const m = method === 'POST' ? 'POST' : 'GET';
    const cfg = await courierCfg();
    if (!cfg.key || !cfg.secret) return res.status(400).json({ error: 'Steadfast API Key/Secret সেভ করা নেই' });

    let payload;
    if (path === 'create_order') { // শুধু প্রয়োজনীয় ফিল্ড পাস হয়
      const b = body || {};
      payload = JSON.stringify({
        invoice: String(b.invoice || '').slice(0, 40), recipient_name: String(b.recipient_name || '').slice(0, 100),
        recipient_phone: String(b.recipient_phone || '').slice(0, 15), recipient_address: String(b.recipient_address || '').slice(0, 250),
        cod_amount: Math.max(0, Number(b.cod_amount) || 0), note: String(b.note || '').slice(0, 250),
      });
    }
    const r = await fetch(BASE + path, {
      method: m, signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Api-Key': cfg.key, 'Secret-Key': cfg.secret },
      ...(m === 'POST' && payload ? { body: payload } : {}),
    });
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch (e) { j = { error: 'Steadfast থেকে ভুল রেসপন্স (HTTP ' + r.status + ')' }; }
    res.status(r.ok ? 200 : 502).json(r.ok ? j : { error: j.message || j.error || ('Steadfast HTTP ' + r.status), errors: j.errors });
  } catch (e) {
    console.error('sf:', e.message);
    res.status(502).json({ error: 'Steadfast-এর সাথে যোগাযোগ করা যায়নি' });
  }
});

router.post('/sf-webhook', async (req, res) => {
  try {
    const cfg = await courierCfg();
    if (!cfg.webhookToken) return res.status(503).json({ status: 'error', message: 'Webhook টোকেন সেট করা নেই' });
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m || !safeEqual(m[1].trim(), cfg.webhookToken)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

    const b = req.body || {};
    const invoice = String(b.invoice || '').slice(0, 40), cid = Number(b.consignment_id) || 0;
    let snap = invoice ? await db.collection('orders').where('orderId', '==', invoice).limit(1).get() : { empty: true };
    if (snap.empty && cid) snap = await db.collection('orders').where('courier.cid', '==', cid).limit(1).get();
    if (snap.empty) return res.json({ status: 'success', message: 'Webhook received successfully.' }); // অজানা অর্ডার — Steadfast রিট্রাই না করুক

    const ref = snap.docs[0].ref, o = snap.docs[0].data();
    const upd = { 'courier.syncedAt': Date.now() };
    if (b.tracking_message) upd['courier.msg'] = String(b.tracking_message).slice(0, 300);
    const rec = {};
    if (b.notification_type === 'delivery_status' && typeof b.status === 'string' && /^[a-z_]{2,50}$/.test(b.status)) {
      upd['courier.live'] = b.status; rec.live = b.status;
      const ns = SFM[b.status];
      if (ns && (RANK[ns] || 0) > (RANK[o.status] || 0)) { upd.status = ns; rec.status = ns; } // স্ট্যাটাস শুধু সামনে এগোয়
    }
    await ref.update(upd);
    if (Object.keys(rec).length) await db.collection('receipts').doc(o.orderId).set(rec, { merge: true }).catch(() => {});
    res.json({ status: 'success', message: 'Webhook received successfully.' });
  } catch (e) {
    console.error('sf-webhook:', e.message);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

module.exports = router;
