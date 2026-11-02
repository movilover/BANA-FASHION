'use strict';
/* Firebase Admin SDK — সার্ভার এটা দিয়ে Firestore পড়ে/লেখে (Firestore Rules এখানে প্রযোজ্য নয়) */
const admin = require('firebase-admin');

function loadCred() {
  /* দুটো ভ্যারিয়েবলের যেকোনোটায়, যেকোনো ভাবে বসানো চলবে: পুরো JSON অথবা base64 — সার্ভার নিজেই চিনে নেয় */
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT || '';
  raw = String(raw).trim();
  if (!raw) throw new Error('Railway Variables-এ FIREBASE_SERVICE_ACCOUNT_B64 (বা FIREBASE_SERVICE_ACCOUNT) নেই');
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1).trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8').trim();
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { throw new Error('সার্ভিস অ্যাকাউন্ট ভ্যারিয়েবলটি ঠিক নয় — Firebase থেকে ডাউনলোড করা JSON ফাইলের পুরো লেখা ({ থেকে } পর্যন্ত) বসান'); }
  if (!j.private_key || !j.client_email) throw new Error('সার্ভিস অ্যাকাউন্টে private_key/client_email নেই — ভুল ফাইল');
  j.private_key = String(j.private_key).replace(/\\n/g, '\n');
  return j;
}

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(loadCred()) });

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

/* কনফিগ ডকুমেন্টের ছোট ক্যাশ (ডিফল্ট ৩০ সেকেন্ড) — ইউজার বাড়লেও Firestore রিড কমে থাকে */
const _c = new Map();
function cfg(path, ttl = 30000) {
  const now = Date.now(), e = _c.get(path);
  if (e && now - e.t < ttl) return e.p;
  const p = db.doc(path).get().then(s => (s.exists ? s.data() : {}));
  _c.set(path, { t: now, p });
  p.catch(() => _c.delete(path));
  return p;
}
const dropCache = path => (path ? _c.delete(path) : _c.clear());

module.exports = { admin, db, FieldValue, Timestamp, cfg, dropCache };
