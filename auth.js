'use strict';
/* অ্যাডমিন ও App Check যাচাই — সিকিউরিটি রিভিউ v2 */
const { admin } = require('./firebase');

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'banafashiongazipur@gmail.com').trim().toLowerCase();
const TOKEN_RE = /^Bearer ([A-Za-z0-9._-]{20,4096})$/;
const APPCHECK_RE = /^[A-Za-z0-9._-]{20,4096}$/;
const APPCHECK_ENFORCE = process.env.APPCHECK_ENFORCE === '1';

/* Firestore Rules-এর admin() এর সাথে হুবহু এক: নির্দিষ্ট ইমেইল + password সাইন-ইন */
async function adminFromReq(req) {
  const m = TOKEN_RE.exec(req.get('authorization') || '');
  if (!m) return null;
  try {
    // checkRevoked = true: পাসওয়ার্ড বদলালে বা অ্যাকাউন্ট বন্ধ করলে পুরোনো টোকেন সাথে সাথে অচল
    const t = await admin.auth().verifyIdToken(m[1], true);
    if (String(t.email || '').toLowerCase() === ADMIN_EMAIL
        && t.firebase && t.firebase.sign_in_provider === 'password') {
      return t;
    }
  } catch (e) {
    /* ভুল, মেয়াদোত্তীর্ণ বা বাতিল টোকেন */
  }
  return null;
}

const DENIED = { error: 'unauthorized', message: 'অ্যাডমিন লগইন প্রয়োজন — আবার লগইন করুন' };

function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  adminFromReq(req).then(t => {
    if (!t) return res.status(401).json(DENIED);
    req.admin = t;
    next();
  }, () => res.status(401).json(DENIED));
}

/* App Check: টোকেন থাকলে যাচাই হয়। APPCHECK_ENFORCE=1 হলে টোকেন ছাড়া/ভুল টোকেনে অনুরোধ বন্ধ।
   এটি তখনই কার্যকর হবে যখন রাউটে এই middleware বসানো থাকবে এবং ফ্রন্টএন্ড সব কলে টোকেন পাঠাবে। */
async function appCheck(req, res, next) {
  const tok = req.get('x-firebase-appcheck') || '';
  let ok = false;
  if (APPCHECK_RE.test(tok)) {
    try {
      await admin.appCheck().verifyToken(tok);
      ok = true;
    } catch (e) {
      ok = false;
    }
  }
  if (ok || !APPCHECK_ENFORCE) return next();
  res.status(401).json({ error: 'appcheck', message: 'অনুরোধ যাচাই হয়নি — পেজ রিফ্রেশ করে আবার চেষ্টা করুন' });
}

module.exports = { ADMIN_EMAIL, adminFromReq, requireAdmin, appCheck };
