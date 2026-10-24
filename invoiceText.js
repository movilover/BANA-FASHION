'use strict';
/**
 * অর্ডারের WhatsApp মেসেজ সার্ভারে বানানো হয় — ডাটাবেসে সেভ হওয়া অর্ডার থেকে।
 * (ব্রাউজার থেকে পাঠানো কোনো টেক্সট বিশ্বাস করা হয় না, তাই কেউ গ্রুপে ভুয়া মেসেজ ঢোকাতে পারবে না।)
 * সাথে প্রতিটি পণ্যের দাম products কালেকশনের সাথে মিলিয়ে দেখা হয়; অসঙ্গতি থাকলে ⚠️ সতর্কতা যোগ হয়।
 */
const { DBN, DVBN, BT, BNUM, INV_PAY } = require('./bn');

/* WhatsApp-এর *bold* _italic_ ~strike~ ``` চিহ্ন গ্রাহকের লেখা থেকে সরানো হয় + বাড়তি লাইন/স্পেস মুছে ফেলা হয় */
const clean = (s, max = 300) => String(s == null ? '' : s).replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/* বাংলাদেশ সময়ে "DD/MM/YYYY, HH:MM AM/PM" */
function stamp(d) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true
  }).formatToParts(d || new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute} ${String(p.dayPeriod || '').toUpperCase()}`;
}

/* দাম ও হিসাব যাচাই (শুধু সতর্কতা দেয়, অর্ডার আটকায় না) */
async function checkOrder(db, o) {
  const issues = [];
  const items = Array.isArray(o.items) ? o.items : [];
  let sum = 0;
  const ids = [...new Set(items.map(i => String(i && i.id || '')).filter(x => x && !x.includes('/')))].slice(0, 50);
  const prices = {};
  try {
    if (ids.length) {
      const snaps = await db.getAll(...ids.map(id => db.collection('products').doc(id)));
      snaps.forEach(s => { if (s.exists) prices[s.id] = Number(s.get('price')); });
    }
  } catch (e) { issues.push('পণ্যের দাম যাচাই করা যায়নি'); }

  for (const i of items) {
    const q = Number(i.qty), pr = Number(i.price);
    if (!Number.isFinite(q) || q < 1 || q > 100 || !Number.isFinite(pr) || pr < 0) { issues.push(`"${clean(i.title, 40)}" — পরিমাণ/দাম অস্বাভাবিক`); continue; }
    sum += pr * q;
    if (ids.length && prices[String(i.id)] === undefined) issues.push(`"${clean(i.title, 40)}" — পণ্যটি ডাটাবেসে পাওয়া যায়নি`);
    else if (prices[String(i.id)] !== undefined && prices[String(i.id)] !== pr)
      issues.push(`"${clean(i.title, 40)}" — অর্ডারে ${BT(pr)}, কিন্তু আসল দাম ${BT(prices[String(i.id)])}`);
  }
  if (Math.round(sum) !== Math.round(Number(o.subtotal) || 0)) issues.push(`সাবটোটাল (${BT(o.subtotal)}) পণ্যের যোগফলের (${BT(sum)}) সাথে মিলছে না`);
  const exp = (Number(o.subtotal) || 0) - (Number(o.discount) || 0) + (Number(o.delivery) || 0);
  if (Math.round(exp) !== Math.round(Number(o.total) || 0)) issues.push(`সর্বমোট (${BT(o.total)}) হিসাবের সাথে (${BT(exp)}) মিলছে না`);
  return issues;
}

function buildOrderText(o, issues = []) {
  const pay = o.pay || null, items = Array.isArray(o.items) ? o.items : [];
  const delivery = Number(o.delivery) || 0, total = Number(o.total) || 0;
  const due = Math.max(0, total - (pay ? delivery : 0));
  const dist = DBN[o.district] || o.district || '';
  const ph = String(o.phone || '').replace(/\D/g, '');
  const when = stamp(o.createdAt && o.createdAt.toDate ? o.createdAt.toDate() : new Date());
  const geo = o.geo && Number.isFinite(+o.geo.lat) && Number.isFinite(+o.geo.lng) ? o.geo : null;

  const L = [
    '🛍 *নতুন অর্ডার — BANA FASHION*',
    '🕒 আজকের তারিখ ও সময়: *' + when + '*',
    '🆔 অর্ডার আইডি: *' + clean(o.orderId, 30) + '*', '',
    '👤 *' + clean(o.customerName, 100) + '*',
    '📞 ' + ph,
    '📍 ' + clean(o.address, 500) + (o.upazila ? ', ' + clean(o.upazila, 60) : ''),
    '🏙 জেলা: *' + clean(dist, 60) + '*' + (o.division ? ' (' + clean(DVBN[o.division] || o.division, 40) + ' বিভাগ)' : ''),
    ...(o.note ? ['📝 নোট: ' + clean(o.note, 500)] : []),
    ...(geo ? ['🗺 https://www.google.com/maps?q=' + (+geo.lat) + ',' + (+geo.lng)] : []), '',
    ...items.slice(0, 50).map(i => '• ' + clean(i.title, 80) + ' (' + clean(i.size, 20) + ') — ' + BT(i.price) + ' × ' + BNUM(Number(i.qty) || 0) + ' = *' + BT((Number(i.price) || 0) * (Number(i.qty) || 0)) + '*'), '',
    'সাবটোটাল: ' + BT(o.subtotal) + (o.discount ? '\nডিসকাউন্ট: -' + BT(o.discount) : '') + '\nডেলিভারি: ' + (delivery ? BT(delivery) : 'ফ্রি'),
    '💰 *সর্বমোট: ' + BT(total) + '*', '',
    pay
      ? '✅ *ডেলিভারি চার্জ অনলাইনে পরিশোধিত* (' + (INV_PAY[pay.method] || clean(pay.method, 20)) + ', ' + BT(pay.amount) + ')\n🔖 ট্রানজেকশন আইডি: *' + clean(pay.trxId, 30) + '*\n📲 সেন্ডার নম্বর: ' + clean(pay.sender, 20) + '\n⚠️ ট্রানজেকশন যাচাই বাকি'
      : (delivery ? '❌ ডেলিভারি চার্জ অনলাইনে পরিশোধ হয়নি (ক্যাশ অন ডেলিভারি)' : '🎁 ফ্রি ডেলিভারি'),
    '💵 ক্যাশ অন ডেলিভারিতে নেবেন: *' + BT(due) + '*', '',
    '💬 কাস্টমারকে মেসেজ: https://wa.me/88' + ph
  ];
  if (issues.length) L.push('', '🚨 *সতর্কতা — যাচাইয়ে অসঙ্গতি (কনফার্মের আগে দেখে নিন):*', ...issues.slice(0, 8).map(x => '• ' + x));
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ছবির ক্যাপশন ১০২৪ অক্ষর পর্যন্ত — বড় হলে ছোট ক্যাপশন + আলাদা পূর্ণ মেসেজ */
const shortCaption = t => t.split('\n').slice(0, 6).join('\n');

module.exports = { buildOrderText, checkOrder, shortCaption, stamp, clean };
