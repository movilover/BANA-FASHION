'use strict';
/* POST /api/upload — অ্যাডমিন: ছবি ImgBB-তে আপলোড (প্রক্সি)।
   ব্রাউজার আর সরাসরি ImgBB-তে যায় না: শুধু লগইন-করা অ্যাডমিন আপলোড করতে পারে, ফাইল যাচাই হয় (ধরন/ম্যাজিক বাইট/সাইজ),
   Key সার্ভারে private/imgbb থেকে আসে (URL-এ ব্রাউজারের লগে যায় না)। */
const router = require('express').Router();
const { db } = require('./firebase');
const { requireAdmin } = require('./auth');

const MAX_BYTES = 10 * 1024 * 1024;
let kc = { t: 0, v: null };
async function savedKey() {
  if (kc.v && Date.now() - kc.t < 30_000) return kc.v;
  const s = await db.doc('private/imgbb').get(); const d = s.exists ? s.data() : {};
  kc = { t: Date.now(), v: d.enabled === false ? '' : String(d.key || '').trim() };
  return kc.v;
}
function kind(b) {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return '';
}

router.post('/upload', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(b.image || ''));
    if (!m) return res.status(400).json({ error: 'bad_image', message: 'ছবির ফরম্যাট সঠিক নয় (PNG/JPG/WEBP/GIF)' });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_BYTES) return res.status(400).json({ error: 'too_big', message: 'ছবি ১০ MB-এর বেশি বড়' });
    if (!kind(buf)) return res.status(400).json({ error: 'bad_image', message: 'এটা আসল ছবি ফাইল নয়' });

    const test = typeof b.key === 'string' && /^[A-Za-z0-9]{16,64}$/.test(b.key.trim()) ? b.key.trim() : ''; // "কানেকশন টেস্ট"-এর জন্য, সেভের আগে
    const key = test || await savedKey();
    if (!key) return res.status(400).json({ error: 'no_key', message: 'ImgBB API Key সেভ করা নেই বা বন্ধ আছে' });
    const exp = Number.isInteger(b.exp) && b.exp >= 60 && b.exp <= 15552000 ? b.exp : 0;
    const name = String(b.name || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);

    const fd = new FormData();
    fd.append('image', m[2].replace(/[\r\n]/g, ''));
    if (name) fd.append('name', name);
    const r = await fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(key) + (exp ? '&expiration=' + exp : ''), {
      method: 'POST', body: fd, signal: AbortSignal.timeout(45_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      const msg = String((j.error && j.error.message) || ('ImgBB HTTP ' + r.status)).slice(0, 200);
      return res.status(r.status === 400 || r.status === 403 ? 400 : 502).json({ error: 'imgbb', message: msg });
    }
    const d = j.data || {};
    res.json({ url: d.url || (d.image && d.image.url) || d.display_url });
  } catch (e) {
    console.error('upload:', e.message);
    res.status(502).json({ error: 'upload_failed', message: e.name === 'TimeoutError' ? 'সময় শেষ (ইন্টারনেট স্লো)' : 'ImgBB-র সাথে যোগাযোগ করা যায়নি' });
  }
});

module.exports = router;
