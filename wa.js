'use strict';
/* /api/wa-enabled (পাবলিক) · /api/wa-notify (শুধু অর্ডারের মালিক, নতুন অর্ডারের পর) · /api/wa (অ্যাডমিন: test, groups) */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { admin, db, FieldValue, cfg, Timestamp } = require('./firebase');
const { requireAdmin, appCheck } = require('./auth');
const { toDate } = require('./bn');
const { orderText } = require('./invoiceText');
const { checkOrder } = require('./products');
const wa = require('./whatsapp');

const router = express.Router();
const lim = (windowMs, max) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited', message: 'অনেক বেশি অনুরোধ — একটু পরে চেষ্টা করুন' }
});
const MAX_AGE = 3 * 24 * 3600 * 1000;   // এর চেয়ে পুরনো অর্ডারের অ্যালার্ট আর পাঠানো হয় না
const MAX_TRIES = 5;
const IMG_MAX = 2.5e6;
const TOKEN_RE = /^Bearer ([A-Za-z0-9._-]{20,4096})$/;
const IMG_RE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]{100,}$/;

router.get('/wa-enabled', lim(60 * 1000, 120), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const c = await cfg('private/whatsapp');
    res.json({ enabled: !!(c.enabled && c.token && c.target) });
  } catch (e) {
    res.json({ enabled: true });   // ভুল হলে সাইট নিজে চেষ্টা করবে; পরের ধাপ নিজেই যাচাই করে
  }
});

router.post('/wa-notify', lim(10 * 60 * 1000, 40), appCheck, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    /* ১) অনুরোধকারীকে অবশ্যই ওই অর্ডারের মালিক হতে হবে — অর্ডার আইডি জানলেই কেউ গ্রুপে অ্যালার্ট/ছবি পাঠাতে পারবে না */
    const m = TOKEN_RE.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'unauthorized', message: 'সেশন নেই — পেজ রিফ্রেশ করে আবার চেষ্টা করুন' });
    let uid = '';
    try { uid = (await admin.auth().verifyIdToken(m[1])).uid; }
    catch (e) { return res.status(401).json({ error: 'unauthorized', message: 'সেশন যাচাই হয়নি' }); }

    const body = req.body || {};
    const orderId = String(body.orderId || '');
    if (!/^BF-[A-Z0-9]{4,20}$/.test(orderId)) return res.status(400).json({ error: 'bad_order_id', message: 'অর্ডার আইডি ঠিক নয়' });

    const c = await cfg('private/whatsapp');
    if (!c.enabled || !c.token || !c.target) return res.json({ ok: true, skipped: 'disabled' });

    const q = await db.collection('orders').where('orderId', '==', orderId).limit(1).get();
    if (q.empty) return res.status(404).json({ error: 'not_found', message: 'অর্ডার পাওয়া যায়নি' });
    const ref = q.docs[0].ref;
    if (!q.docs[0].data().uid || q.docs[0].data().uid !== uid) {
      return res.status(403).json({ error: 'forbidden', message: 'এই অর্ডারের অনুমতি নেই' });
    }

    /* ২) একই অর্ডারের অ্যালার্ট দুবার যাওয়া আটকাতে ট্রানজ্যাকশনে "দাবি" করা হয় */
    const claim = await db.runTransaction(async tx => {
      const s = await tx.get(ref), o = s.data() || {};
      const created = toDate(o.createdAt);
      if (created && Date.now() - created.getTime() > MAX_AGE) return { skip: 'too_old' };
      if (o.waState === 'sent') return { skip: 'already' };
      const at = toDate(o.waAt);
      if (o.waState === 'sending' && at && Date.now() - at.getTime() < 60000) return { skip: 'busy' };
      if ((o.waTries || 0) >= MAX_TRIES) return { skip: 'too_many' };
      tx.update(ref, { waState: 'sending', waAt: Timestamp.now(), waTries: FieldValue.increment(1) });
      return { order: o };
    });
    if (claim.skip === 'too_old') return res.status(410).json({ error: 'too_old', message: 'অর্ডারটি পুরনো' });
    if (claim.skip === 'too_many') return res.status(429).json({ error: 'too_many', message: 'অনেকবার চেষ্টা হয়েছে' });
    if (claim.skip) return res.json({ ok: true, skipped: claim.skip });

    const o = claim.order;
    try {
      const flags = await checkOrder(o);
      await wa.sendText(c, c.target, orderText(o, flags));
      await ref.update({ waState: 'sent', waAt: Timestamp.now(), waErr: FieldValue.delete() });

      /* ৩) ইনভয়েস ছবি: শুধু সঠিক ফরম্যাটের ও আকারের ছবি; অন্য কিছু কখনো গ্রুপে যাবে না */
      const img = typeof body.image === 'string' ? body.image : '';
      if (img && img.length < IMG_MAX && IMG_RE.test(img)) {
        try { await wa.sendImage(c, c.target, img, 'ইনভয়েস — ' + orderId); }
        catch (e) { console.warn('wa image:', e.message); }
      }
      return res.json({ ok: true });
    } catch (e) {
      await ref.update({ waState: 'failed', waErr: String(e.message).slice(0, 200) }).catch(() => {});
      console.warn('wa-notify failed:', orderId, e.message);
      return res.status(502).json({ error: 'send_failed', message: 'WhatsApp অ্যালার্ট যায়নি' });
    }
  } catch (e) {
    console.error('wa-notify:', e);
    res.status(500).json({ error: 'server', message: 'সার্ভারে সমস্যা' });
  }
});

/* অ্যাডমিন: টেস্ট মেসেজ ও গ্রুপ লিস্ট */
router.post('/wa', lim(60 * 1000, 30), requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const c = await cfg('private/whatsapp', 0);   // অ্যাডমিন সেভ করেই টেস্ট করে — তাই ক্যাশ ছাড়া
    const action = String((req.body || {}).action || '');
    if (action === 'groups') return res.json({ ok: true, groups: await wa.listGroups(c) });
    if (action === 'test') {
      if (!c.target) throw new Error('গ্রুপ Chat ID / নম্বর সেট করা নেই');
      await wa.sendText(c, c.target, '✅ BANA FASHION — WhatsApp টেস্ট মেসেজ। সংযোগ ঠিক আছে।');
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'অজানা অ্যাকশন', message: 'অজানা অ্যাকশন' });
  } catch (e) {
    res.status(400).json({ error: e.message, message: e.message });
  }
});

module.exports = router;
