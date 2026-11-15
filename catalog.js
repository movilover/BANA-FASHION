'use strict';
/* GET /api/catalog — পণ্য + হ্যাঙ্গার এক রিকোয়েস্টে, সার্ভারের মেমরি থেকে।
   সার্ভার সবসময় চালু থাকে বলে Firestore-এর লাইভ লিসেনার ব্যবহার করা হয়:
   শুরুতে একবার সব পণ্য পড়ে, তারপর শুধু যেটা বদলায় সেটাই (Firestore রিড প্রায় শূন্য, অ্যাডমিনের পরিবর্তন সাথে সাথে)।
   কোনো কারণে না চললে সাইট আগের Firestore পথেই চলে (index.html-এ ফলব্যাক আছে)। */
const express = require('express');
const { db } = require('./firebase');

const router = express.Router();
const docs = new Map();
let hanger = null, body = '', dirty = true, ready = false, readyAt = 0;
let markReady; const readyP = new Promise(r => { markReady = r; });

/* Firestore ভ্যালু → সাধারণ JSON (Timestamp → ISO স্ট্রিং, REST-এর মতোই) */
function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object') {
    if (typeof v.path === 'string' && v.firestore) return v.path;
    const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o;
  }
  return v;
}

function watchProducts() {
  let first = true;
  db.collection('products').onSnapshot(snap => {
    if (first) { first = false; const keep = new Set(snap.docs.map(d => d.id)); for (const id of [...docs.keys()]) if (!keep.has(id)) docs.delete(id); }
    snap.docChanges().forEach(c => {
      if (c.type === 'removed') docs.delete(c.doc.id);
      else docs.set(c.doc.id, Object.assign({ id: c.doc.id }, plain(c.doc.data())));
    });
    dirty = true; if (!ready) { ready = true; readyAt = Date.now(); markReady(); }
  }, err => { console.error('catalog products listener:', err.message); setTimeout(watchProducts, 10000); });
}
function watchHanger() {
  db.doc('settings/hanger').onSnapshot(s => { hanger = s.exists ? plain(s.data()) : null; dirty = true; },
    err => { console.error('catalog hanger listener:', err.message); setTimeout(watchHanger, 10000); });
}
if (process.env.CATALOG !== 'off') { watchProducts(); watchHanger(); }

router.get('/catalog', async (req, res) => {
  try {
    if (!ready) await Promise.race([readyP, new Promise(r => setTimeout(r, 8000))]);
    if (!ready) return res.status(503).json({ error: 'warming_up' });          // সাইট নিজে Firestore থেকে নেবে
    if (dirty) { body = JSON.stringify({ products: [...docs.values()], hanger, t: Date.now() }); dirty = false; }
    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    res.type('application/json').send(body);
  } catch (e) { res.status(500).json({ error: 'catalog_failed' }); }
});

module.exports = router;
