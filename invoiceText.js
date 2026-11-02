'use strict';
/* নতুন অর্ডারের WhatsApp মেসেজের লেখা */
const { toBn, money, waSafe, dateBn } = require('./bn');

function orderText(o, flags = []) {
  const items = Array.isArray(o.items) ? o.items.slice(0, 50) : [];
  const place = [o.upazila, o.district, o.division].filter(Boolean).map(x => waSafe(x, 40)).join(', ');
  const cod = (o.pay && o.deliveryPaid) ? (Number(o.subtotal || 0) - Number(o.discount || 0)) : Number(o.total || 0);
  const L = [];
  L.push(`🛍️ *নতুন অর্ডার — ${waSafe(o.orderId, 24)}*`);
  L.push(`🕒 ${dateBn(o.createdAt)}`);
  L.push('');
  L.push(`👤 ${waSafe(o.customerName, 100)}`);
  L.push(`📞 ${waSafe(o.phone, 20)}`);
  L.push(`📍 ${waSafe(o.address, 300)}${place ? ', ' + place : ''} (${o.area === 'dhaka' ? 'ঢাকার ভিতরে' : 'ঢাকার বাইরে'})`);
  if (o.note) L.push(`📝 নোট: ${waSafe(o.note, 300)}`);
  L.push('');
  L.push('*পণ্য:*');
  items.forEach((i, n) => L.push(`${toBn(n + 1)}. ${waSafe(i.title, 80)} | সাইজ: ${waSafe(i.size || '-', 20)} | ×${toBn(Number(i.qty) || 1)} | ${money((Number(i.price) || 0) * (Number(i.qty) || 1))}`));
  L.push('');
  L.push(`সাবটোটাল: ${money(o.subtotal)}`);
  if (Number(o.discount) > 0) L.push(`ডিসকাউন্ট${o.promo && o.promo.code ? ' (' + waSafe(o.promo.code, 40) + ')' : ''}: -${money(o.discount)}`);
  L.push(`ডেলিভারি: ${Number(o.delivery) > 0 ? money(o.delivery) : 'ফ্রি'}`);
  L.push(`*মোট: ${money(o.total)}*`);
  L.push(`💳 পেমেন্ট: ${waSafe(o.payment || 'Cash on Delivery', 100)}`);
  if (o.pay) L.push(`   ${waSafe(o.pay.method, 10)} | প্রেরক: ${waSafe(o.pay.sender, 15)} | TrxID: ${waSafe(o.pay.trxId, 24)} | ${money(o.pay.amount)} (যাচাই বাকি)`);
  L.push(`💵 COD (ক্যাশ কালেকশন): *${money(cod)}*`);
  if (flags.length) { L.push(''); L.push('⚠️ *সতর্কতা — বুকিংয়ের আগে যাচাই করুন:*'); flags.slice(0, 6).forEach(f => L.push('• ' + f)); }
  return L.join('\n');
}
module.exports = { orderText };
