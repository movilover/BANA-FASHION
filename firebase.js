'use strict';
/**
 * Firebase Admin SDK (সার্ভার-সাইড)। Spark (ফ্রি) প্ল্যানেই কাজ করে।
 * Railway Variables-এ দিন:  FIREBASE_SERVICE_ACCOUNT_B64  (সার্ভিস অ্যাকাউন্ট JSON-এর base64)
 *                       অথবা FIREBASE_SERVICE_ACCOUNT      (সরাসরি JSON)
 */
const admin = require('firebase-admin');

function loadCreds() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    : process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 (বা FIREBASE_SERVICE_ACCOUNT) সেট করা নেই');
  const j = JSON.parse(raw);
  if (j.private_key) j.private_key = j.private_key.replace(/\\n/g, '\n');
  return j;
}

admin.initializeApp({ credential: admin.credential.cert(loadCreds()) });

const db = admin.firestore();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'banafashiongazipur@gmail.com').toLowerCase();

/** শুধু অ্যাডমিন (ইমেইল+পাসওয়ার্ড লগইন) — Firebase ID token যাচাই, revoked হলে বাতিল */
async function requireAdmin(req, res, next) {
  try {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tok) return res.status(401).json({ error: 'লগইন করুন' });
    const u = await admin.auth().verifyIdToken(tok, true);
    const ok = String(u.email || '').toLowerCase() === ADMIN_EMAIL
      && u.firebase && u.firebase.sign_in_provider === 'password';
    if (!ok) return res.status(403).json({ error: 'অনুমতি নেই' });
    req.admin = u;
    next();
  } catch (e) {
    res.status(401).json({ error: 'লগইন সেশন অবৈধ — আবার লগইন করুন' });
  }
}

/** (ঐচ্ছিক) Firebase App Check যাচাই — ENFORCE_APPCHECK=1 হলে শুধু আসল সাইট থেকে আসা রিকোয়েস্ট চলবে */
async function appCheckGuard(req, res, next) {
  if (process.env.ENFORCE_APPCHECK !== '1') return next();
  try {
    const t = req.headers['x-firebase-appcheck'];
    if (!t) return res.status(401).json({ error: 'app check required' });
    await admin.appCheck().verifyToken(String(t));
    next();
  } catch (e) { res.status(401).json({ error: 'app check failed' }); }
}

module.exports = { admin, db, ADMIN_EMAIL, requireAdmin, appCheckGuard };
