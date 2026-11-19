// Serverless function: delivers the site's contact form to Yazeed's inbox via Resend.
// Configure in the Vercel dashboard (never in code):
//   RESEND_API_KEY   required
//   CONTACT_TO       optional, defaults to the public address shown on the site
//   CONTACT_FROM     optional, e.g. "موقع يزيد <contact@yazeedalharthi.sa>" once the domain is verified in Resend.
//                    Until then Resend only allows "onboarding@resend.dev" -> the Resend account owner's own address.
// The visitor's address goes in reply_to, so replying from Gmail answers the visitor directly.

const { reject } = require('./_guard');

const MAX_FILES = 3;
const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024; // keeps the JSON body under Vercel's 4.5 MB request limit
const ALLOWED = /^(image\/(png|jpe?g|webp|gif|heic|heif)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation|spreadsheetml\.sheet)|application\/vnd\.ms-(powerpoint|excel)|text\/plain)$/;
const EXT_OK = /\.(png|jpe?g|webp|gif|heic|heif|pdf|docx?|pptx?|xlsx?|txt)$/i;
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
  if (reject(req, res)) return;
  const key = process.env.RESEND_API_KEY;
  if (!key) { res.statusCode = 503; return res.json({ error: 'not_configured' }); }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (limited(ip)) { res.statusCode = 429; return res.json({ error: 'rate_limited' }); }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== 'object') { res.statusCode = 400; return res.json({ error: 'bad_request' }); }
  if (b.company) { return res.json({ ok: true }); } // honeypot: silently drop bots

  const name = clean(b.name, 100).replace(/[\r\n\t]+/g, ' '), email = clean(b.email, 200), message = clean(b.message, 5000);
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
  const html = renderEmail({ name, email, message, files: attachments.map((a) => a.filename) });
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

// Branded notification email (table layout + inline styles for Gmail/Outlook/Apple Mail)
const ASSET = 'https://yazeedalharthi.sa/assets/email';
function renderEmail({ name, email, message, files }) {
  const now = new Intl.DateTimeFormat('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  const replyHref = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('رد من يزيد حمد الحارثي')}`;
  const ach = [
    ['🥇', 'المركز الأول', 'مسار السياحة الذكية · AURA'],
    ['🛡️', 'مِجهر', 'حقن الأوامر من 31% إلى 100%'],
    ['⚡', '32 من 32', 'HackerRank Orchestrate']
  ].map(([i, t, d]) => `<td width="33%" valign="top" style="padding:0 5px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#10141A;border:1px solid #1F252E;border-radius:14px"><tr><td style="padding:14px 12px;text-align:center;font-family:Tahoma,Arial,sans-serif">
<div style="font-size:20px;line-height:1">${i}</div><div style="margin-top:8px;font-size:14px;font-weight:bold;color:#F2F4F7">${t}</div><div style="margin-top:3px;font-size:11.5px;color:#7E8895;line-height:1.6">${d}</div></td></tr></table></td>`).join('');
  const fileRows = files.length ? `<tr><td style="padding:18px 28px 0;font-family:Tahoma,Arial,sans-serif">
<div style="font-size:12px;color:#7E8895;margin-bottom:8px">المرفقات (${files.length})</div>
${files.map((f) => `<div style="display:inline-block;margin:0 0 6px 6px;padding:7px 12px;border-radius:10px;background:#10141A;border:1px solid #1F252E;color:#CFE9F7;font-size:13px">📎 ${esc(f)}</div>`).join('')}</td></tr>` : '';
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:#05070A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#05070A" style="background:#05070A"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" dir="rtl" style="width:100%;max-width:600px;background:#07090C;border:1px solid #1A1F27;border-radius:22px;overflow:hidden">
<tr><td style="padding:0"><img src="${ASSET}/yh-header.jpg" width="600" alt="YH" style="display:block;width:100%;height:auto;border:0"></td></tr>
<tr><td style="padding:6px 28px 0;font-family:Tahoma,Arial,sans-serif;text-align:right">
<div style="font-size:12.5px;color:#E9B949;letter-spacing:.3px">رسالة جديدة من موقعك</div>
<div style="margin-top:6px;font-size:24px;font-weight:bold;color:#FFFFFF;line-height:1.5">${esc(name)}</div>
<div style="margin-top:2px;font-size:14px"><a href="mailto:${esc(email)}" style="color:#4FB8E8;text-decoration:none">${esc(email)}</a></div>
<div style="margin-top:2px;font-size:12px;color:#5A6472">${now}</div>
</td></tr>
<tr><td style="padding:18px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0E1217;border:1px solid #1F252E;border-right:3px solid #4FB8E8;border-radius:14px"><tr><td style="padding:18px 20px;font-family:Tahoma,Arial,sans-serif;font-size:15.5px;line-height:1.95;color:#DCE2E9;white-space:pre-wrap;text-align:right">${esc(message)}</td></tr></table></td></tr>
${fileRows}
<tr><td align="center" style="padding:24px 28px 6px"><a href="${replyHref}" style="display:inline-block;padding:13px 34px;border-radius:12px;background:#4FB8E8;color:#06121C;font-family:Tahoma,Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none">رد على ${esc(name)}</a></td></tr>
<tr><td style="padding:26px 23px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${ach}</tr></table></td></tr>
<tr><td align="center" style="padding:30px 28px 8px">
<img src="${ASSET}/emblem.png" width="44" height="44" alt="" style="display:block;border:0;margin:0 auto">
<div style="margin-top:8px;font-family:Tahoma,Arial,sans-serif;font-size:17px;font-weight:bold;color:#E9B949">همّة حتى القمّة</div>
</td></tr>
<tr><td align="center" style="padding:14px 28px 26px;border-top:1px solid #151A21;font-family:Tahoma,Arial,sans-serif">
<div style="font-size:13px;color:#AEB7C2"><b style="color:#F2F4F7">يزيد حمد الحارثي</b> · مهندس حلول ذكاء اصطناعي</div>
<div style="margin-top:6px;font-size:12.5px"><a href="https://yazeedalharthi.sa" style="color:#4FB8E8;text-decoration:none">yazeedalharthi.sa</a></div>
<div style="margin-top:10px;font-size:11px;color:#4A5361">وصلتك هذي الرسالة من نموذج التواصل في موقعك. زر «رد» يرد على المرسل مباشرة. © 2026</div>
</td></tr>
</table></td></tr></table></body></html>`;
}
