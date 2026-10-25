'use strict';
/* GET /api/products — ক্যাটালগ সার্ভারে ক্যাশ (৬০ সেকেন্ড) + ETag/304।
   হাজার হাজার ভিজিটর এলেও Firestore রিড মাত্র মিনিটে ১ বার। */
const router = require('express').Router();
const { db, Timestamp } = require('../lib/firebase');

const TTL = 60_000;
let cache = { t: 0, body: null, pending: null };

const plain = (v) => {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o; }
  return v;
};

async function load() {
  const snap = await db.collection('products').get();
  const items = snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }));
  return JSON.stringify({ items });
}

router.get('/products', async (req, res) => {
  try {
    if (!cache.body || Date.now() - cache.t > TTL) {
      cache.pending = cache.pending || load().finally(() => { cache.pending = null; });
      cache.body = await cache.pending; cache.t = Date.now();
    }
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.type('application/json').send(cache.body); // Express নিজেই ETag/304 হ্যান্ডেল করে
  } catch (e) {
    console.error('products:', e.message);
    if (cache.body) return res.type('application/json').send(cache.body); // পুরোনো ক্যাশই ভালো
    res.status(502).json({ error: 'ক্যাটালগ লোড করা যায়নি' });
  }
});

module.exports = router;
