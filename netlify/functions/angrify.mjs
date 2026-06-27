// Netlify Function (v2) — POST /api/angrify.
//
// One request generates ONE photorealistic cut-out of the selfie for a given
// emotion, on a flat chroma-green backdrop the client keys out to a transparent
// sticker. The client orchestrates: it asks for "calm" (the board face) plus
// whichever emotion the player picks, and caches each result. There is NO
// server-side fallback — if Gemini can't deliver, we return an error and the
// client surfaces it (no fake/heuristic face is ever shown).
//
// Shared prompts + generation live in lib/gemini.mjs so this function and the
// Express server (server.js) never drift.

import { ALLOWED_EMOTIONS, geminiCutout, sanitizeCustom } from "../../lib/gemini.mjs";

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const HAS_GEMINI = Boolean(GEMINI_KEY);
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // client sends a ~768px JPEG (~120-300KB)

// Leave headroom under the platform timeout (26s on the Netlify Pro plan — set
// in Site config → Functions → Function timeout) so we return a clean JSON error
// rather than letting the platform kill the request.
const GEMINI_DEADLINE_MS = 23_000;

// Best-effort per-IP throttle. In-memory: resets on cold start and isn't shared
// across concurrent instances — acceptable for a party game. Each selfie now
// fans out to a few single-image calls, so the limit is a touch higher.
const RATE_LIMIT = 24;
const hits = new Map();
function rateLimited(ip) {
  if (hits.size > 5000) hits.clear();
  const now = Date.now();
  const windowStart = now - 60_000;
  const list = (hits.get(ip) || []).filter((t) => t > windowStart);
  if (list.length >= RATE_LIMIT) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default async (req, context) => {
  if (req.method !== "POST") return reply({ ok: false, reason: "method" }, 405);

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (rateLimited(ip)) return reply({ ok: false, reason: "rate_limited" }, 429);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return reply({ ok: false, reason: "bad_request" }, 400);
  }

  const image = payload?.image;
  const emotion = payload?.emotion;
  const custom = payload?.custom;
  if (typeof image !== "string") return reply({ ok: false, reason: "bad_request" }, 400);
  if (typeof emotion !== "string" || !ALLOWED_EMOTIONS.has(emotion)) {
    return reply({ ok: false, reason: "bad_emotion" }, 400);
  }
  // A custom mood that's empty / whitespace / quotes-only is a client mistake,
  // not an AI failure — say so with a 400 rather than a 502 image_failed.
  if (emotion === "custom" && !sanitizeCustom(custom)) {
    return reply({ ok: false, reason: "bad_request" }, 400);
  }

  const match = image.match(/^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !ALLOWED_MEDIA.has(match[1])) return reply({ ok: false, reason: "bad_image" }, 400);
  const [, mediaType, data] = match;
  if (data.length * 0.75 > MAX_IMAGE_BYTES) return reply({ ok: false, reason: "too_large" }, 413);
  if (!HAS_GEMINI) return reply({ ok: false, reason: "no_api_key" });

  const cutout = await geminiCutout({
    model: GEMINI_IMAGE_MODEL,
    key: GEMINI_KEY,
    mediaType,
    data,
    emotion,
    customText: custom,
    deadlineMs: GEMINI_DEADLINE_MS,
  });
  if (cutout) return reply({ ok: true, cutout });

  console.warn(`gemini cutout failed (${emotion})`);
  return reply({ ok: false, reason: "image_failed" }, 502);
};

// v2 functions can own a URL path directly — no redirect rule needed.
export const config = { path: "/api/angrify" };
