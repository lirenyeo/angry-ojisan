// Netlify Function (v2) — ports POST /api/angrify from server.js.
//
// Gemini renders calm + furious cut-outs of the selfie on a flat chroma-green
// backdrop (a photo EDIT, kept photorealistic — never a cartoon); the client
// keys the green out to a transparent sticker. If Gemini is unavailable or slow
// the client falls back to a heuristic rage filter, so a failure here is soft.

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const HAS_GEMINI = Boolean(GEMINI_KEY);
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // client sends ~1024px JPEG (~150-400KB)

const CHROMA =
  "a perfectly uniform, flat, solid chroma-key green background (pure RGB 0,255,0), with absolutely no green anywhere on the person";

const REALISM =
  "Keep this a realistic photograph of the SAME real person — do NOT cartoonify, " +
  "stylize, illustrate or repaint them; preserve their real hair, glasses, skin texture " +
  "and natural photographic lighting. It must still look like an actual photo of them.";

const GEMINI_CALM_PROMPT =
  "Edit this photo. " +
  REALISM +
  " Cut out just their head, neck and the very top of their shoulders, centered, on " +
  CHROMA +
  ". Keep a calm, neutral expression. Photorealistic, square framing.";

const GEMINI_ANGRY_PROMPT =
  "Edit this photo. " +
  REALISM +
  " Cut out just their head, neck and the very top of their shoulders, centered, on " +
  CHROMA +
  ". Change ONLY their expression to comically, over-the-top FURIOUS: deeply furrowed " +
  "V-shaped eyebrows, intense glaring eyes, gritted teeth or an open shouting mouth, and " +
  "flushed red cheeks — exaggerated and funny, but still a real photo of them, never gory " +
  "or scary. Keep the same hair, glasses, skin tone and framing. Photorealistic, square framing.";

// Netlify synchronous functions cap at ~10s, so one fast attempt with a sub-10s
// abort (the two cut-outs run in parallel). No retries — the client degrades
// gracefully to the heuristic filter.
const GEMINI_TIMEOUT_MS = 9000;

// Best-effort per-IP throttle. In-memory: resets on cold start and isn't shared
// across concurrent instances — acceptable for a party game.
const RATE_LIMIT = 10;
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

// Edit the selfie with Gemini and return a data URL, or null on any failure.
async function geminiCutout(mediaType, data, angry) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: mediaType, data } },
          { text: angry ? GEMINI_ANGRY_PROMPT : GEMINI_CALM_PROMPT },
        ],
      },
    ],
    generationConfig: { responseModalities: ["IMAGE"] },
  });
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(`gemini http ${resp.status} (${angry ? "angry" : "calm"})`, detail.slice(0, 200));
      return null;
    }
    const json = await resp.json();
    const parts = json?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      const inline = p.inlineData || p.inline_data;
      if (inline?.data) {
        const mt = inline.mimeType || inline.mime_type || "image/png";
        return `data:${mt};base64,${inline.data}`;
      }
    }
    console.warn(
      `gemini no image (${angry ? "angry" : "calm"}) finishReason=${json?.candidates?.[0]?.finishReason}`,
    );
  } catch (err) {
    console.error(`gemini error (${angry ? "angry" : "calm"})`, err?.name || "", err?.message || "");
  }
  return null;
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
  if (typeof image !== "string") return reply({ ok: false, reason: "bad_request" }, 400);

  const match = image.match(/^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !ALLOWED_MEDIA.has(match[1])) return reply({ ok: false, reason: "bad_image" }, 400);
  const [, mediaType, data] = match;
  if (data.length * 0.75 > MAX_IMAGE_BYTES) return reply({ ok: false, reason: "too_large" }, 413);
  if (!HAS_GEMINI) return reply({ ok: false, reason: "no_api_key" });

  // calm + furious cut-outs (on a green screen) in parallel
  const [calm, angry] = await Promise.all([
    geminiCutout(mediaType, data, false),
    geminiCutout(mediaType, data, true),
  ]);
  if (calm && angry) return reply({ ok: true, kind: "cutout", calm, angry });

  console.warn(`gemini cutout incomplete (calm:${!!calm} angry:${!!angry})`);
  return reply({ ok: false, reason: "image_failed" }, 502);
};

// v2 functions can own a URL path directly — no redirect rule needed.
export const config = { path: "/api/angrify" };
