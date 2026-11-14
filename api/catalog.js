// Vercel Serverless Function: public product catalog, cached on Vercel's CDN.
// 1 Firestore read per product per 5 minutes in total (not per visitor). Env: FIREBASE_WEB_API_KEY (+ optional FIREBASE_PROJECT_ID).
const PID = process.env.FIREBASE_PROJECT_ID || 'bana-fashion';
const KEY = process.env.FIREBASE_WEB_API_KEY;

function cv(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(cv);
  if ('mapValue' in v) { const o = {}, f = v.mapValue.fields || {}; for (const k in f) o[k] = cv(f[k]); return o; }
  return null;
}
async function fs(path, qs = '') {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PID}/databases/(default)/documents/${path}?key=${KEY}${qs}`);
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}

module.exports = async (req, res) => {
  try {
    if (!KEY) throw new Error('FIREBASE_WEB_API_KEY missing');
    const products = []; let tok = '';
    for (let i = 0; i < 20; i++) {
      const j = await fs('products', '&pageSize=300' + (tok ? '&pageToken=' + encodeURIComponent(tok) : ''));
      (j.documents || []).forEach(d => { const o = { id: d.name.split('/').pop() }; for (const k in (d.fields || {})) o[k] = cv(d.fields[k]); products.push(o); });
      tok = j.nextPageToken; if (!tok) break;
    }
    let hanger = null;
    try { const d = await fs('settings/hanger'); hanger = {}; for (const k in (d.fields || {})) hanger[k] = cv(d.fields[k]); } catch (e) {}
    const body = JSON.stringify({ products, hanger, t: Date.now() });
    if (body.length > 4000000) { res.setHeader('Cache-Control', 'no-store'); return res.status(413).json({ error: 'too_big' }); } // Vercel limit is 4.5 MB: the site falls back to Firestore
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    res.status(200).send(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'catalog_failed' });
  }
};
