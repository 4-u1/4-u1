// Read-only status for the owner's admin dashboard (/admin).
// Gated by the same INVOICE_ADMIN_KEY. Returns ONLY booleans about which
// integrations are configured — never any secret value.
const crypto = require('crypto');
const { adminFail } = require('./_guard');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function same(a, b) { try { return crypto.timingSafeEqual(sha(a), sha(b)); } catch (e) { return false; } }
function isAdmin(req) {
  const k = process.env.INVOICE_ADMIN_KEY || '';
  const got = String(req.headers['x-admin-key'] || '');
  return k.length >= 12 && got.length > 0 && same(got, k);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'GET') { res.statusCode = 405; return res.json({ error: 'method_not_allowed' }); }
  if (!process.env.INVOICE_ADMIN_KEY) { res.statusCode = 503; return res.json({ error: 'admin_key_not_configured' }); }
  if (!isAdmin(req)) {
    const blocked = await adminFail(req);
    res.statusCode = blocked ? 429 : 401;
    return res.json({ error: blocked ? 'too_many_attempts' : 'unauthorized' });
  }

  const kv = !!((process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
                (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN));
  return res.json({
    ok: true,
    integrations: {
      gemini: !!process.env.GEMINI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      resend: !!process.env.RESEND_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      blob: !!process.env.BLOB_READ_WRITE_TOKEN,
      invoiceFrom: !!(process.env.INVOICE_FROM || process.env.CONTACT_FROM),
      rateLimitStore: kv
    },
    contactTo: process.env.CONTACT_TO || 'yazed.501k@gmail.com'
  });
};
