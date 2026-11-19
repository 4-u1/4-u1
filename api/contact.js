// Serverless function: delivers the site's contact form to Yazeed's inbox via Resend.
// Configure in the Vercel dashboard (never in code):
//   RESEND_API_KEY   required
//   CONTACT_TO       optional, defaults to the public address shown on the site
//   CONTACT_FROM     optional, e.g. "موقع يزيد <contact@yazeedalharthi.sa>" once the domain is verified in Resend.
//                    Until then Resend only allows "onboarding@resend.dev" -> the Resend account owner's own address.
// The visitor's address goes in reply_to, so replying from Gmail answers the visitor directly.

const MAX_FILES = 3;
const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024; // keeps the JSON body under Vercel's 4.5 MB request limit
const ALLOWED = /^(image\/(png|jpe?g|webp|gif|heic|heif)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation|spreadsheetml\.sheet)|application\/vnd\.ms-(powerpoint|excel)|application\/zip|application\/x-zip-compressed|text\/plain)$/;
const EXT_OK = /\.(png|jpe?g|webp|gif|heic|heif|pdf|docx?|pptx?|xlsx?|zip|txt)$/i;
const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]{2,}$/;

const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 5;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);
const safeName = (s) => clean(s, 120).replace(/[\\/:*?"<>|\r\n]+/g, '_') || 'attachment';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.json({ error: 'method_not_allowed' }); }
  const key = process.env.RESEND_API_KEY;
  if (!key) { res.statusCode = 503; return res.json({ error: 'not_configured' }); }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (limited(ip)) { res.statusCode = 429; return res.json({ error: 'rate_limited' }); }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== 'object') { res.statusCode = 400; return res.json({ error: 'bad_request' }); }
  if (b.company) { return res.json({ ok: true }); } // honeypot: silently drop bots

  const name = clean(b.name, 100), email = clean(b.email, 200), message = clean(b.message, 5000);
  if (!name || !message) { res.statusCode = 400; return res.json({ error: 'missing_fields' }); }
  if (!EMAIL.test(email)) { res.statusCode = 400; return res.json({ error: 'bad_email' }); }

  const files = Array.isArray(b.files) ? b.files : [];
  if (files.length > MAX_FILES) { res.statusCode = 400; return res.json({ error: 'too_many_files' }); }
  let total = 0; const attachments = [];
  for (const f of files) {
    const fname = safeName(f && f.name), type = String((f && f.type) || '').toLowerCase();
    const data = String((f && f.data) || '');
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) { res.statusCode = 400; return res.json({ error: 'bad_file' }); }
    if (!(ALLOWED.test(type) || (!type && EXT_OK.test(fname))) || !EXT_OK.test(fname)) { res.statusCode = 400; return res.json({ error: 'file_type' }); }
    total += Math.floor(data.length * 3 / 4);
    if (total > MAX_TOTAL_BYTES) { res.statusCode = 413; return res.json({ error: 'too_large' }); }
    attachments.push({ filename: fname, content: data });
  }

  const to = process.env.CONTACT_TO || 'yazed.501k@gmail.com';
  const from = process.env.CONTACT_FROM || 'موقع يزيد الحارثي <onboarding@resend.dev>';
  const subject = `رسالة من ${name} عبر موقعك`;
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.9;color:#111">
<p style="margin:0 0 12px"><b>الاسم:</b> ${esc(name)}<br><b>البريد:</b> <a href="mailto:${esc(email)}">${esc(email)}</a></p>
<div style="white-space:pre-wrap;border-right:3px solid #4FB8E8;padding:8px 14px;background:#f5f8fb">${esc(message)}</div>
${attachments.length ? `<p style="color:#555;margin-top:12px">المرفقات: ${attachments.map((a) => esc(a.filename)).join('، ')}</p>` : ''}
<p style="color:#888;font-size:12px;margin-top:18px">أُرسلت من نموذج التواصل في موقعك. اضغط «رد» للرد على المرسل مباشرة.</p></div>`;
  const text = `الاسم: ${name}\nالبريد: ${email}\n\n${message}`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: email, subject, html, text, attachments: attachments.length ? attachments : undefined })
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('resend_error', r.status, detail.slice(0, 300));
      res.statusCode = 502; return res.json({ error: 'send_failed' });
    }
    const out = await r.json().catch(() => ({}));
    return res.json({ ok: true, id: out.id || null });
  } catch (e) {
    console.error('resend_exception', String(e).slice(0, 200));
    res.statusCode = 502; return res.json({ error: 'send_failed' });
  }
};

// Vercel Node functions parse JSON bodies by default; raise the limit for attachments.
module.exports.config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };
