import express from "express";
import compression from "compression";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const HAS_GEMINI = Boolean(GEMINI_KEY);
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // decoded cap; client sends ~1024px JPEG (~150-400KB)

app.disable("x-powered-by");
app.use(compression());
app.use(express.json({ limit: "3mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; base-uri 'self'; form-action 'self'",
  );
  next();
});

// --- Per-IP rate limit for the AI endpoint (sliding 1-minute window) ---
const RATE_LIMIT = 10;
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  if (hits.size > 5000) hits.clear(); // hard cap against spoofed-IP key flooding
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
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [ip, list] of hits) {
    const fresh = list.filter((t) => t > cutoff);
    if (fresh.length === 0) hits.delete(ip);
    else hits.set(ip, fresh);
  }
}, 60_000).unref();

/* ===================== Gemini image cut-outs ===================== */

// The model returns opaque JPEG (no alpha), so we ask for a flat chroma-green
// backdrop and key it out to transparent on the client.
const CHROMA =
  "a perfectly uniform, flat, solid chroma-key green background (pure RGB 0,255,0), with absolutely no green anywhere on the person";

// Both prompts frame the job as a creative cartoon-sticker EDIT, not photo
// reproduction — the model occasionally returns finishReason:NO_IMAGE when a
// prompt reads like "reproduce this real person", so we keep it clearly stylized.
const GEMINI_CALM_PROMPT =
  "Create a fun cartoon-avatar sticker of this person: keep just their head, neck and the very " +
  "top of their shoulders, centered, on " +
  CHROMA +
  ". Keep their hair, glasses, skin tone and a calm, neutral expression, lightly stylized like " +
  "a friendly cartoon. Square framing.";

const GEMINI_ANGRY_PROMPT =
  "Create a fun cartoon-avatar sticker of this person: keep just their head, neck and the very " +
  "top of their shoulders, centered, on " +
  CHROMA +
  ". Make their expression comically FURIOUS and enraged: deeply furrowed angry V-shaped " +
  "eyebrows, intense glaring eyes, gritted teeth or an open shouting mouth, and flushed " +
  "bright-red cheeks. Keep it clearly the SAME recognizable person — same hair, glasses, skin " +
  "tone and framing — exaggerated and funny, never gory or scary. Square framing.";

const GEMINI_ATTEMPTS = 3; // NO_IMAGE / transient errors return fast, so retrying is cheap

// Edit the selfie with Gemini and return a data URL, or null after all retries.
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
  for (let attempt = 1; attempt <= GEMINI_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        signal: AbortSignal.timeout(40_000), // two run in parallel; stay under the client abort
        body,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        console.error(`gemini http ${resp.status} (${angry ? "angry" : "calm"} ${attempt}/${GEMINI_ATTEMPTS})`, detail.slice(0, 200));
        continue;
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
        `gemini no image (${angry ? "angry" : "calm"} ${attempt}/${GEMINI_ATTEMPTS}) finishReason=${json?.candidates?.[0]?.finishReason}`,
      );
    } catch (err) {
      console.error(`gemini error (${angry ? "angry" : "calm"} ${attempt}/${GEMINI_ATTEMPTS})`, err?.name || "", err?.message || "");
    }
  }
  return null;
}

app.post("/api/angrify", async (req, res) => {
  // Rightmost x-forwarded-for entry is appended by Render's own proxy and is
  // not client-spoofable (unlike the leftmost entry).
  const fwd = req.headers["x-forwarded-for"];
  const ip =
    (typeof fwd === "string" && fwd.split(",").map((s) => s.trim()).filter(Boolean).pop()) ||
    req.ip;
  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, reason: "rate_limited" });
  }

  const image = req.body?.image;
  if (typeof image !== "string") {
    return res.status(400).json({ ok: false, reason: "bad_request" });
  }
  const match = image.match(/^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !ALLOWED_MEDIA.has(match[1])) {
    return res.status(400).json({ ok: false, reason: "bad_image" });
  }
  const [, mediaType, data] = match;
  if (data.length * 0.75 > MAX_IMAGE_BYTES) {
    return res.status(413).json({ ok: false, reason: "too_large" });
  }
  if (!HAS_GEMINI) {
    return res.json({ ok: false, reason: "no_api_key" });
  }

  // Gemini renders calm + furious cut-outs (on a green screen) in parallel.
  const [calm, angry] = await Promise.all([
    geminiCutout(mediaType, data, false),
    geminiCutout(mediaType, data, true),
  ]);
  if (calm && angry) {
    return res.json({ ok: true, kind: "cutout", calm, angry });
  }
  console.warn(`gemini cutout incomplete (calm:${!!calm} angry:${!!angry})`);
  return res.status(502).json({ ok: false, reason: "image_failed" });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// Static assets are unfingerprinted, so use ETag revalidation (cheap 304s)
// instead of a time-based cache that would serve stale code after deploys.
app.use(
  express.static(join(__dirname, "public"), {
    index: false,
    etag: true,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    },
  }),
);
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(
    `AngryOjisan listening on :${PORT} (gemini cut-outs: ${HAS_GEMINI ? GEMINI_IMAGE_MODEL : "off — set GEMINI_API_KEY"})`,
  );
});
