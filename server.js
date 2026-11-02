'use strict';
/* BANA FASHION — Railway সার্ভার: সাইট (index.html / অ্যাডমিন) + /api (Steadfast, WhatsApp, SMS OTP, অর্ডার খোঁজা) */
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

require('./firebase');   // শুরুতেই ক্রেডেনশিয়াল যাচাই — ভুল থাকলে সার্ভার চালুই হবে না (লগে কারণ দেখাবে)

const app = express();
const ROOT = __dirname;
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(helmet({
  contentSecurityPolicy: false,          // সাইটে inline স্ক্রিপ্ট/CDN আছে; CSP বসালে ভেঙে যেতে পারে
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,        // Google লগইন পপআপের জন্য
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: { action: 'sameorigin' },
  hsts: { maxAge: 31536000 },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use((req, res, next) => { res.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()'); next(); });
app.use(compression());

/* ---- CORS: একই ডোমেইন বা ALLOWED_ORIGINS-এর তালিকা ---- */
const ALLOWED = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const origin = req.get('origin');
  if (origin) {
    let sameHost = false; try { sameHost = new URL(origin).host === req.get('host'); } catch (e) {}
    if (!sameHost && !ALLOWED.includes(origin)) return res.status(403).json({ error: 'forbidden_origin', message: 'এই ডোমেইনের অনুমতি নেই' });
    res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Firebase-AppCheck', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message: 'অনেক বেশি অনুরোধ — একটু পরে চেষ্টা করুন' } }));

/* ---- API ---- */
app.use('/api', require('./wa'));
app.use('/api', require('./sms'));
app.use('/api', require('./orders'));
app.use('/api', require('./steadfast'));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'এই API নেই' }));

/* ---- স্ট্যাটিক: শুধু অনুমোদিত ফাইল। .env, server.js, package.json, *.js কখনোই পাবলিক হবে না ---- */
const ADMIN_FILE = [process.env.ADMIN_FILE, 'admin.html', 'admin__3_.html'].filter(Boolean).find(f => fs.existsSync(path.join(ROOT, f))) || 'admin.html';
const HTML_CACHE = 'public, max-age=60, stale-while-revalidate=600';

app.get(['/', '/index.html'], (req, res) => res.set('Cache-Control', HTML_CACHE).sendFile(path.join(ROOT, 'index.html'), { dotfiles: 'deny' }, err => { if (err && !res.headersSent) res.status(404).send('Not found'); }));
app.get(['/admin', /^\/admin[\w-]*\.html$/], (req, res) => res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).sendFile(path.join(ROOT, ADMIN_FILE), { dotfiles: 'deny' }, err => { if (err && !res.headersSent) res.status(404).send('Not found'); }));

const ASSET = /^\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|svg|ico|webmanifest)$/i;
const FILES = new Set(['/manifest.json', '/robots.txt', '/sitemap.xml']);
app.get('*', (req, res, next) => {
  if (!(ASSET.test(req.path) || FILES.has(req.path))) return next();
  res.sendFile(path.join(ROOT, req.path), { dotfiles: 'deny', maxAge: '1d' }, err => { if (err && !res.headersSent) next(); });
});
app.use((req, res) => res.status(404).send('Not found'));

/* ---- ভুল JSON ইত্যাদি ---- */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = err.status || err.statusCode || 500;
  if (code >= 500) console.error(err);
  res.status(code).json({ error: code === 413 ? 'too_large' : code >= 500 ? 'server' : 'bad_request', message: code === 413 ? 'ডাটা অনেক বড়' : code >= 500 ? 'সার্ভারে সমস্যা হয়েছে' : 'অনুরোধ ঠিক নয়' });
});

process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => console.error('uncaughtException:', e));

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, '0.0.0.0', () => console.log(`BANA FASHION server চালু — পোর্ট ${PORT}, অ্যাডমিন ফাইল: ${ADMIN_FILE}`));
server.keepAliveTimeout = 65000; server.headersTimeout = 70000;
process.on('SIGTERM', () => { console.log('SIGTERM — বন্ধ হচ্ছে'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
