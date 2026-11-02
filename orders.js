'use strict';
/* POST /api/orders/lookup — "আমার অর্ডার" সার্চ (অর্ডার আইডি বা মোবাইল নম্বর) */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, cfg } = require('./firebase');
const { normPhone, maskPhone, maskName, iso, toDate } = require('./bn');

const router = express.Router();
const rl = (max) => rateLimit({ windowMs: 10 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message: 'অনেকবার খোঁজা হয়েছে — ১০ মিনিট পরে আবার চেষ্টা করুন' } });
const limById = rl(60), limByPhone = rl(15);

/* ক্লায়েন্টকে যা দেখানো হবে (masked=true হলে নাম/নম্বর আংশিক, ঠিকানা বাদ) */
function publicOrder(o, masked) {
  const c = o.courier && typeof o.courier === 'object' ? o.courier : {};
  return {
    orderId: o.orderId, status: o.status || 'pending', createdAt: iso(o.createdAt),
    total: o.total || 0, subtotal: o.subtotal || 0, discount: o.discount || 0, delivery: o.delivery || 0,
    promo: o.promo && o.promo.code ? { code: String(o.promo.code) } : null,
    payment: o.payment || '', area: o.area || '', district: o.district || '', upazila: o.upazila || '', division: o.division || '',
    deliveryPaid: !!o.deliveryPaid,
    items: (Array.isArray(o.items) ? o.items.slice(0, 50) : []).map(i => ({ id: i.id, title: i.title, size: i.size || '', qty: i.qty, price: i.price })),
    tracking: c.tracking || '', courierName: c.name || '', live: c.live || '',
    customerName: masked ? maskName(o.customerName) : o.customerName || '',
    phone: masked ? maskPhone(o.phone) : o.phone || '',
    ...(masked ? {} : { address: o.address || '' }),
    masked: !!masked
  };
}

async function ordersByPhone(phone, masked) {
  const s = await db.collection('orders').where('phone', '==', phone).limit(50).get();
  return s.docs.map(d => d.data()).sort((a, b) => ((toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0))).map(o => publicOrder(o, masked));
}

router.post('/orders/lookup', express.json({ limit: '5kb' }), (req, res, next) => ((req.body && req.body.phone) ? limByPhone : limById)(req, res, next), async (req, res) => {
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
