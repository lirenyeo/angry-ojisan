# Angry Ojisan (web)

A mobile web remake of the Japanese party game **AngryOjisan**: a crowd of uncles, one of them secretly furious. Tap them one by one — wake the angry one and you lose. Choose a grid size (3×3 / 4×4 / 5×5 / 6×6).

**The twist:** Angry Selfie Mode. Take a selfie and **Gemini** (`gemini-3.1-flash-image`) cuts your face out, then **you pick the face you hide as** — Angry, Sad, Shocked, Drunk, Crazy, Disgust, Smug, or a typed Custom mood (any language). Your calm self fills the crowd; the face you chose hides in one cell. Each emotion is generated on demand and cached.

**Languages:** English (default), Simplified Chinese (中文), Thai (ไทย) — switch on the home screen; the choice is remembered.

## Stack

- **Frontend:** vanilla JS + CSS, zero frameworks. GPU-composited animations (transform/opacity only). Classic-mode characters are parametric inline SVGs — no image assets. All UI strings live in `public/i18n.js`.
- **Backend:** Node + Express (and a mirror Netlify Function). One AI endpoint: `POST /api/angrify` with `{ image, emotion, custom }` → one cut-out per call. Prompts + generation live in `lib/gemini.mjs`, shared by both backends so they never drift.
- **AI:** `gemini-3.1-flash-image` renders one cut-out per request — the requested emotion (or calm) — on a flat chroma-green backdrop (square 1:1, 1K); the client keys the green out to a transparent PNG (border-seeded flood-fill) and **rejects any result with no real green background** rather than showing an uncut photo. No other AI services.
- **No fallback:** if Gemini can't deliver, the UI shows an error and Selfie Mode does not proceed (Classic Uncles still plays without a key).
- **Image optimization:** selfies are downscaled client-side to ≤768px JPEG before upload; the server validates type and size; cut-outs are keyed/resized to ≤640px on the client. The biggest cost lever is generating *fewer* images — calm is made once, emotions are lazy + cached.

## Run locally

```sh
npm install
GEMINI_API_KEY=AIza... npm start
# open http://localhost:3000
```

Without the key the server still runs, but Selfie Mode is unavailable (no fallback) — Classic Uncles still plays.

## Deploy

**Netlify** (primary): `netlify.toml` serves `public/` and routes `POST /api/angrify` to `netlify/functions/angrify.mjs`. Set `GEMINI_API_KEY` in the site env. Selfie Mode generates up to a couple of images per request, so raise the **function timeout to 26s** (Pro plan: Site config → Functions → Function timeout); the function aborts Gemini at ~23s to always return within it.

**Render** (mirror): the repo also ships a `render.yaml` blueprint that runs `server.js`. Render Dashboard → New → Blueprint → pick the repo → set `GEMINI_API_KEY`.

## Privacy

Selfies are processed in-memory and never written to disk or logged. They are sent to the Google Gemini API to generate each cut-out.
