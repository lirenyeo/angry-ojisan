import express from "express";
import compression from "compression";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_EMOTIONS, geminiCutout, sanitizeCustom } from "./lib/gemini.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const HAS_GEMINI = Boolean(GEMINI_KEY);
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // decoded cap; client sends a ~768px JPEG (~120-300KB)

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

// One request = ONE cut-out for the requested emotion. The client asks for
// "calm" (the board face) plus whichever emotion the player picks, and caches
// each result. There is NO server-side fallback — a failure returns an error and
// the client surfaces it. Prompts + generation live in lib/gemini.mjs, shared
// with the Netlify function so the two backends never drift.
const GEMINI_DEADLINE_MS = 23_000;

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
  const emotion = req.body?.emotion;
  const custom = req.body?.custom;
  if (typeof image !== "string") {
    return res.status(400).json({ ok: false, reason: "bad_request" });
  }
  if (typeof emotion !== "string" || !ALLOWED_EMOTIONS.has(emotion)) {
    return res.status(400).json({ ok: false, reason: "bad_emotion" });
  }
  // A custom mood that's empty / whitespace / quotes-only is a client mistake,
  // not an AI failure — say so with a 400 rather than a 502 image_failed.
  if (emotion === "custom" && !sanitizeCustom(custom)) {
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

  const cutout = await geminiCutout({
    model: GEMINI_IMAGE_MODEL,
    key: GEMINI_KEY,
    mediaType,
    data,
    emotion,
    customText: custom,
    deadlineMs: GEMINI_DEADLINE_MS,
  });
  if (cutout) {
    return res.json({ ok: true, cutout });
  }
  console.warn(`gemini cutout failed (${emotion})`);
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
