'use strict';
/* GET  /api/wa-enabled   — পাবলিক: শুধু চালু/বন্ধ জানায় (টোকেন নয়)
   POST /api/wa-notify    — কাস্টমার: নতুন অর্ডারের পর WhatsApp অ্যালার্ট (সার্ভার অর্ডার নিজে পড়ে মেসেজ বানায়)
   POST /api/wa           — অ্যাডমিন: test / groups */
const router = require('express').Router();
const { db } = require('../lib/firebase');
const { requireUser, requireAdmin, appCheck } = require('../lib/auth');
const wa = require('../lib/whatsapp');

const ORDER_ID = /^BF-[A-Z0-9]{4,20}$/;
const money = (n) => '৳' + Math.round(Number(n) || 0).toLocaleString('en-US');
const dhakaTime = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(new Date()).toUpperCase();

router.get('/wa-enabled', async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ enabled: !!(await wa.getConfig()).enabled }); }
  catch (e) { res.json({ enabled: false }); }
});

/* দাম মিলিয়ে দেখে — rules শুধু যোগফল মেলায়, প্রোডাক্টের আসল দাম নয়। অমিল পেলে অ্যাডমিনকে সতর্ক করে */
async function priceWarnings(items) {
  try {
    const refs = [...new Set(items.map((i) => i.id))].slice(0, 50).map((id) => db.collection('products').doc(String(id)));
    const snaps = await db.getAll(...refs);
    const price = {}; snaps.forEach((s) => { if (s.exists) price[s.id] = Number(s.data().price); });
    return items.filter((i) => price[i.id] != null && Math.abs(price[i.id] - Number(i.price)) > 0.5)
      .map((i) => `⚠️ দাম অমিল: ${i.title} — অর্ডারে ${money(i.price)}, সাইটে ${money(price[i.id])}`);
  } catch (e) { return []; }
}

async function buildMessage(o) {
  const addr = [o.address, o.upazila, o.district, o.division].filter(Boolean).join(', ');
  const cod = (o.pay && o.deliveryPaid) ? o.subtotal - (o.discount || 0) : o.total;
  const warn = await priceWarnings(o.items || []);
  return [
    '🛍️ *নতুন অর্ডার — BANA FASHION*',
    '🆔 ' + o.orderId,
    '🕒 ' + dhakaTime(),
    '',
    '👤 ' + o.customerName,
    '📞 ' + o.phone,
    '📍 ' + addr,
    o.geo ? '🗺️ https://www.google.com/maps?q=' + Number(o.geo.lat) + ',' + Number(o.geo.lng) : null,
    o.note ? '📝 ' + o.note : null,
    '',
    ...(o.items || []).map((i) => `• ${i.title}${i.size ? ' (' + i.size + ')' : ''} × ${i.qty} = ${money(i.price * i.qty)}`),
    '',
    'সাবটোটাল: ' + money(o.subtotal),
    o.discount ? `ডিসকাউন্ট${o.promo && o.promo.code ? ' (' + o.promo.code + ')' : ''}: -${money(o.discount)}` : null,
    'ডেলিভারি: ' + (o.delivery ? money(o.delivery) : 'ফ্রি'),
    '*মোট: ' + money(o.total) + '*',
    o.pay ? `💳 ডেলিভারি চার্জ: ${o.pay.method} • ${o.pay.sender} • TrxID ${o.pay.trxId} (যাচাই বাকি)` : null,
    '💵 কুরিয়ারে COD: ' + money(cod),
    ...(warn.length ? ['', ...warn] : []),
  ].filter((x) => x !== null).join('\n');
}

router.post('/wa-notify', appCheck, requireUser, async (req, res) => {
  try {
    const { orderId, image } = req.body || {};
    if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return res.status(400).json({ error: 'অর্ডার আইডি সঠিক নয়' });
    const cfg = await wa.getConfig();
    if (!cfg.enabled) return res.json({ ok: true, skipped: 'disabled' });

    const q = await db.collection('orders').where('orderId', '==', orderId).limit(1).get();
    if (q.empty) return res.status(404).json({ error: 'অর্ডার পাওয়া যায়নি' });
    const ref = q.docs[0].ref, o = q.docs[0].data();
    if (o.uid !== req.user.uid) return res.status(403).json({ error: 'এই অর্ডার আপনার নয়' });
    const created = o.createdAt && o.createdAt.toMillis ? o.createdAt.toMillis() : 0;
    if (!created || Date.now() - created > 48 * 3600_000) return res.status(410).json({ error: 'অর্ডারটি অনেক পুরোনো' });

    /* একই অর্ডারের মেসেজ দুবার যাবে না (retry/ডাবল-ক্লিক) */
    const st = await db.runTransaction(async (tx) => {
      const s = (await tx.get(ref)).data();
      if (s.waState === 'sent') return 'done';
      if (s.waState === 'sending' && Date.now() - (s.waAt || 0) < 120_000) return 'busy';
      tx.update(ref, { waState: 'sending', waAt: Date.now() });
      return 'go';
    });
    if (st !== 'go') return res.json({ ok: true, skipped: st });

    try {
      await wa.sendText(cfg, await buildMessage(o));
      let img = false;
      if (typeof image === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image) && image.length < 3_000_000) {
        try { await wa.sendImage(cfg, image, '🧾 ইনভয়েস ' + orderId); img = true; } catch (e) { console.warn('wa image:', e.message); }
      }
      await ref.update({ waState: 'sent', waAt: Date.now(), waImg: img, waErr: null });
      res.json({ ok: true, image: img });
    } catch (e) {
      await ref.update({ waState: 'failed', waAt: Date.now(), waErr: String(e.message).slice(0, 200) }).catch(() => {});
      console.error('wa-notify:', e.message);
      res.status(502).json({ error: 'WhatsApp পাঠানো যায়নি' });
    }
  } catch (e) {
    console.error('wa-notify:', e.message);
    res.status(500).json({ error: 'সার্ভার ত্রুটি' });
  }
});

router.post('/wa', requireAdmin, async (req, res) => {
  try {
    const cfg = await wa.getConfig(true);
    const action = (req.body || {}).action;
    if (action === 'test') { await wa.sendText(cfg, '✅ BANA FASHION — টেস্ট মেসেজ সফল! ' + dhakaTime()); return res.json({ ok: true }); }
    if (action === 'groups') return res.json({ groups: await wa.listGroups(cfg) });
    res.status(400).json({ error: 'অজানা action' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
