# yazeed-site

Personal website of Yazeed Alharthi — AI engineer.

- `index.html` — the site (Arabic, RTL), built from the design prototype.
- `api/chat.js` — Vercel function behind the site assistant. Set **one** of these in Vercel → Project → Settings → Environment Variables:
  - `GEMINI_API_KEY` (optional `GEMINI_MODEL`, default `gemini-2.5-flash`)
  - `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`, default `claude-haiku-5-5`)

  Without a key the assistant falls back to built-in answers.
