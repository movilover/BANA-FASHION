'use strict';
/* POST /api/orders/lookup — "আমার অর্ডার" সার্চ (অর্ডার আইডি বা মোবাইল নম্বর)
   • অর্ডার আইডি: শুধু সংক্ষিপ্ত তথ্য (নাম/নম্বর আংশিক, ঠিকানা ও কুরিয়ার ট্র্যাকিং নেই)
   • মোবাইল নম্বর: SMS বন্ধ থাকলে একই সংক্ষিপ্ত তথ্য; SMS চালু থাকলে শুধু OTP যাচাইয়ের পরে (sms.js) */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, cfg } = require('./firebase');
const { normPhone, maskPhone, maskName, iso, toDate } = require('./bn');

const router = express.Router();
const rl = max => rateLimit({
  windowMs: 10 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited', message: 'অনেকবার খোঁজা হয়েছে — ১০ মিনিট পরে আবার চেষ্টা করুন' }
});
const limById = rl(60);
const limByPhone = rl(30);

const tm = v => { const d = toDate(v); return d ? d.getTime() : 0; };

/* ক্লায়েন্টকে যা দেওয়া হবে। masked=true হলে ঠিকানা, জেলা-উপজেলা, পেমেন্ট ও কুরিয়ার তথ্য থাকবে না */
function publicOrder(o, masked) {
  const c = o.courier && typeof o.courier === 'object' ? o.courier : {};
  const items = (Array.isArray(o.items) ? o.items.slice(0, 50) : []).map(i => ({
    id: String(i.id || '').slice(0, 100),
    title: String(i.title || '').slice(0, 200),
    size: String(i.size || '').slice(0, 30),
    qty: Number(i.qty) || 0,
    price: Number(i.price) || 0
  }));
  const base = {
    orderId: o.orderId,
    status: o.status || 'pending',
    createdAt: iso(o.createdAt),
    total: Number(o.total) || 0,
    subtotal: Number(o.subtotal) || 0,
    discount: Number(o.discount) || 0,
    delivery: Number(o.delivery) || 0,
    items,
    customerName: masked ? maskName(o.customerName) : String(o.customerName || '').slice(0, 100),
    phone: masked ? maskPhone(o.phone) : String(o.phone || ''),
    masked: !!masked
  };
  if (masked) return base;
  return {
    ...base,
    promo: o.promo && o.promo.code ? { code: String(o.promo.code).slice(0, 20) } : null,
    payment: String(o.payment || '').slice(0, 100),
    area: o.area || '',
    district: String(o.district || '').slice(0, 40),
    upazila: String(o.upazila || '').slice(0, 60),
    division: String(o.division || '').slice(0, 40),
    deliveryPaid: !!o.deliveryPaid,
    address: String(o.address || '').slice(0, 500),
    tracking: c.tracking ? String(c.tracking).slice(0, 60) : '',
    courierName: c.name ? String(c.name).slice(0, 40) : '',
    live: c.live ? String(c.live).slice(0, 60) : ''
  };
}

async function ordersByPhone(phone, masked) {
  const s = await db.collection('orders').where('phone', '==', phone).limit(50).get();
  return s.docs
    .map(d => d.data())
    .sort((a, b) => tm(b.createdAt) - tm(a.createdAt))
    .map(o => publicOrder(o, masked));
}

router.post('/orders/lookup',
  express.json({ limit: '5kb' }),
  (req, res, next) => ((req.body && req.body.phone) ? limByPhone : limById)(req, res, next),
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const b = req.body || {};
      if (b.orderId) {
        const id = String(b.orderId).toUpperCase().replace(/\s+/g, '');
        if (!/^BF-[A-Z0-9]{4,20}$/.test(id)) return res.status(400).json({ error: 'bad_id', message: 'অর্ডার আইডি ঠিক নয়' });
        const q = await db.collection('orders').where('orderId', '==', id).limit(1).get();
        if (q.empty) return res.status(404).json({ error: 'not_found', message: 'এই আইডিতে কোনো অর্ডার পাওয়া যায়নি' });
        return res.json({ orders: [publicOrder(q.docs[0].data(), true)] });
      }
      if (b.phone) {
        const phone = normPhone(b.phone);
        if (!phone) return res.status(400).json({ error: 'bad_phone', message: 'সঠিক মোবাইল নম্বর (01XXXXXXXXX) দিন' });
        const sms = await cfg('settings/sms', 15000);
        if (sms.enabled) return res.status(403).json({ error: 'otp_required', message: 'SMS কোড দিয়ে ভেরিফাই করুন' });
        return res.json({ orders: await ordersByPhone(phone, true) });
      }
      res.status(400).json({ error: 'bad_request', message: 'অর্ডার আইডি বা মোবাইল নম্বর দিন' });
    } catch (e) {
      console.error('lookup:', e);
      res.status(500).json({ error: 'server', message: 'সার্ভারে সমস্যা হয়েছে, একটু পরে চেষ্টা করুন' });
    }
  });

module.exports = router;
module.exports.ordersByPhone = ordersByPhone;
