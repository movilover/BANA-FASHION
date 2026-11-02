'use strict';
/* অ্যাডমিন ও App Check যাচাই */
const { admin } = require('./firebase');
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'banafashiongazipur@gmail.com').toLowerCase();

/* Firestore Rules-এর admin() এর সাথে হুবহু এক: নির্দিষ্ট ইমেইল + password সাইন-ইন */
async function adminFromReq(req) {
  const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
  if (!m) return null;
  try {
    const t = await admin.auth().verifyIdToken(m[1]);
    if (String(t.email || '').toLowerCase() === ADMIN_EMAIL && t.firebase && t.firebase.sign_in_provider === 'password') return t;
  } catch (e) { /* ভুল/মেয়াদোত্তীর্ণ টোকেন */ }
  return null;
}
function requireAdmin(req, res, next) {
  adminFromReq(req).then(t => {
    if (!t) return res.status(401).json({ error: 'অ্যাডমিন লগইন প্রয়োজন — আবার লগইন করুন', code: 'unauthorized', message: 'অ্যাডমিন লগইন প্রয়োজন — আবার লগইন করুন' });
    req.admin = t; next();
  }).catch(() => res.status(401).json({ error: 'যাচাই করা যায়নি', code: 'unauthorized', message: 'যাচাই করা যায়নি' }));
}

/* App Check: টোকেন থাকলে যাচাই হয়; APPCHECK_ENFORCE=1 হলে টোকেন ছাড়া বন্ধ */
async function appCheck(req, res, next) {
  const enforce = process.env.APPCHECK_ENFORCE === '1';
  const tok = req.get('x-firebase-appcheck');
  if (!tok) return enforce ? res.status(401).json({ error: 'appcheck', message: 'অনুরোধ যাচাই হয়নি' }) : next();
  try { await admin.appCheck().verifyToken(tok); return next(); }
  catch (e) { return enforce ? res.status(401).json({ error: 'appcheck', message: 'অনুরোধ যাচাই হয়নি' }) : next(); }
}

module.exports = { ADMIN_EMAIL, adminFromReq, requireAdmin, appCheck };
