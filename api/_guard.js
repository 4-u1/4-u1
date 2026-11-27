// Shared request guard for the site's API functions.
// Files starting with "_" are not exposed as routes by Vercel.
// Blocks calls that do not come from the site's own pages, so other sites
// cannot spend the owner's API credits through a visitor's browser.
const crypto = require('crypto');

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

// --- client IP ---------------------------------------------------------------
// A visitor can set their own "x-forwarded-for", so the leftmost value is NOT
// trustworthy and must never be used as the rate-limit key (an attacker would
// just rotate it to get a fresh bucket each request). Vercel's edge sets
// "x-real-ip" to the real connecting address and overwrites any client value,
// so prefer it. Fall back to the LAST x-forwarded-for entry (the one appended
// by the proxy), never the first.
function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const parts = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'anon';
}

// --- rate limiting -----------------------------------------------------------
// In-memory counters reset on every cold start and are NOT shared between the
// many serverless instances Vercel runs in parallel, so the real ceiling is
// "limit × instances". When a Vercel KV / Upstash Redis REST store is
// configured (KV_REST_API_URL + KV_REST_API_TOKEN, or the UPSTASH_* names),
// counting moves there and the limit becomes global. Without it, the code
// still works, just with the weaker in-memory ceiling.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const mem = new Map();
function memLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (mem.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); mem.set(key, arr);
  if (mem.size > 10000) {
    for (const [k, v] of mem) { if (!v.length || now - v[v.length - 1] > windowMs) mem.delete(k); }
  }
  return arr.length > max;
}

async function kvLimit(key, max, windowMs) {
  const k = 'rl:' + key;
  const r = await fetch(KV_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify([['INCR', k], ['PEXPIRE', k, String(windowMs), 'NX']])
  });
  if (!r.ok) throw new Error('kv ' + r.status);
  const out = await r.json();
  const n = Number((out && out[0] && out[0].result) || 0);
  return n > max;
}

// true => over the limit (caller should answer 429)
async function limit(key, max, windowMs) {
  if (KV_URL && KV_TOKEN) {
    try { return await kvLimit(key, max, windowMs); }
    catch (e) { console.error('kv limit', e && e.message); } // fail over to in-memory
  }
  return memLimit(key, max, windowMs);
}

// Brute-force gate for admin-key endpoints. Call this ONLY after the key check
// has already FAILED (so a legitimate admin with the right key is never counted
// and never throttled). It records the failed attempt per IP and globally and
// returns true once the caller should answer 429 instead of 401. With a Vercel
// KV / Upstash store configured the caps are global (distributed-proof); without
// it they fall back to per-instance in-memory counters.
// one-time email alert to the owner when the block first trips in a window
async function sendAdminAlert(ip) {
  const key = process.env.RESEND_API_KEY; if (!key) return;
  const to = process.env.CONTACT_TO || 'yazed.501k@gmail.com';
  const from = process.env.CONTACT_FROM || 'موقع يزيد الحارثي <onboarding@resend.dev>';
  const when = new Intl.DateTimeFormat('ar-u-nu-latn-ca-gregory', { timeZone: 'Asia/Riyadh', dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 4000);
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to: [to], subject: '⚠️ محاولات دخول فاشلة متكررة للوحة التحكم',
        text: 'تم رصد محاولات دخول فاشلة متكررة إلى لوحة التحكم /admin، وفُعّل الحظر المؤقت تلقائيًا.\n\n'
            + 'عنوان الـ IP: ' + ip + '\nالوقت: ' + when + '\n\n'
            + 'إذا كنت أنت، تجاهل الرسالة. وإلا يُنصح بتغيير INVOICE_ADMIN_KEY من Vercel.'
      })
    });
  } catch (e) { /* ignore */ } finally { clearTimeout(tm); }
}

async function adminFail(req) {
  const ip = clientIp(req);
  const win = 10 * 60 * 1000, hour = 60 * 60 * 1000;
  // escalating lockout: a short burst cools down for 10 min; a sustained
  // campaign trips the hourly tier and stays locked for up to an hour.
  const t1 = await limit('adminfail:' + ip, 8, win);     // 8 wrong / 10 min / IP
  const t2 = await limit('adminfailH:' + ip, 20, hour);  // 20 wrong / 60 min / IP
  const g1 = await limit('adminfail:all', 100, win);     // 100 wrong / 10 min total
  const g2 = await limit('adminfailH:all', 500, hour);   // 500 wrong / 60 min total
  const blocked = t1 || t2 || g1 || g2;
  if (blocked) {
    const firstInWindow = !(await limit('adminalert', 1, 30 * 60 * 1000)); // at most 1 email / 30 min
    if (firstInWindow) await sendAdminAlert(ip);
  }
  return blocked;
}

// --- admin authentication -----------------------------------------------------
// A complex password (INVOICE_ADMIN_KEY) and, when configured, a username
// (ADMIN_USER). Both are compared in constant time (sha256 + timingSafeEqual)
// so neither length nor content leaks through timing. Backward compatible: if
// ADMIN_USER is not set, only the password is required.
const _sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function _eq(a, b) { try { return crypto.timingSafeEqual(_sha(a), _sha(b)); } catch (e) { return false; } }
function isAdmin(req) {
  const key = process.env.INVOICE_ADMIN_KEY || '';
  if (key.length < 12) return false;
  const gotKey = String(req.headers['x-admin-key'] || '');
  if (!gotKey || !_eq(gotKey, key)) return false;
  const user = process.env.ADMIN_USER || '';
  if (user) {
    const gotUser = String(req.headers['x-admin-user'] || '');
    if (!gotUser || !_eq(gotUser, user)) return false;
  }
  return true;
}

module.exports = { reject, allowedOrigin, isJson, clientIp, limit, adminFail, isAdmin };
