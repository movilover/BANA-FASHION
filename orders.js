'use strict';
/* POST /api/orders/lookup  — অর্ডার আইডি বা মোবাইল নম্বর দিয়ে অর্ডার খোঁজা (SMS বন্ধ থাকলে নাম/নম্বর/ঠিকানা আংশিক লুকানো)
   POST /api/otp/send       — SMS কোড পাঠায় (সুইচ চালু থাকলে)
   POST /api/otp/verify     — কোড মিললে পূর্ণ বিবরণসহ অর্ডার ফেরত
   POST /api/sms/test       — অ্যাডমিন: টেস্ট SMS
   OTP মেমরিতে (শুধু হ্যাশ) থাকে, ৫ মিনিট বৈধ, ৫ বার ভুল করলে বাতিল; কোনো ডাটাবেস রাইট নেই। */
const crypto = require('crypto');
const router = require('express').Router();
const { db } = require('./firebase');
const { requireAdmin } = require('./auth');
const sms = require('./sms');

const SECRET = crypto.randomBytes(32);          // প্রতিবার সার্ভার চালুতে নতুন
const OTP_TTL = 5 * 60_000, COOLDOWN = 60_000, MAX_TRIES = 5, PHONE_PER_HOUR = 5, IP_PER_HOUR = 10;
const DAILY_CAP = Math.max(10, parseInt(process.env.SMS_DAILY_CAP || '500', 10));
const otps = new Map();                          // phone -> {h, exp, tries, sentAt, sends:[], fake}
const ipSends = new Map();                       // ip -> [timestamps]
let dayKey = '', dayCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normPhone = (v) => {
  let d = String(v == null ? '' : v).replace(/[০-৯]/g, (x) => '০১২৩৪৫৬৭৮৯'.indexOf(x)).replace(/\D/g, '');
  if (d.startsWith('88') && d.length === 13) d = d.slice(2);
  return /^01[3-9]\d{8}$/.test(d) ? d : '';
};
const maskPhone = (p) => (p ? p.slice(0, 3) + '••••' + p.slice(-2) : '');
const hashCode = (ph, code) => crypto.createHmac('sha256', SECRET).update(ph + ':' + code).digest();
const iso = (v) => (v && v.toDate ? v.toDate().toISOString() : (typeof v === 'string' ? v : null));
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const err = (res, status, error, message) => res.status(status).json({ error, message });

/* অর্ডার → কাস্টমারকে দেখানোর নিরাপদ রূপ (uid, WhatsApp ফ্ল্যাগ, কুরিয়ার সিক্রেট ইত্যাদি কখনো যায় না) */
function pub(o, masked) {
  const c = o.courier && typeof o.courier === 'object' ? o.courier : {};
  const items = (Array.isArray(o.items) ? o.items : []).filter((i) => i && typeof i === 'object').slice(0, 50)
    .map((i) => ({ id: str(i.id, 100), title: str(i.title, 200), size: str(i.size, 30), qty: num(i.qty) || 1, price: num(i.price) }));
  const r = {
    orderId: str(o.orderId, 30), status: str(o.status || 'pending', 30), createdAt: iso(o.createdAt),
    subtotal: num(o.subtotal), discount: num(o.discount), delivery: num(o.delivery), total: num(o.total),
    promo: o.promo && o.promo.code ? { code: str(o.promo.code, 40) } : null, items,
    payment: str(o.payment, 100), deliveryPaid: !!o.deliveryPaid, area: str(o.area, 10),
    upazila: str(o.upazila, 60), district: str(o.district, 40), division: str(o.division, 40),
    tracking: str(c.tracking, 60), courierName: str(c.name, 40), live: str(c.live, 50), masked: !!masked,
  };
  if (masked) {
    const first = str(o.customerName, 100).trim().split(/\s+/)[0] || '';
    r.customerName = first ? first + ' ••' : '';
    r.phone = maskPhone(str(o.phone, 15));
  } else {
    r.customerName = str(o.customerName, 100); r.phone = str(o.phone, 15); r.address = str(o.address, 500);
    r.note = str(o.note, 500); r.email = str(o.email, 150);
    if (o.pay && typeof o.pay === 'object') r.pay = { method: str(o.pay.method, 10), trxId: str(o.pay.trxId, 20), sender: maskPhone(str(o.pay.sender, 15)), amount: num(o.pay.amount), status: str(o.pay.status, 20) };
  }
  return r;
}
const newest = (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
async function byPhone(ph) {
  const s = await db.collection('orders').where('phone', '==', ph).limit(40).get();
  return s.docs.map((d) => d.data());
}

/* ---------------- lookup ---------------- */
router.post('/orders/lookup', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.orderId != null) {
      const id = String(b.orderId).trim().toUpperCase();
      if (!/^BF-[A-Z0-9]{4,20}$/.test(id)) return err(res, 404, 'not_found', 'এই আইডিতে কোনো অর্ডার পাওয়া যায়নি');
      const q = await db.collection('orders').where('orderId', '==', id).limit(1).get();
      if (q.empty) return err(res, 404, 'not_found', 'এই আইডিতে কোনো অর্ডার পাওয়া যায়নি');
      return res.json({ orders: [pub(q.docs[0].data(), true)] }); // শুধু আইডি জানলে সবসময় আংশিক লুকানো
    }
    const ph = normPhone(b.phone);
    if (!ph) return err(res, 400, 'bad_phone', 'সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)');
    if (await sms.otpEnabled()) return err(res, 403, 'otp_required', 'নম্বর ভেরিফাই করতে SMS কোড লাগবে');
    const list = (await byPhone(ph)).map((o) => pub(o, true)).sort(newest);
    res.json({ orders: list });
  } catch (e) {
    console.error('lookup:', e.message);
    err(res, 500, 'server', 'সার্ভারে সমস্যা হয়েছে, একটু পরে চেষ্টা করুন');
  }
});

/* ---------------- OTP ---------------- */
const within = (arr, ms) => { const t = Date.now() - ms; while (arr.length && arr[0] < t) arr.shift(); return arr; };

router.post('/otp/send', async (req, res) => {
  try {
    const ph = normPhone((req.body || {}).phone);
    if (!ph) return err(res, 400, 'bad_phone', 'সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)');
    if (!(await sms.otpEnabled())) return err(res, 400, 'sms_off', 'SMS ভেরিফিকেশন বন্ধ আছে');

    const now = Date.now(), e = otps.get(ph) || { sends: [] };
    if (e.sentAt && now - e.sentAt < COOLDOWN) return err(res, 429, 'too_many', Math.ceil((COOLDOWN - (now - e.sentAt)) / 1000) + ' সেকেন্ড পরে আবার চেষ্টা করুন');
    if (within(e.sends, 3600_000).length >= PHONE_PER_HOUR) return err(res, 429, 'too_many', 'এই নম্বরে অনেকবার কোড পাঠানো হয়েছে, ১ ঘণ্টা পরে চেষ্টা করুন');
    const ipl = within(ipSends.get(req.ip) || [], 3600_000);
    if (ipl.length >= IP_PER_HOUR) return err(res, 429, 'too_many', 'অনেক বেশি অনুরোধ, একটু পরে চেষ্টা করুন');
    const today = new Date().toISOString().slice(0, 10);
    if (dayKey !== today) { dayKey = today; dayCount = 0; }
    if (dayCount >= DAILY_CAP) return err(res, 503, 'too_many', 'আজকের জন্য SMS সীমা শেষ, কাল চেষ্টা করুন বা অর্ডার আইডি দিয়ে খুঁজুন');

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const has = !(await db.collection('orders').where('phone', '==', ph).limit(1).get()).empty;
    if (has) {
      try { await sms.sendSms(ph, await sms.otpText(code)); dayCount++; }
      catch (x) { console.error('otp sms:', x.message); return err(res, 502, 'sms_failed', 'SMS পাঠানো যায়নি, একটু পরে আবার চেষ্টা করুন'); }
    } else await sleep(500 + Math.random() * 700); // এই নম্বরে অর্ডার নেই: SMS খরচ নেই, আর বাইরে থেকে বোঝা যায় না
    e.h = hashCode(ph, code); e.exp = now + OTP_TTL; e.tries = 0; e.sentAt = now; e.fake = !has; e.sends.push(now);
    otps.set(ph, e); ipl.push(now); ipSends.set(req.ip, ipl);
    res.json({ ok: true, len: 6, resend: 60 });
  } catch (e) {
    console.error('otp/send:', e.message);
    err(res, 500, 'server', 'সার্ভারে সমস্যা হয়েছে, একটু পরে চেষ্টা করুন');
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const b = req.body || {}, ph = normPhone(b.phone), code = String(b.code == null ? '' : b.code).replace(/\D/g, '');
    if (!ph || code.length !== 6) return err(res, 400, 'bad_code', 'কোড মেলেনি');
    const e = otps.get(ph);
    if (!e || !e.h) return err(res, 400, 'expired', 'কোডের মেয়াদ শেষ হয়েছে, আবার কোড পাঠান');
    if (Date.now() > e.exp) { otps.delete(ph); return err(res, 400, 'expired', 'কোডের মেয়াদ শেষ হয়েছে, আবার কোড পাঠান'); }
    if (e.tries >= MAX_TRIES) { otps.delete(ph); return err(res, 429, 'too_many', 'অনেকবার ভুল হয়েছে, নতুন কোড নিন'); }
    const ok = !e.fake && crypto.timingSafeEqual(hashCode(ph, code), e.h);
    if (!ok) {
      e.tries++;
      if (e.tries >= MAX_TRIES) { otps.delete(ph); return err(res, 429, 'too_many', 'অনেকবার ভুল হয়েছে, নতুন কোড নিন'); }
      return err(res, 400, 'bad_code', 'কোড মেলেনি, আবার দেখুন');
    }
    otps.delete(ph);
    res.json({ orders: (await byPhone(ph)).map((o) => pub(o, false)).sort(newest) });
  } catch (e) {
    console.error('otp/verify:', e.message);
    err(res, 500, 'server', 'সার্ভারে সমস্যা হয়েছে, একটু পরে চেষ্টা করুন');
  }
});

/* ---------------- অ্যাডমিন: টেস্ট SMS ---------------- */
router.post('/sms/test', requireAdmin, async (req, res) => {
  try {
    const to = normPhone((req.body || {}).to);
    if (!to) return err(res, 400, 'bad_phone', 'সঠিক মোবাইল নম্বর দিন');
    await sms.load(true);
    await sms.sendSms(to, '✅ BANA FASHION — টেস্ট SMS সফল!');
    res.json({ ok: true });
  } catch (e) { err(res, 400, 'sms_failed', e.message); }
});

setInterval(() => { // মেমরি পরিষ্কার
  const now = Date.now();
  for (const [k, v] of otps) if (now > (v.exp || 0) + 3600_000 && !within(v.sends, 3600_000).length) otps.delete(k);
  for (const [k, v] of ipSends) if (!within(v, 3600_000).length) ipSends.delete(k);
}, 10 * 60_000).unref();

module.exports = router;
