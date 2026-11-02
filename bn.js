'use strict';
/* বাংলা/ফোন/টাকা/তারিখ হেল্পার */
const BN = '০১২৩৪৫৬৭৮৯';
const toEn = s => String(s == null ? '' : s).replace(/[০-৯]/g, d => String(BN.indexOf(d)));
const toBn = s => String(s == null ? '' : s).replace(/\d/g, d => BN[d]);
const money = n => '৳' + toBn(Math.round(Number(n) || 0).toLocaleString('en-US'));

/* 017xxxxxxxx / +88017xxxxxxxx / ০১৭… → 017xxxxxxxx (ভুল হলে '') */
function normPhone(v) {
  let d = toEn(v).replace(/\D/g, '');
  if (d.startsWith('88') && d.length === 13) d = d.slice(2);
  return /^01[3-9]\d{8}$/.test(d) ? d : '';
}
const maskPhone = p => (p ? p.slice(0, 3) + '••••' + p.slice(-2) : '');

const seg = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('bn', { granularity: 'grapheme' }) : null;
const graphemes = s => (seg ? Array.from(seg.segment(s), x => x.segment) : Array.from(s));
function maskName(n) {
  n = String(n || '').trim();
  if (!n) return '';
  return n.split(/\s+/).map(w => { const g = graphemes(w); return g.length <= 1 ? w : g[0] + '•'.repeat(Math.min(g.length - 1, 4)); }).join(' ');
}

/* ব্যবহারকারীর লেখা টেক্সট পরিষ্কার: কন্ট্রোল ক্যারেক্টার বাদ + দৈর্ঘ্য সীমা */
const clean = (s, max = 200) => String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/* WhatsApp ফরম্যাটিং (* _ ~ `) ভাঙা আটকায় */
const waSafe = (s, max = 200) => clean(s, max).replace(/[*_~`]/g, '');

const toDate = v => {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  const d = new Date(v);
  return isNaN(d) ? null : d;
};
function dateBn(v) {
  const d = toDate(v) || new Date();
  try {
    return new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  } catch (e) { return d.toISOString(); }
}
const iso = v => { const d = toDate(v); return d ? d.toISOString() : null; };

module.exports = { toEn, toBn, money, normPhone, maskPhone, maskName, clean, waSafe, toDate, dateBn, iso };
