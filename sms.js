'use strict';
/* SMS সেন্ডার (OTP + টেস্ট) — BulkSMSBD / GreenWeb / Custom URL।
   Key গুলো Firestore-এর private/sms ডকে (শুধু অ্যাডমিন), সার্ভার Admin SDK দিয়ে পড়ে। চালু/বন্ধ সুইচ settings/sms.enabled */
const dns = require('dns').promises;
const net = require('net');
const { db } = require('./firebase');

let cache = { t: 0, pub: {}, priv: {} };
async function load(force) {
  if (!force && cache.t && Date.now() - cache.t < 20_000) return cache;
  const [a, b] = await Promise.all([db.doc('settings/sms').get(), db.doc('private/sms').get()]);
  cache = { t: Date.now(), pub: a.exists ? a.data() : {}, priv: b.exists ? b.data() : {} };
  return cache;
}
const configured = (p) => !!(p && (p.key || p.urlTemplate));
/* OTP তখনই চালু যখন সুইচ অন + সার্ভিসের তথ্য সেভ করা */
async function otpEnabled() { const c = await load(); return !!c.pub.enabled && configured(c.priv); }

/* SSRF সুরক্ষা: Custom URL শুধু https এবং পাবলিক ইন্টারনেটের ঠিকানায় */
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || /^::ffff:(127|10|0|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(x);
}
async function safeUrl(raw) {
  let u; try { u = new URL(raw); } catch (e) { throw new Error('SMS API URL ঠিক নয়'); }
  if (u.protocol !== 'https:') throw new Error('SMS API URL অবশ্যই https:// দিয়ে শুরু হতে হবে');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('এই SMS API ঠিকানা অনুমোদিত নয়');
  return u.toString();
}

async function sendSms(phone, text) {
  const { priv: p } = await load();
  if (!configured(p)) throw new Error('SMS সেটিং সেভ করা নেই');
  const e = encodeURIComponent, prov = p.provider || 'bulksmsbd';
  let url;
  if (prov === 'bulksmsbd') url = `https://bulksmsbd.net/api/smsapi?api_key=${e(p.key || '')}&type=text&number=${e('88' + phone)}&senderid=${e(p.sender || '')}&message=${e(text)}`;
  else if (prov === 'greenweb') url = `https://api.greenweb.com.bd/api.php?token=${e(p.key || '')}&to=${e(phone)}&message=${e(text)}`;
  else url = String(p.urlTemplate || '').replace(/\{(key|sender|phone88|phone|message)\}/g, (_, k) => e(k === 'key' ? (p.key || '') : k === 'sender' ? (p.sender || '') : k === 'phone88' ? '88' + phone : k === 'phone' ? phone : text));
  url = await safeUrl(url);
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const body = (await r.text()).slice(0, 300);
  if (!r.ok) throw new Error('SMS সার্ভিস HTTP ' + r.status);
  if (prov === 'bulksmsbd') {
    let j = {}; try { j = JSON.parse(body); } catch (x) { /* ignore */ }
    if (Number(j.response_code) !== 202) throw new Error('BulkSMSBD: ' + (j.error_message || j.message || body.slice(0, 120)));
  } else if (prov === 'greenweb') {
    if (!/^\s*ok/i.test(body) && !/"status"\s*:\s*"?(ok|success)/i.test(body)) throw new Error('GreenWeb: ' + body.slice(0, 120));
  }
  return true;
}

async function otpText(code) {
  const { priv: p } = await load();
  return String(p.message || 'Bana Fashion: আপনার ভেরিফিকেশন কোড {code}। কোডটি ১০ মিনিট পর্যন্ত বৈধ, কাউকে বলবেন না।').replace(/\{code\}/g, code);
}

module.exports = { sendSms, otpEnabled, otpText, load };
