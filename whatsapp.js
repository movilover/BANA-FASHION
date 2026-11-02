'use strict';
/* WhatsApp প্রোভাইডার: Whapi.Cloud / UltraMsg / Meta Cloud API */

async function http(url, opt = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opt.timeout || 15000);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'WhatsApp সার্ভিস সময়মতো সাড়া দেয়নি' : 'WhatsApp সার্ভিসে সংযোগ যায়নি');
  } finally { clearTimeout(t); }
}
const errMsg = r => {
  const j = r.json || {};
  const m = (j.error && (j.error.message || j.error)) || j.message || (r.text || '').slice(0, 160) || ('HTTP ' + r.status);
  return String(m).slice(0, 200);
};
const form = o => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const enc = encodeURIComponent;
const isGroup = t => /@g\.us$/.test(String(t));
const digits = t => String(t).replace(/\D/g, '');

function need(c) {
  if (!c || !c.token) throw new Error('WhatsApp টোকেন সেট করা নেই');
  if (c.provider === 'ultramsg' && !c.instance) throw new Error('UltraMsg Instance ID দিন');
  if (c.provider === 'meta' && !c.instance) throw new Error('Meta Phone Number ID দিন');
}

async function sendText(c, to, text) {
  need(c);
  const p = c.provider || 'whapi';
  let r;
  if (p === 'whapi') {
    r = await http('https://gate.whapi.cloud/messages/text', { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ to, body: text }) });
    if (!r.ok || (r.json && r.json.sent === false)) throw new Error(errMsg(r));
  } else if (p === 'ultramsg') {
    r = await http(`https://api.ultramsg.com/${enc(c.instance)}/messages/chat`, { method: 'POST', headers: FORM, body: form({ token: c.token, to: isGroup(to) ? to : '+' + digits(to), body: text }) });
    if (!r.ok || !r.json || r.json.error) throw new Error(errMsg(r));
  } else if (p === 'meta') {
    if (isGroup(to)) throw new Error('Meta Cloud API তে গ্রুপে পাঠানো যায় না — নম্বর দিন');
    r = await http(`https://graph.facebook.com/v19.0/${enc(c.instance)}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text, preview_url: false } }) });
    if (!r.ok || (r.json && r.json.error)) throw new Error(errMsg(r));
  } else throw new Error('অজানা WhatsApp সার্ভিস');
  return true;
}

/* dataUrl = data:image/png;base64,... */
async function sendImage(c, to, dataUrl, caption) {
  need(c);
  const p = c.provider || 'whapi';
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new Error('ছবির ফরম্যাট ঠিক নয়');
  let r;
  if (p === 'whapi') {
    r = await http('https://gate.whapi.cloud/messages/image', { method: 'POST', timeout: 30000, headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ to, media: dataUrl, caption }) });
    if (!r.ok || (r.json && r.json.sent === false)) throw new Error(errMsg(r));
  } else if (p === 'ultramsg') {
    r = await http(`https://api.ultramsg.com/${enc(c.instance)}/messages/image`, { method: 'POST', timeout: 30000, headers: FORM, body: form({ token: c.token, to: isGroup(to) ? to : '+' + digits(to), image: dataUrl, caption }) });
    if (!r.ok || !r.json || r.json.error) throw new Error(errMsg(r));
  } else if (p === 'meta') {
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp'); fd.append('type', m[1]);
    fd.append('file', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'invoice.' + (m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg'));
    const up = await http(`https://graph.facebook.com/v19.0/${enc(c.instance)}/media`, { method: 'POST', timeout: 30000, headers: { Authorization: 'Bearer ' + c.token }, body: fd });
    if (!up.ok || !up.json || !up.json.id) throw new Error(errMsg(up));
    r = await http(`https://graph.facebook.com/v19.0/${enc(c.instance)}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'image', image: { id: up.json.id, caption } }) });
    if (!r.ok || (r.json && r.json.error)) throw new Error(errMsg(r));
  } else throw new Error('অজানা WhatsApp সার্ভিস');
  return true;
}

async function listGroups(c) {
  need(c);
  const p = c.provider || 'whapi';
  if (p === 'whapi') {
    const r = await http('https://gate.whapi.cloud/groups?count=200', { headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/json' }, timeout: 25000 });
    if (!r.ok) throw new Error(errMsg(r));
    return ((r.json && r.json.groups) || []).map(g => ({ id: g.id, name: g.name || g.id }));
  }
  if (p === 'ultramsg') {
    const r = await http(`https://api.ultramsg.com/${enc(c.instance)}/groups?${form({ token: c.token })}`, { timeout: 25000 });
    if (!r.ok) throw new Error(errMsg(r));
    const a = Array.isArray(r.json) ? r.json : (r.json && r.json.groups) || [];
    return a.map(g => ({ id: g.id, name: g.name || g.subject || g.id }));
  }
  throw new Error('এই সার্ভিসে গ্রুপ লিস্ট পাওয়া যায় না — সরাসরি নম্বর দিন');
}

module.exports = { sendText, sendImage, listGroups };
