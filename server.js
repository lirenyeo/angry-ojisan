import express from "express";
import compression from "compression";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const anthropic = HAS_KEY ? new Anthropic() : null;

const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // decoded size cap; client sends ~1024px JPEG (~150-400KB)

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

// --- Simple per-IP rate limit for the AI endpoint (sliding 1-minute window) ---
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

// --- Structured output schema for face analysis ---
const point = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
};
const box = {
  type: "object",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    w: { type: "number" },
    h: { type: "number" },
  },
  required: ["x", "y", "w", "h"],
  additionalProperties: false,
};
const brow = {
  type: "object",
  properties: { inner: point, outer: point },
  required: ["inner", "outer"],
  additionalProperties: false,
};
const eye = {
  type: "object",
  properties: {
    x: { type: "number", description: "center x" },
    y: { type: "number", description: "center y" },
    w: { type: "number", description: "eye width" },
  },
  required: ["x", "y", "w"],
  additionalProperties: false,
};

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    faceDetected: {
      type: "boolean",
      description: "true only if a clear human face is visible",
    },
    face: {
      ...box,
      description:
        "tight bounding box of the face from top of forehead to chin",
    },
    tiltDegrees: {
      type: "number",
      description:
        "head roll in degrees, positive = head tilted clockwise from the viewer's perspective, 0 if upright",
    },
    leftBrow: {
      ...brow,
      description:
        "eyebrow on the LEFT side of the image (viewer's left). inner = end nearest the nose",
    },
    rightBrow: {
      ...brow,
      description:
        "eyebrow on the RIGHT side of the image (viewer's right). inner = end nearest the nose",
    },
    leftEye: { ...eye, description: "eye on the viewer's left" },
    rightEye: { ...eye, description: "eye on the viewer's right" },
    mouth: { ...box, description: "bounding box of the mouth/lips" },
    foreheadCenter: {
      ...point,
      description: "center of the forehead, between brows and hairline",
    },
    cheekLeft: { ...point, description: "center of the viewer-left cheek" },
    cheekRight: { ...point, description: "center of the viewer-right cheek" },
    angryQuote: {
      type: "string",
      description:
        "a short, hilarious furious outburst (max 60 chars) this exact person might scream when enraged — personalize it to what you see (clothes, hair, glasses, setting). No profanity. ALL CAPS with an exclamation.",
    },
    safeQuips: {
      type: "array",
      items: { type: "string" },
      description:
        "8 short, relaxed or silly one-liners (max 40 chars each) that calm characters say as they fly out of their boxes",
    },
  },
  required: [
    "faceDetected",
    "face",
    "tiltDegrees",
    "leftBrow",
    "rightBrow",
    "leftEye",
    "rightEye",
    "mouth",
    "foreheadCenter",
    "cheekLeft",
    "cheekRight",
    "angryQuote",
    "safeQuips",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the face-analysis engine for "Angry Ojisan", a silly party game. The player uploads a selfie; the game draws a cartoon ANGRY makeover (furious V-shaped eyebrows, red flush, throbbing anime anger vein) directly onto the photo at the coordinates you return, so precision matters.

Rules:
- Analyze the single most prominent human face in the image.
- ALL coordinates are normalized to the range 0..1 relative to the FULL image: x increases rightward, y increases downward.
- "left" always means the viewer's left (the left side of the image), NOT the subject's anatomical left.
- Eyebrow points must sit ON the eyebrows as they appear in the photo. The face box must be tight: top of forehead to chin.
- If there is no clear human face (pets, objects, fully covered faces), set faceDetected to false and fill every geometric field with 0 values — but still write the quotes.
- Quotes must be funny, family-friendly, and in English. Personalize angryQuote to visible details when possible.`;

function clamp01(n) {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
function sanitizePoint(p) {
  return { x: clamp01(p?.x), y: clamp01(p?.y) };
}
function sanitizeBox(b) {
  return { x: clamp01(b?.x), y: clamp01(b?.y), w: clamp01(b?.w), h: clamp01(b?.h) };
}
function sanitizeAnalysis(a) {
  return {
    faceDetected: Boolean(a?.faceDetected),
    face: sanitizeBox(a?.face),
    tiltDegrees: Math.max(-45, Math.min(45, Number(a?.tiltDegrees) || 0)),
    leftBrow: { inner: sanitizePoint(a?.leftBrow?.inner), outer: sanitizePoint(a?.leftBrow?.outer) },
    rightBrow: { inner: sanitizePoint(a?.rightBrow?.inner), outer: sanitizePoint(a?.rightBrow?.outer) },
    leftEye: { ...sanitizePoint(a?.leftEye), w: clamp01(a?.leftEye?.w) },
    rightEye: { ...sanitizePoint(a?.rightEye), w: clamp01(a?.rightEye?.w) },
    mouth: sanitizeBox(a?.mouth),
    foreheadCenter: sanitizePoint(a?.foreheadCenter),
    cheekLeft: sanitizePoint(a?.cheekLeft),
    cheekRight: sanitizePoint(a?.cheekRight),
    angryQuote: String(a?.angryQuote || "").slice(0, 80),
    safeQuips: Array.isArray(a?.safeQuips)
      ? a.safeQuips.slice(0, 8).map((q) => String(q).slice(0, 60))
      : [],
  };
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
  if (!HAS_KEY) {
    return res.json({ ok: false, reason: "no_api_key" });
  }

  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-opus-4-8",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
        },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data },
              },
              {
                type: "text",
                text: "Analyze this selfie for the angry makeover. Return precise normalized landmarks and the quotes.",
              },
            ],
          },
        ],
      },
      { timeout: 60_000, maxRetries: 0 },
    );

    if (response.stop_reason === "refusal") {
      return res.json({ ok: false, reason: "refused" });
    }
    if (response.stop_reason === "max_tokens") {
      // structured output only guarantees valid JSON when generation completed
      return res.json({ ok: false, reason: "truncated" });
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) {
      return res.json({ ok: false, reason: "empty" });
    }
    const analysis = sanitizeAnalysis(JSON.parse(textBlock.text));
    return res.json({ ok: true, analysis });
  } catch (err) {
    console.error("angrify error:", err?.status || "", err?.message || err);
    return res.status(502).json({ ok: false, reason: "ai_error" });
  }
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
  console.log(`AngryOjisan listening on :${PORT} (claude: ${HAS_KEY ? "enabled" : "DISABLED — set ANTHROPIC_API_KEY"})`);
});
