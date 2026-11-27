// Editable site content ("overrides"): the bio paragraph, the hero image,
// project cover images, and extra programs/achievements the owner adds from
// the /admin panel. Stored as one small JSON in a private Vercel Blob.
//
//   GET  /api/content            -> public, returns the overrides JSON ({} if none)
//   POST /api/content            -> admin only (INVOICE_ADMIN_KEY):
//        { action:'save', content:{...} }           replace the overrides
//        { action:'uploadImage', name, dataUrl }    store an image, return its url
//
// The public site loads the GET result and applies it on top of the built-in
// content, so nothing here can break the site when it is empty or unreachable.
const { reject, adminFail, isAdmin } = require('./_guard');

const KEY = 'content/overrides.json';

const blob = () => import('@vercel/blob');
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);
const IMG_URL = /^(https:\/\/[^\s"'<>]+|\/assets\/[^\s"'<>]+)$/i;

async function readOverrides() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return {};
  try {
    const { get } = await blob();
    const r = await get(KEY, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return {};
    return JSON.parse(await new Response(r.stream).text()) || {};
  } catch (e) { return {}; }
}

// one timeline entry: title/org/date/cid, gold flag
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const title = clean(e.title, 160), org = clean(e.org, 200);
  if (!title) return null;
  return { title, org, date: clean(e.date, 60), cid: clean(e.cid, 80), gold: !!e.gold };
}
function cleanList(a, max) {
  return (Array.isArray(a) ? a : []).slice(0, max).map(cleanEntry).filter(Boolean);
}

function sanitize(c) {
  c = c && typeof c === 'object' ? c : {};
  const out = {};
  if (c.bio != null) out.bio = clean(c.bio, 1200);
  if (c.bioEn != null) out.bioEn = clean(c.bioEn, 1200);
  if (c.heroImg != null && IMG_URL.test(String(c.heroImg))) out.heroImg = String(c.heroImg);
  if (c.covers && typeof c.covers === 'object') {
    out.covers = {};
    for (const k of Object.keys(c.covers).slice(0, 40)) {
      const u = String(c.covers[k] || '');
      if (IMG_URL.test(u)) out.covers[clean(k, 40)] = u;
    }
  }
  out.prog = cleanList(c.prog, 40);
  out.ach = cleanList(c.ach, 40);
  out.updatedAt = new Date().toISOString();
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex');

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30');
    return res.json(await readOverrides());
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.json({ error: 'method_not_allowed' }); }
  res.setHeader('Cache-Control', 'no-store');
  if (reject(req, res)) return;
  if (!process.env.BLOB_READ_WRITE_TOKEN) { res.statusCode = 503; return res.json({ error: 'storage_not_configured' }); }
  if (!process.env.INVOICE_ADMIN_KEY) { res.statusCode = 503; return res.json({ error: 'admin_key_not_configured' }); }
  if (!isAdmin(req)) {
    const blocked = await adminFail(req);
    res.statusCode = blocked ? 429 : 401;
    return res.json({ error: blocked ? 'too_many_attempts' : 'unauthorized' });
  }

  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== 'object') { res.statusCode = 400; return res.json({ error: 'bad_request' }); }

  try {
    if (b.action === 'save') {
      const data = sanitize(b.content);
      const { put } = await blob();
      await put(KEY, JSON.stringify(data), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
      return res.json({ ok: true, content: data });
    }

    if (b.action === 'uploadImage') {
      const m = String(b.dataUrl || '').match(/^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) { res.statusCode = 400; return res.json({ error: 'bad_image' }); }
      const buf = Buffer.from(m[3], 'base64');
      if (buf.length > 4 * 1024 * 1024) { res.statusCode = 413; return res.json({ error: 'too_large' }); }
      const ext = m[2].replace('jpeg', 'jpg');
      const safe = (clean(b.name, 40).replace(/[^A-Za-z0-9_-]+/g, '-') || 'img').slice(0, 40);
      const { put } = await blob();
      const r = await put('content/img/' + safe + '.' + ext, buf, { access: 'public', contentType: m[1], addRandomSuffix: true });
      return res.json({ ok: true, url: r.url });
    }

    res.statusCode = 400; return res.json({ error: 'action' });
  } catch (e) {
    console.error('content', String(e && e.message || e).slice(0, 200));
    res.statusCode = 500; return res.json({ error: 'server' });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '6mb' } } };
