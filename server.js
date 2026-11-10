'use strict';
/* BANA FASHION — Railway সার্ভার (সিকিউরিটি রিভিউ v2)
   সাইট (index.html / অ্যাডমিন) + /api (Steadfast, WhatsApp, SMS OTP, অর্ডার খোঁজা) */
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

require('./firebase'); // শুরুতেই ক্রেডেনশিয়াল যাচাই — ভুল থাকলে সার্ভার চালুই হবে না

const app = express();
const ROOT = __dirname;
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(helmet({
  // সাইটে inline স্ক্রিপ্ট ও অনেক CDN আছে; কড়া CSP এখন বসালে সাইট ভেঙে যাবে (আলাদা ধাপে করা হবে)
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,          // Google লগইন পপআপের জন্য
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: { action: 'sameorigin' },
  hsts: { maxAge: 31536000 },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()');
  next();
});
app.use(compression());

/* ---- CORS: একই ডোমেইন, অথবা ALLOWED_ORIGINS-এ তালিকাভুক্ত ডোমেইন ছাড়া /api-তে প্রবেশ নেই ---- */
const ALLOWED = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const origin = req.get('origin');
  if (origin) {
    let sameHost = false;
    try { sameHost = new URL(origin).host === req.get('host'); } catch (e) { /* ভুল origin */ }
    if (!sameHost && !ALLOWED.includes(origin)) {
      return res.status(403).json({ error: 'forbidden_origin', message: 'এই ডোমেইনের অনুমতি নেই' });
    }
    res.set({
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Firebase-AppCheck',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600'
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---- রেট লিমিট: প্রতি IP প্রতি মিনিটে সর্বোচ্চ ৩০০ অনুরোধ ---- */
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'অনেক বেশি অনুরোধ — একটু পরে চেষ্টা করুন' }
}));

/* ---- JSON body: ইনভয়েস ছবি (base64) সহ সর্বোচ্চ ৩ MB; এর বেশি হলে 413 ---- */
app.use('/api', express.json({ limit: '3mb' }));

/* ---- API ---- */
app.use('/api', require('./wa'));
app.use('/api', require('./sms'));
app.use('/api', require('./orders'));
app.use('/api', require('./steadfast'));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'এই API নেই' }));

/* ---- শুধু GET/HEAD স্ট্যাটিক ফাইলে; বাকি মেথড বন্ধ ---- */
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.set('Allow', 'GET, HEAD').status(405).end();
});

/* ---- স্ট্যাটিক: শুধু অনুমোদিত ফাইল। .env, server.js, package.json, *.js কখনো পাবলিক নয় ---- */
const ADMIN_FILE = (() => {
  const names = [process.env.ADMIN_FILE, 'admin.html', 'admin-index.html', 'admin__3_.html']
    .filter(Boolean).map(f => path.basename(f));
  return names.find(f => fs.existsSync(path.join(ROOT, f))) || 'admin.html';
})();

function sendRootFile(file, headers) {
  return (req, res) => {
    res.set(headers);
    res.sendFile(path.join(ROOT, file), { dotfiles: 'deny' }, err => {
      if (err && !res.headersSent) res.status(404).send('Not found');
    });
  };
}

app.get(['/', '/index.html'], sendRootFile('index.html', {
  'Cache-Control': 'public, max-age=60, stale-while-revalidate=600'
}));

app.get(['/admin', /^\/admin[\w-]*\.html$/], sendRootFile(ADMIN_FILE, {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow'
}));

const ASSET = /^\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|svg|ico|webmanifest)$/i;
const FILES = new Set(['/manifest.json', '/robots.txt', '/sitemap.xml']);
app.use((req, res, next) => {
  if (!(ASSET.test(req.path) || FILES.has(req.path))) return next();
  res.sendFile(path.join(ROOT, req.path), { dotfiles: 'deny', maxAge: '1d' }, err => {
    if (err && !res.headersSent) next();
  });
});

app.use((req, res) => res.status(404).send('Not found'));

/* ---- ত্রুটি: ভেতরের বিবরণ ব্রাউজারে যায় না, শুধু সাধারণ বার্তা ---- */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = err.status || err.statusCode || 500;
  if (code >= 500) console.error('server error:', err);
  const status = code >= 400 && code < 600 ? code : 500;
  res.status(status).json({
    error: code === 413 ? 'too_large' : code >= 500 ? 'server' : 'bad_request',
    message: code === 413 ? 'ডাটা অনেক বড়' : code >= 500 ? 'সার্ভারে সমস্যা হয়েছে' : 'অনুরোধ ঠিক নয়'
  });
});

process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
/* অপ্রত্যাশিত ত্রুটির পর প্রক্রিয়া বিগড়ানো অবস্থায় চলতে দেওয়া হবে না; Railway নিজে restart করবে */
process.on('uncaughtException', e => { console.error('uncaughtException:', e); process.exit(1); });

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, '0.0.0.0', () =>
  console.log(`BANA FASHION server চালু — পোর্ট ${PORT}, অ্যাডমিন ফাইল: ${ADMIN_FILE}`));
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 30000;   // ধীরগতির/আটকে থাকা অনুরোধ ৩০ সেকেন্ডে বন্ধ

process.on('SIGTERM', () => {
  console.log('SIGTERM — বন্ধ হচ্ছে');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
