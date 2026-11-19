// Shared request guard for the site's API functions.
// Files starting with "_" are not exposed as routes by Vercel.
// Blocks calls that do not come from the site's own pages, so other sites
// cannot spend the owner's API credits through a visitor's browser.

const ALLOWED_HOSTS = new Set([
  'yazeed-alharthi.vercel.app',
  'yazeedalharthi.sa',
  'www.yazeedalharthi.sa',
  'invoice.yazeedalharthi.sa'
]);
// preview / branch deployments of this project only
const PREVIEW = /^yazeed-alharthi-[a-z0-9-]+-4-u1-6459\.vercel\.app$/;

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch (e) { return ''; }
}

function allowedOrigin(req) {
  const origin = req.headers.origin || '';
  const ref = req.headers.referer || req.headers.referrer || '';
  const h = hostOf(origin) || hostOf(ref);
  if (!h) return false;
  return ALLOWED_HOSTS.has(h) || PREVIEW.test(h) || (process.env.ALLOW_LOCAL === '1' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h));
}

function isJson(req) {
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
}

// returns true if the request was rejected (response already sent)
function reject(req, res) {
  if (!allowedOrigin(req)) { res.statusCode = 403; res.json({ error: 'forbidden_origin' }); return true; }
  if (!isJson(req)) { res.statusCode = 415; res.json({ error: 'json_only' }); return true; }
  return false;
}

module.exports = { reject, allowedOrigin, isJson };
