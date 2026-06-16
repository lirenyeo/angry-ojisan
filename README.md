# Angry Ojisan (web)

A mobile web remake of the Japanese party game **AngryOjisan**: a crowd of uncles, one of them secretly furious. Tap them one by one — wake the angry one and you lose. Choose a grid size (3×3 / 4×4 / 5×5 / 6×6).

**The twist:** Angry Selfie Mode. Take a selfie and **Gemini** (`gemini-3.1-flash-image`) cuts your face out and renders an enraged version of it. Your calm self fills the crowd; your furious self hides in one cell.

**Languages:** English (default), Simplified Chinese (中文), Thai (ไทย) — switch on the home screen; the choice is remembered.

## Stack

- **Frontend:** vanilla JS + CSS, zero frameworks. GPU-composited animations (transform/opacity only). Classic-mode characters are parametric inline SVGs — no image assets. All UI strings live in `public/i18n.js`.
- **Backend:** Node + Express. One AI endpoint: `POST /api/angrify`.
- **AI:** `gemini-3.1-flash-image` renders calm + furious cut-outs of the face on a flat chroma-green backdrop; the client keys the green out to a transparent PNG (border-seeded flood-fill). No other AI services.
- **Image optimization:** selfies are downscaled client-side to ≤1024px JPEG before upload; the server validates type and size; cut-outs are keyed/resized to ≤640px on the client.
- **Fallback:** if Gemini is unavailable, a self-contained heuristic canvas filter still produces an angry face so the game keeps working.

## Run locally

```sh
npm install
GEMINI_API_KEY=AIza... npm start
# open http://localhost:3000
```

Without the key the server still runs; selfies fall back to the heuristic rage filter.

## Deploy (Render)

The repo ships a `render.yaml` blueprint:

1. Push to GitHub.
2. Render Dashboard → New → Blueprint → pick the repo.
3. Set `GEMINI_API_KEY` when prompted.

## Privacy

Selfies are processed in-memory and never written to disk or logged. They are sent to the Google Gemini API to generate the angry cut-out.
