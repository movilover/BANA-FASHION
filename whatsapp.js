'use strict';
/* WhatsApp সেন্ডার — Whapi.Cloud / UltraMsg / Meta Cloud API।
   টোকেন Firestore-এর private/whatsapp ডকে থাকে (শুধু অ্যাডমিন পড়তে পারে; সার্ভার Admin SDK দিয়ে পড়ে)। */
const { db } = require('./firebase');

let cache = { t: 0, v: null };
async function getConfig(force) {
  if (!force && cache.v && Date.now() - cache.t < 30_000) return cache.v;
  const s = await db.doc('private/whatsapp').get();
  cache = { t: Date.now(), v: s.exists ? s.data() : {} };
  return cache.v;
}
const invalidate = () => { cache = { t: 0, v: null }; };

async function http(url, opt = {}) {
  const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(20_000) });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt.slice(0, 300) }; }
  if (!r.ok) {
    const msg = (j.error && (j.error.message || j.error)) || j.message || j.raw || ('HTTP ' + r.status);
    throw new Error(String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 250));
  }
  return j;
}
const json = (token, body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
});

function need(cfg) {
  if (!cfg || !cfg.token) throw new Error('WhatsApp API Token সেভ করা নেই (Admin > Settings)');
  if (!cfg.target) throw new Error('WhatsApp গ্রুপ/নম্বর সেভ করা নেই (Admin > Settings)');
}

async function sendText(cfg, text) {
  need(cfg);
  const to = cfg.target, p = cfg.provider || 'whapi';
  if (p === 'whapi') return http('https://gate.whapi.cloud/messages/text', json(cfg.token, { to, body: text }));
  if (p === 'ultramsg') return http(`https://api.ultramsg.com/${encodeURIComponent(cfg.instance)}/messages/chat`, json(null, { token: cfg.token, to, body: text }));
  if (p === 'meta') return http(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.instance)}/messages`,
    json(cfg.token, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }));
  throw new Error('অজানা WhatsApp সার্ভিস');
}

/* dataUrl = "data:image/png;base64,...." */
async function sendImage(cfg, dataUrl, caption) {
  need(cfg);
  const to = cfg.target, p = cfg.provider || 'whapi';
  if (p === 'whapi') return http('https://gate.whapi.cloud/messages/image', json(cfg.token, { to, media: dataUrl, caption }));
  if (p === 'ultramsg') return http(`https://api.ultramsg.com/${encodeURIComponent(cfg.instance)}/messages/image`, json(null, { token: cfg.token, to, image: dataUrl, caption }));
  if (p === 'meta') {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', m[1]);
    fd.append('file', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'invoice.' + m[1].split('/')[1]);
    const up = await http(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.instance)}/media`, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token }, body: fd });
    return http(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.instance)}/messages`,
      json(cfg.token, { messaging_product: 'whatsapp', to, type: 'image', image: { id: up.id, caption } }));
  }
  throw new Error('অজানা WhatsApp সার্ভিস');
}

async function listGroups(cfg) {
  if (!cfg || !cfg.token) throw new Error('WhatsApp API Token সেভ করা নেই (আগে সেভ করুন)');
  const p = cfg.provider || 'whapi';
  if (p === 'whapi') {
    const j = await http('https://gate.whapi.cloud/groups?count=100', { headers: { Authorization: 'Bearer ' + cfg.token } });
    return (j.groups || []).map((g) => ({ id: g.id, name: g.name }));
  }
  if (p === 'ultramsg') {
    const j = await http(`https://api.ultramsg.com/${encodeURIComponent(cfg.instance)}/groups?token=${encodeURIComponent(cfg.token)}`);
    return (Array.isArray(j) ? j : []).map((g) => ({ id: g.id, name: g.name }));
  }
  throw new Error('Meta Cloud API-তে গ্রুপ লিস্ট সাপোর্ট নেই — শুধু নম্বর ব্যবহার করুন');
}

module.exports = { getConfig, invalidate, sendText, sendImage, listGroups };
