'use strict';
/* Firebase Admin SDK — সার্ভারে একবারই চালু হয়। Admin SDK Firestore rules বাইপাস করে,
   তাই এই ফাইলের credential কখনো ব্রাউজারে/গিটহাবে যাবে না (শুধু Railway Variables-এ থাকবে)। */
const admin = require('firebase-admin');

function loadCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    : process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 সেট করা নেই (Railway > Variables)');
  const json = JSON.parse(raw);
  if (json.private_key) json.private_key = json.private_key.replace(/\\n/g, '\n');
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
