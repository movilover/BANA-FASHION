'use strict';
/**
 * WhatsApp অর্ডার নোটিফিকেশন (সার্ভার-মোড, সবচেয়ে নিরাপদ)
 *
 *   GET  /api/wa-enabled   পাবলিক  — {enabled:true|false} (শুধু চালু আছে কি না; কোনো গোপন তথ্য নয়)
 *   POST /api/wa-notify    পাবলিক  — {orderId, image?}  → সার্ভার নিজে ডাটাবেস থেকে অর্ডার পড়ে মেসেজ বানিয়ে পাঠায়
 *   POST /api/wa           অ্যাডমিন — {action:'test'|'groups'}
 *
 * Token/গ্রুপ আইডি থাকে Firestore  private/whatsapp  এ (শুধু অ্যাডমিন পড়তে পারে):
 *   { enabled, provider:'whapi'|'ultramsg'|'meta', token, instance, target }
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { admin, db, requireAdmin, appCheckGuard } = require('../lib/firebase');
const { buildOrderText, checkOrder, shortCaption } = require('../lib/invoiceText');

const router = express.Router();
const TS = admin.firestore.Timestamp;
const T_OUT = 20000;

const lim = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'অনেক বেশি রিকোয়েস্ট — একটু পরে চেষ্টা করুন' } });

const getCfg = async () => { const s = await db.doc('private/whatsapp').get(); return s.exists ? s.data() : {}; };

async function jfail(r) {
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && (j.error.message || j.error)) || j.message || ('HTTP ' + r.status));
  return j;
}

/* ---------- প্রোভাইডার: টেক্সট অথবা ছবি+ক্যাপশন ---------- */
async function send(c, to, text, imgDataUrl) {
  const b64 = imgDataUrl ? String(imgDataUrl).split(',')[1] : '';
  const sig = () => AbortSignal.timeout(T_OUT);

  if (c.provider === 'ultramsg') {
    const base = `https://api.ultramsg.com/${encodeURIComponent(c.instance)}/messages/`;
    const f = new URLSearchParams({ token: c.token, to });
    if (b64) { f.set('image', b64); f.set('caption', text); return jfail(await fetch(base + 'image', { method: 'POST', body: f, signal: sig() })); }
    f.set('body', text);
    return jfail(await fetch(base + 'chat', { method: 'POST', body: f, signal: sig() }));
  }

  if (c.provider === 'meta') {              // Meta Cloud API — শুধু নম্বরে, গ্রুপে নয়
    const base = `https://graph.facebook.com/v20.0/${encodeURIComponent(c.instance)}`;
    const h = { Authorization: 'Bearer ' + c.token };
    if (b64) {
      const fd = new FormData();
      fd.append('messaging_product', 'whatsapp');
      fd.append('type', 'image/png');
      fd.append('file', new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' }), 'invoice.png');
      const up = await jfail(await fetch(base + '/media', { method: 'POST', headers: h, body: fd, signal: sig() }));
      return jfail(await fetch(base + '/messages', {
        method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, signal: sig(),
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { id: up.id, caption: text.slice(0, 1000) } })
      }));
    }
    return jfail(await fetch(base + '/messages', {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, signal: sig(),
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
    }));
  }

  /* ডিফল্ট: Whapi.Cloud */
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token };
  if (b64) return jfail(await fetch('https://gate.whapi.cloud/messages/image', { method: 'POST', headers: h, signal: sig(), body: JSON.stringify({ to, media: imgDataUrl, caption: text }) }));
  return jfail(await fetch('https://gate.whapi.cloud/messages/text', { method: 'POST', headers: h, signal: sig(), body: JSON.stringify({ to, body: text }) }));
}

async function sendOrder(c, to, text, img) {
  const short = text.length <= 1000;
  if (img) {
    try {
      await send(c, to, short ? text : shortCaption(text), img);
      if (!short) await send(c, to, text);
      return;
    } catch (e) { console.warn('[wa] ছবি যায়নি, শুধু টেক্সট যাচ্ছে:', e.message); }
  }
  await send(c, to, text);
}

/* ব্রাউজার থেকে আসা ছবি শুধু সত্যিকারের ছোট PNG হলে গ্রহণ করা হয় */
function safePng(s) {
  if (typeof s !== 'string' || !s.startsWith('data:image/png;base64,') || s.length > 3_800_000) return '';
  try {
    const head = Buffer.from(s.slice(22, 22 + 16), 'base64');
    return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 ? s : '';
  } catch (e) { return ''; }
}

/* ---------- পাবলিক: চালু আছে কি না ---------- */
router.get('/api/wa-enabled', lim(60_000, 60), async (req, res) => {
  try { const c = await getCfg(); res.set('Cache-Control', 'no-store').json({ enabled: !!(c.enabled && c.token && c.target) }); }
  catch (e) { res.json({ enabled: false }); }
});

/* ---------- পাবলিক: নতুন অর্ডার ---------- */
router.post('/api/wa-notify', lim(10 * 60_000, 20), appCheckGuard, express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const orderId = String((req.body || {}).orderId || '');
    if (!/^BF-[A-Z0-9]{4,20}$/.test(orderId)) return res.status(400).json({ error: 'bad request' });

    const c = await getCfg();
    if (!c.enabled || !c.token || !c.target) return res.json({ ok: true, skipped: true });

    const q = await db.collection('orders').where('orderId', '==', orderId).limit(1).get();
    if (q.empty) return res.status(404).json({ error: 'order not found' });
    const ref = q.docs[0].ref;

    /* একই অর্ডার দুবার যাওয়া ও পুরনো অর্ডারের রিপ্লে আটকানো */
    const state = await db.runTransaction(async (t) => {
      const d = await t.get(ref);
      const created = d.get('createdAt');
      if (created && Date.now() - created.toMillis() > 48 * 3600 * 1000) return 'old';
      const st = d.get('waState'), at = d.get('waAt');
      if (st === 'sent') return 'dup';
      if (st === 'sending' && at && Date.now() - at.toMillis() < 120000) return 'busy';
      t.update(ref, { waState: 'sending', waAt: TS.now() });
      return 'ok';
    });
    if (state !== 'ok') return res.json({ ok: true, skipped: state });

    try {
      const order = (await ref.get()).data();
      const text = buildOrderText(order, await checkOrder(db, order));
      await sendOrder(c, c.target, text, safePng((req.body || {}).image));
      await ref.update({ waState: 'sent', waAt: TS.now() });
      res.json({ ok: true });
    } catch (e) {
      await ref.update({ waState: 'failed', waAt: TS.now() }).catch(() => {});
      throw e;
    }
  } catch (e) {
    console.error('[wa-notify]', e.message);
    res.status(502).json({ error: 'send failed' });          // ভেতরের ভুলের বিবরণ পাবলিককে দেখানো হয় না
  }
});

/* ---------- অ্যাডমিন: টেস্ট / গ্রুপ লিস্ট ---------- */
router.post('/api/wa', lim(60_000, 30), requireAdmin, express.json({ limit: '20kb' }), async (req, res) => {
  try {
    const c = await getCfg();
    if (!c.token) return res.status(400).json({ error: 'আগে WhatsApp সেটিং সেভ করুন' });
    const action = String((req.body || {}).action || '');

    if (action === 'test') {
      if (!c.target) return res.status(400).json({ error: 'গ্রুপ Chat ID / নম্বর দিন' });
      await send(c, c.target, '✅ *BANA FASHION* — টেস্ট সফল!\nনতুন অর্ডার এলে ইনভয়েসসহ এই চ্যাটে অ্যালার্ট আসবে।');
      return res.json({ ok: true });
    }
    if (action === 'groups') {
      let groups = [];
      if (c.provider === 'meta') return res.status(400).json({ error: 'Meta Cloud API-তে গ্রুপ লিস্ট নেই — সরাসরি নম্বর দিন' });
      if (c.provider === 'ultramsg') {
        const j = await jfail(await fetch(`https://api.ultramsg.com/${encodeURIComponent(c.instance)}/groups?token=${encodeURIComponent(c.token)}`, { signal: AbortSignal.timeout(T_OUT) }));
        groups = (Array.isArray(j) ? j : j.groups || []).map(g => ({ id: g.id, name: g.name || g.subject }));
      } else {
        const j = await jfail(await fetch('https://gate.whapi.cloud/groups?count=100', { headers: { Authorization: 'Bearer ' + c.token }, signal: AbortSignal.timeout(T_OUT) }));
        groups = (j.groups || []).map(g => ({ id: g.id, name: g.name }));
      }
      return res.json({ groups });
    }
    res.status(400).json({ error: 'unknown action' });
  } catch (e) { console.error('[wa]', e.message); res.status(502).json({ error: e.message }); }
});

module.exports = router;
