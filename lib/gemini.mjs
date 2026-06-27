// Shared Gemini cut-out logic for BOTH backends (the Netlify function and the
// Express server) so prompts, the allowed emotion set, and the request shape
// never drift between them.
//
// One call = one image. The model returns an opaque image (no alpha), so we ask
// for the subject on a flat chroma-green backdrop and the client keys it out to
// a transparent sticker. Every emotion shares byte-for-byte identical framing /
// background / lighting sentences — only the expression clause changes — so the
// independent generations register on top of each other and the chroma key
// stays clean.

export const CHROMA =
  "a perfectly uniform, flat, solid chroma-key green background (pure RGB 0,255,0), " +
  "edge to edge in a single shade with no gradient, vignette or lighting falloff, " +
  "with absolutely no green anywhere on the person and no green spill or tint on " +
  "their skin, hair or clothing";

// Framing the job as an EDIT of the supplied photo (not "reproduce this person
// from scratch") keeps Gemini from bailing with finishReason:NO_IMAGE while
// still returning a REAL photo. We forbid cartoonifying so it stays photoreal.
export const REALISM =
  "Keep this a realistic photograph of the SAME real person — do NOT cartoonify, " +
  "stylize, illustrate or repaint them; preserve their real hair, glasses, skin texture " +
  "and natural photographic lighting. It must still look like an actual photo of them.";

// Each value is the {EXPRESSION} clause. Vivid + exaggerated + funny, but always
// "still a real photo of them, never gory or scary".
export const EMOTION_MODIFIERS = {
  angry:
    "comically, over-the-top FURIOUS: eyebrows slammed down into a deep angry V, " +
    "eyes glaring wide, nostrils flared, teeth gritted or mouth open mid-shout, and " +
    "cheeks flushed hot red — exaggerated and funny but still a real photo of them, " +
    "never gory or scary.",
  sad:
    "theatrically SAD: eyebrows pulled up and together into a pleading arch, glossy " +
    "watery puppy-dog eyes brimming with tears, a trembling down-turned pout and one " +
    "big comic tear rolling down a cheek — over-dramatic like a soap-opera close-up, " +
    "still a real photo of them, never gory or scary.",
  shocked:
    "hugely SHOCKED and gobsmacked: eyebrows shot sky-high, eyes bugged wide open " +
    "showing the whites all around, and the jaw dropped into a giant round 'O' of " +
    "disbelief — exaggerated and funny but still a real photo of them, never gory or scary.",
  drunk:
    "goofily DRUNK and tipsy: heavy droopy half-closed eyelids, an unfocused woozy " +
    "gaze, rosy flushed cheeks and a pink nose, and a loopy lopsided dopey grin — " +
    "happily wobbly and silly, still a real photo of them, never sick, never scary.",
  laughing:
    "hysterically CRAZY-LAUGHING: eyes squeezed into joyful creased slits, mouth thrown " +
    "wide open in a giant belly laugh, cheeks bunched up high and a happy tear glinting " +
    "at the corner of one eye — completely losing it, exaggerated but still a real photo " +
    "of them, never scary.",
  disgusted:
    "massively DISGUSTED and grossed-out: nose scrunched and wrinkled up tight, upper " +
    "lip curled into a sneer baring a bit of teeth, one eye squinted and eyebrows knotted " +
    "— like they just smelled something rancid, comically over-the-top but still a real " +
    "photo of them, never gory or scary.",
  smug:
    "insufferably SMUG and self-satisfied: one eyebrow cocked high, eyelids lowered into " +
    "a knowing half-lidded look, and a sly lopsided smirk pulling up one corner of the " +
    "mouth — radiating pure 'I was right and you know it' energy, cheeky and funny but " +
    "still a real photo of them, never scary.",
};

// "calm" is the neutral board face; "custom" is a user-typed mood (any language).
export const ALLOWED_EMOTIONS = new Set([
  "calm",
  ...Object.keys(EMOTION_MODIFIERS),
  "custom",
]);

const CALM_EXPRESSION =
  "Give them a calm, relaxed, neutral expression — mouth gently closed, eyes open " +
  "and looking softly at the camera, with no strong emotion.";

// Strip anything that could derail the edit (control chars via the Unicode
// control category, plus our own quote marks), collapse whitespace, and hard-cap
// the length. Any language is fine — Gemini handles it.
export function sanitizeCustom(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/["“”`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function expressionFor(emotion, customText) {
  if (emotion === "calm") return CALM_EXPRESSION;
  if (emotion === "custom") {
    const clean = sanitizeCustom(customText);
    if (!clean) return null;
    return (
      'Change ONLY their facial expression and mood to match this description: "' +
      clean +
      '". Interpret it purely as an exaggerated, funny facial expression and apply it as ' +
      "a real photo of them — never gory, never scary, and never add any text, words or " +
      "objects to the image."
    );
  }
  const mod = EMOTION_MODIFIERS[emotion];
  return mod ? "Change ONLY their facial expression to " + mod : null;
}

// Returns the full prompt, or null for an unknown/empty emotion.
export function buildPrompt(emotion, customText) {
  const expression = expressionFor(emotion, customText);
  if (!expression) return null;
  return (
    "Edit this photo. " +
    REALISM +
    " Cut out only their head, neck and the very top of their shoulders and center them " +
    "in the frame, facing forward toward the camera, with the top of the head near the " +
    "top edge and the head filling roughly the same large share of the frame. Place them " +
    "on " +
    CHROMA +
    ". Do not add any props, hats, hands, text, captions, borders, vignette, drop shadows " +
    "or background blur, and add nothing behind or beside them. " +
    expression +
    " Keep exactly the same person, hair, hairstyle, glasses, facial hair, skin tone and " +
    "age as the original photo, and keep the same head size, position and framing. Keep it " +
    "a photorealistic real photograph, square 1:1 framing, sharp focus with crisp edges " +
    "against the green, even soft frontal lighting."
  );
}

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_ATTEMPTS = 3;

// Generate ONE cut-out. Returns a data URL, or null on any failure. Retries
// cheaply within a wall-clock deadline (NO_IMAGE / transient 5xx return fast);
// 4xx (bad request / safety / quota) won't fix on retry, so we bail immediately.
export async function geminiCutout({
  model,
  key,
  mediaType,
  data,
  emotion,
  customText,
  deadlineMs = 23_000,
}) {
  const prompt = buildPrompt(emotion, customText);
  if (!prompt) return null;
  const url = `${ENDPOINT}/${model}:generateContent`;

  // imageConfig locks square framing + 1K (1024px) output — predictable crop,
  // smallest sensible size for a sticker that renders small in-game. If the API
  // rejects that field (model/endpoint variance) we drop it and retry on the
  // known-good request shape, so a field surprise can't take Selfie Mode down.
  const makeBody = (withImageConfig) =>
    JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: mediaType, data } }, { text: prompt }],
        },
      ],
      generationConfig: withImageConfig
        ? { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "1K" } }
        : { responseModalities: ["IMAGE"] },
    });

  const deadline = Date.now() + deadlineMs;
  let withImageConfig = true;
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS && Date.now() < deadline) {
    attempt++;
    const remaining = deadline - Date.now();
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(Math.min(remaining, 22_000)),
        body: makeBody(withImageConfig),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        console.error(`gemini http ${resp.status} (${emotion} #${attempt})`, detail.slice(0, 200));
        if (resp.status === 400 && withImageConfig) {
          withImageConfig = false; // drop the optional field and retry (free probe)
          attempt--;
          console.warn(`gemini dropping imageConfig and retrying (${emotion})`);
          continue;
        }
        if (resp.status >= 400 && resp.status < 500) return null; // not retryable
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
      console.warn(`gemini no image (${emotion} #${attempt}) finishReason=${json?.candidates?.[0]?.finishReason}`);
    } catch (err) {
      console.error(`gemini error (${emotion} #${attempt})`, err?.name || "", err?.message || "");
      if (err?.name === "TimeoutError" || err?.name === "AbortError") return null; // out of time
    }
  }
  return null;
}
