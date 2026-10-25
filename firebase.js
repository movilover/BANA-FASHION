'use strict';
/* Firebase Admin SDK — সার্ভারে একবারই চালু হয়। Admin SDK Firestore rules বাইপাস করে,
   তাই এই ফাইলের credential কখনো ব্রাউজারে/গিটহাবে যাবে না (শুধু Railway Variables-এ থাকবে)। */
const admin = require('firebase-admin');

function loadCredential() {
  /* দুই নামের যেকোনোটাতে বসালেই চলবে; মান হতে পারে আসল JSON অথবা base64 — সার্ভার নিজেই বুঝে নেয় */
  let s = String(process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!s) throw new Error('Firebase key সেট করা নেই — Railway > Variables এ FIREBASE_SERVICE_ACCOUNT_B64 এ পুরো JSON বসান');
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (!s.startsWith('{')) s = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
  let json;
  try { json = JSON.parse(s); }
  catch (e) { throw new Error('Firebase key পড়া যায়নি — JSON-এর শুরুর { থেকে শেষের } পর্যন্ত পুরোটা কপি করে বসান, কিছু বাদ বা বদলাবেন না'); }
  if (!json.private_key || !json.client_email || !json.project_id) throw new Error('এটা Firebase service-account key নয় (private_key/client_email নেই)');
  json.private_key = json.private_key.replace(/\\n/g, '\n');
  return json;
}

admin.initializeApp({ credential: admin.credential.cert(loadCredential()) });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = {
  admin,
  db,
  auth: admin.auth(),
  FieldValue: admin.firestore.FieldValue,
  Timestamp: admin.firestore.Timestamp,
};
