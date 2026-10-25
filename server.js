'use strict';
/* BANA FASHION — Railway সার্ভার
   স্ট্যাটিক সাইট (public/) + API (/api/*) একই ডোমেইনে, তাই CORS লাগে না। */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

require('./firebase'); // credential না থাকলে এখানেই স্টার্টআপ ফেল (নিরাপদ ডিফল্ট)

const app = express();
const PROD = process.env.NODE_ENV === 'production';
const fs = require('fs');
/* সব ফাইল একই ফোল্ডারে (গিটহাবের রুটে) — তাই সার্ভার নিজে index ও admin HTML খুঁজে নেয়।
   শুধু এই দুটি ফাইলই বাইরে দেওয়া হয়; server.js, rules ইত্যাদি কখনো খোলা হয় না। */
const FILES = fs.readdirSync(__dirname);
const INDEX_FILE = FILES.includes('index.html') ? 'index.html' : FILES.find((f) => /\.html$/i.test(f) && !/^(admin|rul)/i.test(f));
const ADMIN_FILE = FILES.find((f) => /^admin.*\.html$/i.test(f));
if (!INDEX_FILE) console.warn('⚠️ index.html পাওয়া যায়নি — গিটহাবে আপলোড করেছেন তো?');
if (!ADMIN_FILE) console.warn('⚠️ admin HTML ফাইল পাওয়া যায়নি (নাম admin দিয়ে শুরু হতে হবে)');
const ADMIN_PATH = (process.env.ADMIN_PATH || '/admin').replace(/\/+$/, '') || '/admin';
const EXTRA_ORIGINS = String(process.env.SITE_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway-র প্রক্সির পেছনে — সঠিক ক্লায়েন্ট IP (rate-limit-এর জন্য জরুরি)

/* ---------- নিরাপত্তা হেডার ---------- */
const csp = {
  useDefaults: false,
  reportOnly: process.env.CSP_MODE === 'report',
  directives: {
    'default-src': ["'self'"],
    // সাইটে inline script/onclick আছে, তাই 'unsafe-inline' লাগছে; বাকি সব হোস্ট নির্দিষ্ট করা
    'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com', 'https://www.gstatic.com', 'https://apis.google.com', 'https://www.google.com'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'connect-src': ["'self'", 'https://*.googleapis.com', 'https://*.firebaseio.com', 'https://*.firebasestorage.app', 'https://www.gstatic.com', 'https://nominatim.openstreetmap.org', 'https://cdnjs.cloudflare.com'],
    'frame-src': ['https://*.firebaseapp.com', 'https://accounts.google.com', 'https://www.google.com'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    ...(PROD ? { 'upgrade-insecure-requests': [] } : {}),
  },
};
app.use(helmet({
  contentSecurityPolicy: csp,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Google সাইন-ইন পপআপের জন্য আবশ্যক
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=(), usb=()');
  next();
});
app.use(compression());

/* ---------- Rate limit ---------- */
const mk = (windowMs, max, msg) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: msg || 'অনেক বেশি রিকোয়েস্ট, একটু পরে চেষ্টা করুন' } });
app.use(mk(60_000, 300));                                  // সব রিকোয়েস্ট: IP প্রতি মিনিটে ৩০০
app.use('/api/wa-notify', mk(10 * 60_000, 15));            // অর্ডার নোটিফাই: ১০ মিনিটে ১৫
app.use('/api/sf-webhook', mk(60_000, 120));
app.use(['/api/sf', '/api/wa'], mk(60_000, 60));

/* ---------- Body parser (সীমিত সাইজ) ---------- */
app.use('/api/wa-notify', express.json({ limit: '3mb' })); // ইনভয়েস ছবি থাকে
app.use('/api', express.json({ limit: '50kb' }));

/* ---------- CSRF-সুরক্ষা: POST শুধু আমাদের নিজের সাইট থেকে (Steadfast webhook বাদে — সেটা টোকেন দিয়ে সুরক্ষিত) ---------- */
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST' || req.path === '/sf-webhook') return next();
  const o = req.headers.origin;
  if (!o) return next(); // একই-অরিজিন সাধারণ রিকোয়েস্টে Origin না-ও থাকতে পারে; টোকেন যাচাই তো আছেই
  const self = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.headers.host;
  if (o === self || EXTRA_ORIGINS.includes(o)) return next();
  res.status(403).json({ error: 'অনুমোদিত অরিজিন নয়' });
});

/* ---------- API ---------- */
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use('/api', require('./products'));
app.use('/api', require('./wa'));
app.use('/api', require('./steadfast'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ---------- পেজ (শুধু দুটি ফাইল) ---------- */
const page = (file, headers) => (req, res) => {
  if (!file) return res.status(404).type('text').send('Not found');
  res.set(headers); res.sendFile(path.join(__dirname, file));
};
app.get(['/', '/index.html'], page(INDEX_FILE, { 'Cache-Control': 'no-cache' }));
app.get([ADMIN_PATH, ADMIN_PATH + '.html'], page(ADMIN_FILE, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }));
app.use((req, res) => (req.method === 'GET' && !path.extname(req.path)) ? page(INDEX_FILE, { 'Cache-Control': 'no-cache' })(req, res) : res.status(404).type('text').send('Not found'));

/* ---------- ত্রুটি হ্যান্ডলার (স্ট্যাক ট্রেস কখনো বাইরে যায় না) ---------- */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'ডেটা অনেক বড়' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'ভুল JSON' });
  console.error('unhandled:', err && err.message);
  res.status(500).json({ error: 'সার্ভার ত্রুটি' });
});

const port = process.env.PORT || 3000;
const server = app.listen(port, '0.0.0.0', () => console.log('BANA server listening on', port));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));
