'use strict';
/* টোকেন যাচাই: requireUser = যেকোনো লগইন/অ্যানোনিমাস ব্যবহারকারী, requireAdmin = শুধু মালিক।
   requireAdmin ঠিক Firestore rules-এর admin() ফাংশনের মতোই: নির্দিষ্ট ইমেইল + "password" সাইন-ইন প্রোভাইডার। */
const crypto = require('crypto');
const { admin, auth } = require('./firebase');

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!ADMIN_EMAIL) throw new Error('ADMIN_EMAIL সেট করা নেই');

const bearer = (req) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : null;
};

/* দুটি স্ট্রিং টাইমিং-অ্যাটাক ছাড়া তুলনা */
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

async function requireUser(req, res, next) {
  try {
    const t = bearer(req);
    if (!t) return res.status(401).json({ error: 'লগইন সেশন নেই' });
    req.user = await auth.verifyIdToken(t);
    next();
  } catch (e) {
    res.status(401).json({ error: 'সেশন অবৈধ বা মেয়াদোত্তীর্ণ' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const t = bearer(req);
    if (!t) return res.status(401).json({ error: 'লগইন সেশন নেই, আবার লগইন করুন' });
    const d = await auth.verifyIdToken(t, true); // true = রিভোক করা টোকেনও আটকায়
    const ok = String(d.email || '').toLowerCase() === ADMIN_EMAIL
      && d.firebase && d.firebase.sign_in_provider === 'password';
    if (!ok) return res.status(403).json({ error: 'অনুমতি নেই' });
    req.user = d;
    next();
  } catch (e) {
    res.status(401).json({ error: 'সেশন অবৈধ বা মেয়াদোত্তীর্ণ' });
  }
}

/* ঐচ্ছিক: APPCHECK_ENFORCE=true হলে শুধু আসল সাইট থেকে আসা রিকোয়েস্ট চলবে */
async function appCheck(req, res, next) {
  if (process.env.APPCHECK_ENFORCE !== 'true') return next();
  try {
    const tok = req.headers['x-firebase-appcheck'];
    if (!tok) return res.status(401).json({ error: 'App Check টোকেন নেই' });
    await admin.appCheck().verifyToken(String(tok));
    next();
  } catch (e) {
    res.status(401).json({ error: 'App Check যাচাই ব্যর্থ' });
  }
}

module.exports = { requireUser, requireAdmin, appCheck, safeEqual, ADMIN_EMAIL };
