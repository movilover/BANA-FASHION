'use strict';
/* অর্ডারের দাম/মোট যাচাই (সিকিউরিটি রিভিউ v2)।
   ক্লায়েন্টের দাম বিশ্বাস না করে প্রোডাক্টের আসল দামের সাথে মেলায়।
   গরমিল পেলে অর্ডার আটকায় না; WhatsApp অ্যালার্টে ⚠ সতর্কতা যোগ হয়। Firestore Rules এখন একই কাজ আগেই করে — এটি দ্বিতীয় স্তর। */
const { db, cfg } = require('./firebase');
const { money, waSafe } = require('./bn');

/* Firestore Rules-এর ডিফল্টের সাথে এক */
const SHIP_DEFAULT = { dhaka: 80, outside: 150 };
const DOC_ID_RE = /^[^/]{1,100}$/;

async function checkOrder(o) {
  const flags = [];
  try {
    const items = Array.isArray(o.items) ? o.items.slice(0, 50) : [];
    const ids = [...new Set(items
      .map(i => String((i && i.id) || ''))
      .filter(id => DOC_ID_RE.test(id) && id !== '.' && id !== '..'))];

    const priceOf = new Map();
    if (ids.length) {
      const snaps = await db.getAll(...ids.map(id => db.collection('products').doc(id)));
      snaps.forEach(s => priceOf.set(s.id, s.exists ? Number((s.data() || {}).price) : null));
    }

    for (const i of items) {
      const id = String((i && i.id) || '');
      const title = waSafe(i && i.title, 50);
      if (!priceOf.has(id)) { flags.push(`পণ্যের আইডি ঠিক নয়: ${title}`); continue; }
      const cur = priceOf.get(id);
      if (cur === null) flags.push(`পণ্য ডাটাবেসে নেই: ${title}`);
      else if (Number.isFinite(cur) && Math.abs(cur - Number(i.price)) > 0.5)
        flags.push(`দাম মিলছে না: ${title} (অর্ডারে ${money(i.price)}, বর্তমানে ${money(cur)})`);
    }

    const sum = items.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.qty) || 0), 0);
    if (Math.abs(sum - Number(o.subtotal || 0)) > 0.5)
      flags.push(`সাবটোটাল (${money(o.subtotal)}) পণ্যের যোগফলের (${money(sum)}) সাথে মেলে না`);

    if (Number(o.discount || 0) > 0 && !o.promo)
      flags.push(`প্রোমো কোড ছাড়াই ডিসকাউন্ট ${money(o.discount)}`);

    const st = await cfg('settings/site').catch(() => ({}));
    const free = Number(st.freeShip || 0);
    const base = o.area === 'dhaka'
      ? Number(st.shipDhaka ?? SHIP_DEFAULT.dhaka)
      : Number(st.shipOutside ?? SHIP_DEFAULT.outside);
    const expect = (free > 0 && Number(o.subtotal || 0) >= free) ? 0 : base;
    if (Number(o.delivery || 0) < expect - 0.5)
      flags.push(`ডেলিভারি চার্জ কম (অর্ডারে ${money(o.delivery)}, সেটিংসে ${money(expect)}) — যাচাই করুন`);
  } catch (e) {
    console.warn('checkOrder:', e.message);
  }
  return flags;
}

module.exports = { checkOrder };
