'use strict';
/**
 * BANA FASHION — Railway সার্ভার
 *  - সাইট (public/index.html) ও অ্যাডমিন প্যানেল (views/admin.html) পরিবেশন করে
 *  - /api/sf, /api/sf-webhook  (Steadfast)
 *  - /api/wa-enabled, /api/wa-notify, /api/wa  (WhatsApp)
 *  - সিকিউরিটি হেডার (CSP, HSTS ইত্যাদি) ও রেট-লিমিট
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');

require('./lib/firebase');               // শুরুতেই Firebase Admin চালু (ভুল কনফিগ থাকলে এখানেই ধরা পড়বে)

const app = express();
const PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const ADMIN_PATH = '/' + String(process.env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '');

app.set('trust proxy', 1);               // Railway প্রক্সির পেছনে — আসল IP পেতে (রেট-লিমিটের জন্য জরুরি)
app.disable('x-powered-by');

/* ---------------- সিকিউরিটি হেডার ----------------
   সাইটে inline script/onclick আছে, তাই 'unsafe-inline' লাগে; কিন্তু connect-src/frame-src/object-src ইত্যাদি
   কড়া করা আছে — ফলে কোনো ক্ষতিকর স্ক্রিপ্ট ঢুকলেও ডাটা অচেনা সার্ভারে পাঠাতে পারবে না।
   কিছু ভেঙে গেলে Railway Variables-এ CSP_REPORT_ONLY=1 দিয়ে দেখুন (ব্লক না করে শুধু ব্রাউজার কনসোলে জানাবে)। */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,                   // helmet-এর ডিফল্ট (script-src-attr 'none' ইত্যাদি) বন্ধ — নিচে সবকিছু নিজে দেওয়া
    reportOnly: process.env.CSP_REPORT_ONLY === '1',
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrcAttr: ["'unsafe-inline'"],   // সাইটে onclick=... ইনলাইন ইভেন্ট আছে — না দিলে সব বাটন বন্ধ হয়ে যেত
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com',
        'https://www.gstatic.com', 'https://apis.google.com', 'https://www.google.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', 'https://cdn.tailwindcss.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://*.googleapis.com', 'https://*.firebaseio.com', 'https://www.google.com',
        'https://nominatim.openstreetmap.org', 'https://cdnjs.cloudflare.com'],
      frameSrc: ['https://*.firebaseapp.com', 'https://accounts.google.com', 'https://www.google.com', 'https://recaptcha.google.com'],
      workerSrc: ["'self'", 'blob:'],
      ...(PROD ? { upgradeInsecureRequests: [] } : {})
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },   // Google সাইন-ইন পপআপের জন্য জরুরি
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: PROD ? { maxAge: 31536000, includeSubDomains: false } : false
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), bluetooth=()');
  next();
});

/* ---------------- API ---------------- */
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(require('./routes/steadfast'));
app.use(require('./routes/whatsapp'));
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

/* ---------------- অ্যাডমিন প্যানেল (সার্চ ইঞ্জিন/ক্যাশ থেকে দূরে) ---------------- */
app.get([ADMIN_PATH, ADMIN_PATH + '/'], (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

/* ---------------- সাইট ---------------- */
app.get('/robots.txt', (req, res) => res.type('text').send(`User-agent: *\nDisallow: ${ADMIN_PATH}\nDisallow: /api/\n`));
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html', dotfiles: 'ignore', maxAge: '1h',
  setHeaders: (res, p) => { if (/\.html$/i.test(p)) res.setHeader('Cache-Control', 'no-cache'); }
}));
app.use((req, res) => res.status(404).type('text').send('Not found'));

/* ---------------- এরর হ্যান্ডলার (ভেতরের তথ্য ফাঁস না করে) ---------------- */
app.use((err, req, res, next) => {          // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad json' });
  console.error('[error]', err && err.message);
  res.status(500).json({ error: 'server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BANA FASHION server listening on :${port} (admin: ${ADMIN_PATH})`));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message));
