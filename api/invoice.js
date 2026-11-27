// Invoices for Yazeed's services: numbered on the server, stored in a private
// Vercel Blob store, emailed to the client with a private view link.
// Admin actions need the INVOICE_ADMIN_KEY env var; clients read one invoice
// with its id + random token.
const crypto = require('crypto');
const { reject, adminFail, isAdmin } = require('./_guard');

const PREFIX = 'invoices/';
const ID_RE = /^INV-\d{4}-\d{4}$/;
const MAX_ITEMS = 30;

const blob = () => import('@vercel/blob');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);
const num = (v, max) => { const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= max ? Math.round(x * 100) / 100 : 0; };
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });


async function readJson(pathname) {
  const { get } = await blob();
  const r = await get(pathname, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return JSON.parse(await new Response(r.stream).text());
}
async function writeJson(pathname, data) {
  const { put } = await blob();
  await put(pathname, JSON.stringify(data), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
}

async function nextId() {
  const y = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh', year: 'numeric' }).format(new Date()));
  const c = (await readJson(PREFIX + '_counter.json')) || {};
  const n = c.year === y ? (Number(c.n) || 0) + 1 : 1;
  await writeJson(PREFIX + '_counter.json', { year: y, n });
  return `INV-${y}-${String(n).padStart(4, '0')}`;
}

function build(b) {
  const s = b.seller || {}, c = b.client || {};
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS)
    .map((it) => ({ d: clean(it && it.d, 200), q: num(it && it.q, 1e4), p: num(it && it.p, 1e7) }))
    .filter((it) => it.d && it.q > 0);
  const sub = items.reduce((a, it) => a + it.q * it.p, 0);
  const disc = Math.min(num(b.discount, 1e7), sub);
  const inv = {
    seller: {
      name: clean(s.name, 80) || 'يزيد حمد الحارثي', title: clean(s.title, 80) || 'مهندس حلول ذكاء اصطناعي',
      phone: clean(s.phone, 40), email: clean(s.email, 120), fl: clean(s.fl, 40),
      bankName: clean(s.bankName, 60), holder: clean(s.holder, 80),
      iban: clean(s.iban, 40).replace(/\s+/g, '').toUpperCase(), acct: clean(s.acct, 40).replace(/\s+/g, '')
    },
    client: { name: clean(c.name, 100), org: clean(c.org, 120), email: clean(c.email, 200), phone: clean(c.phone, 40) },
    service: clean(b.service, 120), quoteRef: clean(b.quoteRef, 40), notes: clean(b.notes, 1500),
    dueDays: Math.min(Math.max(Math.round(Number(b.dueDays) || 7), 0), 90),
    items, totals: { sub: Math.round(sub * 100) / 100, disc, total: Math.round((sub - disc) * 100) / 100 }
  };
  if (!inv.client.name) return { error: 'client_name' };
  if (inv.client.email && !EMAIL.test(inv.client.email)) return { error: 'client_email' };
  if (!items.length) return { error: 'no_items' };
  if (!/^SA\d{22}$/.test(inv.seller.iban)) return { error: 'iban' };
  return { inv };
}

function viewUrl(inv) { return `https://invoice.yazeedalharthi.sa/v/${inv.id}?t=${inv.token}`; }

function emailHtml(inv, kind) {
  const paid = kind === 'paid';
  const BG = (c) => `background-color:${c};background-image:linear-gradient(${c},${c})`;
  const rows = inv.items.map((it) => `<tr><td style="padding:8px 0;border-bottom:1px solid #222831;color:#D6DAE0;font-size:14px">${esc(it.d)}${it.q !== 1 ? ` × ${fmt(it.q)}` : ''}</td><td style="padding:8px 0;border-bottom:1px solid #222831;color:#F4F5F7;font-size:14px;text-align:left;direction:ltr;white-space:nowrap">${fmt(it.q * it.p)} SAR</td></tr>`).join('');
  return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;padding:0;${BG('#0A0B0D')}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${BG('#0A0B0D')}"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;${BG('#101318')};border-radius:16px;font-family:Tahoma,Arial,sans-serif">
<tr><td style="height:4px;background-image:linear-gradient(90deg,#4FB8E8,#17719F,#E9B949);border-radius:16px 16px 0 0"></td></tr>
<tr><td style="padding:26px 26px 6px;text-align:right">
<div style="font-size:12px;color:#E9B949;letter-spacing:.12em;font-family:Arial">${paid ? 'PAYMENT RECEIVED' : 'INVOICE'} · ${esc(inv.id)}</div>
<div style="margin-top:8px;font-size:22px;font-weight:bold;color:#F4F5F7">${paid ? 'تم استلام الدفعة، شكرًا لك' : 'فاتورة من يزيد حمد الحارثي'}</div>
<div style="margin-top:6px;font-size:14px;color:#9AA3AF">${esc(inv.client.name)}${inv.service ? ' · ' + esc(inv.service) : ''}</div>
</td></tr>
<tr><td style="padding:14px 26px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
${inv.totals.disc ? `<tr><td style="padding:8px 0;color:#9AA3AF;font-size:14px">الخصم</td><td style="padding:8px 0;color:#9AA3AF;font-size:14px;text-align:left;direction:ltr">− ${fmt(inv.totals.disc)} SAR</td></tr>` : ''}
<tr><td style="padding:12px 0 0;color:#F4F5F7;font-size:16px;font-weight:bold">${paid ? 'المبلغ المدفوع' : 'الإجمالي المستحق'}</td><td style="padding:12px 0 0;color:#E9B949;font-size:20px;font-weight:bold;text-align:left;direction:ltr">${fmt(inv.totals.total)} SAR</td></tr></table></td></tr>
${paid ? '' : `<tr><td style="padding:6px 26px 0;font-size:13px;color:#9AA3AF">تاريخ الاستحقاق: ${esc(inv.due)}</td></tr>`}
<tr><td align="center" style="padding:22px 26px 10px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="${BG('#17719F')};border-radius:12px"><a href="${viewUrl(inv)}" style="display:block;padding:13px 30px;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none">${paid ? 'عرض الإيصال' : 'عرض الفاتورة وبيانات الدفع'}</a></td></tr></table></td></tr>
<tr><td style="padding:6px 26px 24px;text-align:center;font-size:12px;color:#6B7380">من الصفحة تقدر تنزّل الفاتورة PDF وتنسخ الآيبان أو تمسح الباركود.<br>yazeedalharthi.sa</td></tr>
</table></td></tr></table></body></html>`;
}

async function send(inv, kind) {
  const key = process.env.RESEND_API_KEY; if (!key) return { ok: false, why: 'no_resend' };
  const owner = process.env.CONTACT_TO || 'yazed.501k@gmail.com';
  const from = process.env.INVOICE_FROM || process.env.CONTACT_FROM || 'يزيد حمد الحارثي <onboarding@resend.dev>';
  const subject = kind === 'paid' ? `إيصال استلام ${inv.id} · يزيد حمد الحارثي` : `فاتورة ${inv.id} من يزيد حمد الحارثي · ${fmt(inv.totals.total)} ريال`;
  const html = emailHtml(inv, kind);
  const go = (to, cc) => fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, cc, reply_to: owner, subject, html }) });
  if (inv.client.email) {
    const r = await go([inv.client.email], [owner]);
    if (r.ok) return { ok: true, client: true };
    console.error('invoice email client', r.status, (await r.text()).slice(0, 200));
  }
  const r2 = await go([owner]);
  return { ok: r2.ok, client: false };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!process.env.BLOB_READ_WRITE_TOKEN) { res.statusCode = 503; return res.json({ error: 'storage_not_configured' }); }
  try {
    if (req.method === 'GET') {
      const id = String(req.query.id || ''), t = String(req.query.t || '');
      if (id && ID_RE.test(id)) {
        const inv = await readJson(PREFIX + id + '.json');
        if (!inv || !(t && same(t, inv.token)) && !isAdmin(req)) { res.statusCode = 404; return res.json({ error: 'not_found' }); }
        const { token, ...pub } = inv; return res.json({ invoice: pub });
      }
      if (req.query.list && isAdmin(req)) {
        const { list } = await blob();
        const out = await list({ prefix: PREFIX + 'INV-', limit: 1000 });
        const ids = out.blobs.map((b) => b.pathname.slice(PREFIX.length, -5)).filter((x) => ID_RE.test(x)).sort().reverse().slice(0, 40);
        const rows = (await Promise.all(ids.map((x) => readJson(PREFIX + x + '.json')))).filter(Boolean)
          .map((i) => ({ id: i.id, date: i.date, client: i.client.name, total: i.totals.total, status: i.status, url: viewUrl(i) }));
        return res.json({ invoices: rows });
      }
      res.statusCode = isAdmin(req) ? 400 : 404; return res.json({ error: 'not_found' });
    }
    if (req.method !== 'POST') { res.statusCode = 405; return res.json({ error: 'method' }); }
    if (reject(req, res)) return;
    if (!process.env.INVOICE_ADMIN_KEY) { res.statusCode = 503; return res.json({ error: 'admin_key_not_configured' }); }
    if (!isAdmin(req)) {
      const blocked = await adminFail(req);
      res.statusCode = blocked ? 429 : 401;
      return res.json({ error: blocked ? 'too_many_attempts' : 'unauthorized' });
    }
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
    if (!b || typeof b !== 'object') { res.statusCode = 400; return res.json({ error: 'bad_request' }); }

    if (b.action === 'check') return res.json({ ok: true });
    if (b.action === 'create') {
      const { inv, error } = build(b);
      if (error) { res.statusCode = 400; return res.json({ error }); }
      const now = new Date();
      const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(d);
      inv.id = await nextId(); inv.token = crypto.randomBytes(18).toString('base64url');
      inv.date = day(now); inv.due = day(new Date(now.getTime() + inv.dueDays * 864e5));
      inv.createdAt = now.toISOString(); inv.status = 'unpaid';
      await writeJson(PREFIX + inv.id + '.json', inv);
      const mail = b.send === false ? { ok: false, skipped: true } : await send(inv, 'invoice');
      return res.json({ id: inv.id, url: viewUrl(inv), email: mail });
    }
    if (b.action === 'paid' || b.action === 'resend') {
      const id = String(b.id || ''); if (!ID_RE.test(id)) { res.statusCode = 400; return res.json({ error: 'id' }); }
      const inv = await readJson(PREFIX + id + '.json'); if (!inv) { res.statusCode = 404; return res.json({ error: 'not_found' }); }
      if (b.action === 'paid') { inv.status = 'paid'; inv.paidAt = new Date().toISOString(); await writeJson(PREFIX + id + '.json', inv); }
      const mail = await send(inv, b.action === 'paid' ? 'paid' : 'invoice');
      return res.json({ id, status: inv.status, email: mail });
    }
    res.statusCode = 400; return res.json({ error: 'action' });
  } catch (e) {
    console.error('invoice', String(e && e.message || e).slice(0, 200));
    res.statusCode = 500; return res.json({ error: 'server' });
  }
};
