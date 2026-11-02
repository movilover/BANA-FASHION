'use strict';
/* SMS কোড (OTP): /api/otp/send · /api/otp/verify · /api/sms/test (অ্যাডমিন) */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, cfg } = require('./firebase');
const { requireAdmin } = require('./auth');
const { normPhone, toEn } = require('./bn');
const { ordersByPhone } = require('./orders');

const router = express.Router();
const rl = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message } });

const SECRET = process.env.OTP_SECRET || crypto.createHash('sha256').update(String(process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT || 'bana')).digest('hex');
const LEN = 6, TTL = 10 * 60 * 1000, RESEND = 60 * 1000, MAX_TRIES = 5, MAX_PER_HOUR = 5;
const hash = (phone, code) => crypto.createHmac('sha256', SECRET).update(phone + ':' + code).digest('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const otpRef = phone => db.collection('otp').doc(phone);   // Rules-এ নেই ⇒ ক্লায়েন্টের জন্য বন্ধ; শুধু সার্ভার

/* ---- SMS পাঠানো ---- */
async function fetchT(url, opt = {}) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
  try { const r = await fetch(url, { ...opt, signal: ctl.signal }); const text = await r.text(); return { ok: r.ok, status: r.status, text }; }
  catch (e) { throw new Error('SMS সার্ভিসে সংযোগ যায়নি'); }
  finally { clearTimeout(t); }
}
async function sendSms(c, phone, text) {
  const prov = c.provider || 'bulksmsbd', phone88 = '88' + phone;
  if (prov === 'bulksmsbd') {
    if (!c.key) throw new Error('SMS API Key সেট করা নেই');
    const q = new URLSearchParams({ api_key: c.key, type: 'text', number: phone88, message: text });
    if (c.sender) q.set('senderid', c.sender);
    const r = await fetchT('https://bulksmsbd.net/api/smsapi?' + q.toString());
    let j = null; try { j = JSON.parse(r.text); } catch (e) {}
    if (!r.ok || !j || Number(j.response_code) !== 202) throw new Error('SMS সার্ভিস: ' + String((j && (j.error_message || j.success_message)) || r.text).slice(0, 120));
    return true;
  }
  if (prov === 'greenweb') {
    if (!c.key) throw new Error('SMS API Token সেট করা নেই');
    const r = await fetchT('https://api.greenweb.com.bd/api.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.key, to: phone, message: text }).toString() });
    if (!r.ok || !/^\s*ok/i.test(r.text)) throw new Error('SMS সার্ভিস: ' + r.text.slice(0, 120));
    return true;
  }
  if (prov === 'custom') {
    const tpl = String(c.urlTemplate || '');
    if (!/^https?:\/\//i.test(tpl)) throw new Error('Custom API URL ঠিক নয়');
    const e = encodeURIComponent;
    const url = tpl.replace(/\{key\}/g, e(c.key || '')).replace(/\{sender\}/g, e(c.sender || '')).replace(/\{phone88\}/g, phone88).replace(/\{phone\}/g, phone).replace(/\{message\}/g, e(text));
    const r = await fetchT(url);
    if (!r.ok) throw new Error('SMS সার্ভিস HTTP ' + r.status);
    return true;
  }
  throw new Error('অজানা SMS সার্ভিস');
}

/* ---- কোড পাঠানো ---- */
router.post('/otp/send', rl(60 * 60 * 1000, 15, 'এই ডিভাইস থেকে অনেকবার চেষ্টা হয়েছে — পরে চেষ্টা করুন'), express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const sms = await cfg('settings/sms', 10000);
    if (!sms.enabled) return res.status(400).json({ error: 'sms_off', message: 'SMS ভেরিফিকেশন বন্ধ আছে' });
    const phone = normPhone((req.body || {}).phone);
    if (!phone) return res.status(400).json({ error: 'bad_phone', message: 'সঠিক মোবাইল নম্বর দিন' });

    /* যে নম্বরে কোনো অর্ডারই নেই — সেখানে SMS পাঠিয়ে টাকা নষ্ট/স্প্যাম করা হয় না */
    const has = await db.collection('orders').where('phone', '==', phone).limit(1).get();
    if (has.empty) return res.status(404).json({ error: 'no_orders', message: 'এই নম্বরে কোনো অর্ডার পাওয়া যায়নি' });

    const priv = await cfg('private/sms', 0);
    const code = String(crypto.randomInt(0, 10 ** LEN)).padStart(LEN, '0');
    const now = Date.now();
    const gate = await db.runTransaction(async tx => {
      const s = await tx.get(otpRef(phone)), d = s.exists ? s.data() : {};
      if (d.sentAt && now - d.sentAt < RESEND) return { wait: Math.ceil((RESEND - (now - d.sentAt)) / 1000) };
      const win = d.win && now - d.win < 3600e3 ? d.win : now, cnt = d.win && now - d.win < 3600e3 ? (d.cnt || 0) : 0;
      if (cnt >= MAX_PER_HOUR) return { limit: true };
      tx.set(otpRef(phone), { h: hash(phone, code), exp: now + TTL, tries: 0, sentAt: now, win, cnt: cnt + 1 });
      return {};
    });
    if (gate.wait) return res.status(429).json({ error: 'wait', message: `${gate.wait} সেকেন্ড পরে আবার কোড চান`, resend: gate.wait });
    if (gate.limit) return res.status(429).json({ error: 'too_many', message: 'এক ঘণ্টায় অনেকবার কোড চাওয়া হয়েছে — পরে চেষ্টা করুন' });

    const text = String(priv.message || 'Bana Fashion: আপনার ভেরিফিকেশন কোড {code}। কোডটি ১০ মিনিট পর্যন্ত বৈধ, কাউকে বলবেন না।').replace(/\{code\}/g, code);
    try { await sendSms(priv, phone, text); }
    catch (e) { await otpRef(phone).delete().catch(() => {}); console.warn('sms send:', e.message); return res.status(502).json({ error: 'send_failed', message: 'SMS পাঠানো যায়নি, একটু পরে চেষ্টা করুন' }); }
    res.json({ ok: true, len: LEN, resend: RESEND / 1000 });
  } catch (e) { console.error('otp/send:', e); res.status(500).json({ error: 'server', message: 'সার্ভারে সমস্যা হয়েছে' }); }
});

/* ---- কোড মেলানো ---- */
router.post('/otp/verify', rl(10 * 60 * 1000, 40, 'অনেকবার চেষ্টা হয়েছে — একটু পরে চেষ্টা করুন'), express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const phone = normPhone((req.body || {}).phone), code = toEn((req.body || {}).code).replace(/\D/g, '');
    if (!phone || code.length !== LEN) return res.status(400).json({ error: 'bad_request', message: `${LEN} সংখ্যার কোডটি লিখুন` });
    const r = await db.runTransaction(async tx => {
      const s = await tx.get(otpRef(phone));
      if (!s.exists) return { err: 'expired' };
      const d = s.data();
      if (Date.now() > d.exp) { tx.delete(otpRef(phone)); return { err: 'expired' }; }
      if ((d.tries || 0) >= MAX_TRIES) return { err: 'too_many' };
      if (!same(d.h, hash(phone, code))) { tx.update(otpRef(phone), { tries: (d.tries || 0) + 1 }); return { err: 'wrong', left: MAX_TRIES - (d.tries || 0) - 1 }; }
      tx.delete(otpRef(phone));   // একবার ব্যবহারযোগ্য
      return { ok: true };
    });
    if (r.err === 'expired') return res.status(400).json({ error: 'expired', message: 'কোডের মেয়াদ শেষ — নতুন কোড চান' });
    if (r.err === 'too_many') return res.status(429).json({ error: 'too_many', message: 'অনেকবার ভুল হয়েছে — নতুন কোড চান' });
    if (r.err === 'wrong') return res.status(400).json({ error: 'wrong', message: `কোড মেলেনি${r.left > 0 ? ` (আর ${r.left} বার চেষ্টা করা যাবে)` : ''}` });
    res.json({ orders: await ordersByPhone(phone, false) });
  } catch (e) { console.error('otp/verify:', e); res.status(500).json({ error: 'server', message: 'সার্ভারে সমস্যা হয়েছে' }); }
});

/* ---- অ্যাডমিন টেস্ট ---- */
router.post('/sms/test', rl(60 * 1000, 10, 'একটু পরে চেষ্টা করুন'), requireAdmin, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const phone = normPhone((req.body || {}).to);
    if (!phone) throw new Error('সঠিক মোবাইল নম্বর দিন');
    await sendSms(await cfg('private/sms', 0), phone, 'Bana Fashion: টেস্ট SMS — সংযোগ ঠিক আছে।');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message, message: e.message }); }
});

module.exports = router;
