# Angry Ojisan (web)

A mobile web remake of the Japanese party game **AngryOjisan**: 16 boxes, 15 chill uncles, one of them is furious. Take turns opening boxes — whoever wakes the angry one loses.

**The twist:** Angry Selfie Mode. Take a selfie and Claude (vision + structured outputs) analyzes your face — returning precise eyebrow/eye/mouth landmarks plus a personalized angry quote — and the app composites a furious makeover onto your photo (V-brows, red flush, anime anger vein). Your angry self hides in one of the 16 boxes.

## Stack

- **Frontend:** vanilla JS + CSS, zero frameworks. All animations are GPU-composited (transform/opacity only). Classic-mode characters are parametric inline SVGs — no image assets.
- **Backend:** Node + Express. One AI endpoint: `POST /api/angrify`.
- **AI:** `claude-opus-4-8` with adaptive thinking and a JSON-schema structured output for face landmarks.
- **Image optimization:** selfies are downscaled client-side to ≤1024px JPEG (q0.85) before upload, capping upload size and vision token cost. Server validates type and size.

## Run locally

```sh
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

Without the key the server still runs; selfies fall back to a heuristic rage filter.

## Deploy (Render)

The repo ships a `render.yaml` blueprint:

1. Push to GitHub.
2. Render Dashboard → New → Blueprint → pick the repo.
3. Set `ANTHROPIC_API_KEY` when prompted.

## Privacy

Selfies are processed in-memory and never written to disk or logged. They are sent to the Anthropic API for analysis (subject to Anthropic's 30-day API data retention).
