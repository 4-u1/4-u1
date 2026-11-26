// Serverless function: turns the assistant's reply into speech with ElevenLabs.
// The API key stays on the server (ELEVENLABS_API_KEY); the browser only gets audio.
// Docs: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
//       header xi-api-key, body { text, model_id }

const { reject, clientIp, limit } = require('./_guard');

const MAX_CHARS = 420;          // caps credit use per reply
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 12;      // requests per IP per window

function clean(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (reject(req, res)) return;
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });

  const ip = clientIp(req);
  if (await limit('tts:' + ip, MAX_PER_WINDOW, WINDOW_MS)) return res.status(429).json({ error: 'rate_limited' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const text = clean(body && body.text);
  if (!text) return res.status(400).json({ error: 'empty_text' });

  // Arabic replies use the Arabic voice, everything else the English voice (voice ids are not secrets)
  const arabic = /[\u0600-\u06FF]/.test(text);
  const voice = arabic
    ? (process.env.ELEVENLABS_VOICE_ID_AR || 'EXAVITQu4vr4xnSDxMaL')
    : (process.env.ELEVENLABS_VOICE_ID_EN || 'Xb7hH8MSUJpSbSDYk0k2');
  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
    });
    if (!r.ok) { console.error('elevenlabs', r.status, (await r.text()).slice(0, 300)); return res.status(502).json({ error: 'tts_failed', status: r.status }); }
    const buf = Buffer.from(await r.arrayBuffer());
    console.log('tts ok', arabic ? 'ar' : 'en', model, buf.length + ' bytes');
    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('cache-control', 'no-store');
    return res.status(200).send(buf);
  } catch (e) {
    console.error('elevenlabs fetch', e && e.message);
    return res.status(502).json({ error: 'tts_failed' });
  }
}

module.exports = handler;
module.exports.MAX_CHARS = MAX_CHARS;
