import { classicSet, makeOjisan } from "./characters.js";
import { STRINGS, getLang, setLang, t } from "./i18n.js";

/* ============================== State ============================== */

const state = {
  mode: "classic", // 'classic' | 'selfie'
  grid: 16, // total cells: 9 | 16 | 25 | 36
  angryIndex: 0,
  openedCount: 0,
  over: false,
  busy: false, // guards selfie processing (not gameplay taps)
  round: 0, // bumped on every newRound so stale open-timeouts can bail
  classic: null, // {calm[], seeds[]}
  selfie: null, // { src, calm, emotions:{id:dataUrl}, chosen, customText, generating }
  pickedEmotion: null, // step-1 choice before a selfie exists
  pickedCustom: "", // custom mood text for the step-1 choice
  selfieToken: 0, // bumped on every selfie-screen entry; invalidates in-flight captures
  drinks: null, // per-cell drink instruction (or null) for this round — the drinking game
  drinkEnabled: true, // home-screen toggle; off = no drinking instructions at all
  drinkRules: [], // ordered dare list: built-ins + custom, each { id, builtin, i18n|text, icon, enabled }
};

const $ = (sel) => document.querySelector(sel);
const screens = {
  home: $("#screen-home"),
  selfie: $("#screen-selfie"),
  game: $("#screen-game"),
};

function show(name) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle("active", k === name);
  }
}

/* ============================== Audio ============================== */

let actx = null;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  if (actx.state === "suspended") actx.resume();
  return actx;
}

function tone({ type = "sine", from = 440, to = 440, dur = 0.15, vol = 0.2, delay = 0 }) {
  const ctx = audio();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function popSound() {
  tone({ type: "sine", from: 520, to: 880, dur: 0.12, vol: 0.25 });
  tone({ type: "triangle", from: 220, to: 140, dur: 0.1, vol: 0.12, delay: 0.02 });
}
function tickSound() {
  tone({ type: "square", from: 1400, to: 1400, dur: 0.03, vol: 0.05 });
}
function angryRoar() {
  const ctx = audio();
  if (!ctx) return;
  // low growl: detuned saws + downward pitch
  for (const detune of [0, 7, -9]) {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const dist = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(3 * x);
    }
    dist.curve = curve;
    osc.type = "sawtooth";
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(160, t0);
    osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.9);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.1);
    osc.connect(dist).connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 1.2);
  }
  tone({ type: "square", from: 90, to: 40, dur: 0.5, vol: 0.18 });
}

function buzz(ms) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

/* ====================== Image helpers (selfie) ====================== */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Downscale + recompress a user photo to <=768px JPEG before upload. Smaller
 *  input means a faster Gemini round-trip; 768px keeps a single face sharp. */
async function optimizeFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const MAX = 768;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// One request -> one cut-out for `emotion` (+ free-text `custom` for the custom
// mood). Returns the server payload { ok, cutout } or { ok:false, reason }.
// Never throws — a network failure resolves to { ok:false }.
async function requestAngrify(dataUrl, emotion, custom) {
  const controller = new AbortController();
  // One image per call now, so a tight bound is fine; the server returns within
  // the platform timeout (26s on the Netlify Pro plan).
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("/api/angrify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, emotion, custom }),
      signal: controller.signal,
    });
    return await res.json();
  } catch {
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

// Gemini returns the subject on a flat chroma-green backdrop (no alpha). Knock
// the green out to transparent so it becomes a clean cut-out sticker, flood-
// filling inward from the borders through connected green only (so green in the
// SUBJECT keeps its pixels). Returns { dataUrl, removed } where `removed` is the
// fraction of pixels cleared; near-zero means Gemini didn't actually produce a
// green background — a bad cut-out the caller should reject rather than show as
// a full uncut photo. Returns null on a decode error.
async function chromaKeyCutout(dataUrl, max = 640) {
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;

    const isGreen = (i) => {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      return g > 80 && g > r * 1.2 && g > b * 1.2; // tolerant: catches JPEG-noisy green
    };
    // Flood from every border pixel; alpha 0 doubles as the visited marker.
    let cleared = 0;
    const stack = [];
    const visit = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0 || !isGreen(i)) return;
      d[i + 3] = 0;
      cleared++;
      stack.push(x, y);
    };
    for (let x = 0; x < w; x++) {
      visit(x, 0);
      visit(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      visit(0, y);
      visit(w - 1, y);
    }
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      visit(x + 1, y);
      visit(x - 1, y);
      visit(x, y + 1);
      visit(x, y - 1);
    }

    // Despill + soften only the cut edge (kept pixels touching transparency),
    // so legit interior greens aren't discoloured.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] === 0) continue;
        const edge =
          (x > 0 && d[i - 4 + 3] === 0) ||
          (x < w - 1 && d[i + 4 + 3] === 0) ||
          (y > 0 && d[i - w * 4 + 3] === 0) ||
          (y < h - 1 && d[i + w * 4 + 3] === 0);
        if (!edge) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (g > Math.max(r, b)) d[i + 1] = Math.max(r, b); // kill green fringe
        d[i + 3] = Math.round(d[i + 3] * 0.85); // soften the hard cut
      }
    }
    ctx.putImageData(id, 0, 0);
    return { dataUrl: c.toDataURL("image/png"), removed: cleared / (w * h) };
  } catch {
    return null;
  }
}

// Request + key out one emotion. Returns a transparent-PNG data URL, or null if
// generation failed OR the result had no real green background to key (so we
// never show a full uncut photo as a "sticker").
async function generateCutout(src, emotion, custom) {
  const res = await requestAngrify(src, emotion, custom);
  if (!res?.ok || typeof res.cutout !== "string") return null;
  const keyed = await chromaKeyCutout(res.cutout);
  if (!keyed || keyed.removed < 0.05) return null;
  return keyed.dataUrl;
}

/* --------------------- Emotion picker (selfie) --------------------- */

// Bold colourful cartoon emoticon faces drawn as inline SVG (64x64, no emoji
// font) — the chip selected state is an amber ring (not a tint) so the faces
// stay colourful, and the face is swapped for the anger-vein spinner while its
// cut-out generates. Order here = order in the grid.
const EMO_ORDER = ["angry", "sad", "shocked", "drunk", "laughing", "disgusted", "smug"];

const EMO_ICON = {
  angry:
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="#ffce47"/><circle cx="32" cy="32" r="25" fill="none" stroke="#e3a52f" stroke-width="2"/><ellipse cx="18" cy="39" rx="5.5" ry="3.4" fill="#ff5b4d" opacity="0.5"/><ellipse cx="46" cy="39" rx="5.5" ry="3.4" fill="#ff5b4d" opacity="0.5"/><g stroke="#3a2a14" stroke-width="4.5" stroke-linecap="round"><path d="M15 21 L28 27"/><path d="M49 21 L36 27"/></g><circle cx="23" cy="31" r="3.1" fill="#3a2a14"/><circle cx="41" cy="31" r="3.1" fill="#3a2a14"/><path d="M22 47 Q32 39 42 47 Q32 52 22 47 Z" fill="#7a2016"/><path d="M25 45.6 Q32 42.8 39 45.6 L38 47.4 Q32 45.1 26 47.4 Z" fill="#fff"/><g stroke="#e3372b" stroke-width="2.3" stroke-linecap="round" fill="none"><path d="M46 13 Q49 16 46 19"/><path d="M53 13 Q50 16 53 19"/><path d="M46.5 12 Q49.5 9 52.5 12"/></g></svg>`,
  sad:
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="#ffce47"/><circle cx="32" cy="32" r="25" fill="none" stroke="#e3a52f" stroke-width="2"/><g stroke="#3a2a14" stroke-width="4" stroke-linecap="round" fill="none"><path d="M16 26 Q23 21 29 25"/><path d="M48 26 Q41 21 35 25"/></g><circle cx="23" cy="32" r="3.1" fill="#3a2a14"/><circle cx="41" cy="32" r="3.1" fill="#3a2a14"/><path d="M19 35 q-3.4 6 0 8 q3.4 -2 0 -8 z" fill="#4db6f0"/><path d="M23 48 Q32 41 41 48" stroke="#3a2a14" stroke-width="4" stroke-linecap="round" fill="none"/></svg>`,
  shocked:
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="#ffce47"/><circle cx="32" cy="32" r="25" fill="none" stroke="#e3a52f" stroke-width="2"/><g stroke="#3a2a14" stroke-width="3.6" stroke-linecap="round" fill="none"><path d="M16 21 Q23 17 30 21"/><path d="M48 21 Q41 17 34 21"/></g><circle cx="23" cy="31" r="5.4" fill="#fff" stroke="#3a2a14" stroke-width="2"/><circle cx="41" cy="31" r="5.4" fill="#fff" stroke="#3a2a14" stroke-width="2"/><circle cx="23" cy="32" r="2.3" fill="#3a2a14"/><circle cx="41" cy="32" r="2.3" fill="#3a2a14"/><ellipse cx="32" cy="47" rx="4.6" ry="6" fill="#7a2016"/></svg>`,
  drunk:
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="#ffce47"/><circle cx="32" cy="32" r="25" fill="none" stroke="#e3a52f" stroke-width="2"/><ellipse cx="18" cy="38" rx="5.5" ry="3.4" fill="#ff8fb0" opacity="0.6"/><ellipse cx="46" cy="38" rx="5.5" ry="3.4" fill="#ff8fb0" opacity="0.6"/><g stroke="#3a2a14" stroke-width="3.4" stroke-linecap="round" fill="none"><path d="M18 30 Q23 34 28 30"/><path d="M36 30 Q41 34 46 30"/><path d="M22 46 Q27 50 32 46 Q37 42 42 46"/></g></svg>`,
  laughing:
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="#ffce47"/><circle cx="32" cy="32" r="25" fill="none" stroke="#e3a52f" stroke-width="2"/><g stroke="#3a2a14" stroke-width="3.8" stroke-linecap="round" fill="none"><path d="M17 31 Q23 25 29 31"/><path d="M35 31 Q41 25 47 31"/></g><path d="M19 39 Q32 57 45 39 Z" fill="#7a2016"/><path d="M20.5 40 Q32 44.5 43.5 40 L42.4 42.8 Q32 46.4 21.6 42.8 Z" fill="#fff"/><path d="M27 51 Q32 56 37 51 Q32 48 27 51 Z" fill="#ff7a7a"/></svg>`,
  disgusted:
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="#c3d24a"/><circle cx="32" cy="32" r="25" fill="none" stroke="#9bb235" stroke-width="2"/><g stroke="#3a2a14" stroke-width="4" stroke-linecap="round"><path d="M16 24 L28 27"/><path d="M48 24 L36 27"/></g><path d="M19 32 Q23 29 27 32" stroke="#3a2a14" stroke-width="3.2" stroke-linecap="round" fill="none"/><circle cx="41" cy="31" r="3" fill="#3a2a14"/><path d="M29 35 Q32 33 35 35" stroke="#3a2a14" stroke-width="2.3" stroke-linecap="round" fill="none"/><path d="M22 47 Q27 44 32 47 Q37 50 42 44.5" stroke="#3a2a14" stroke-width="3.4" stroke-linecap="round" fill="none"/></svg>`,
  smug:
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="#ffce47"/><circle cx="32" cy="32" r="25" fill="none" stroke="#e3a52f" stroke-width="2"/><path d="M16 23 Q23 18 30 23" stroke="#3a2a14" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M35 27 L47 27" stroke="#3a2a14" stroke-width="4" stroke-linecap="round"/><g stroke="#3a2a14" stroke-width="3.4" stroke-linecap="round"><path d="M19 32 L28 32"/><path d="M36 32 L45 32"/></g><path d="M22 46 Q32 50 43 43" stroke="#3a2a14" stroke-width="3.6" stroke-linecap="round" fill="none"/></svg>`,
  custom:
    `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="#ffce47"/><circle cx="32" cy="32" r="25" fill="none" stroke="#e3a52f" stroke-width="2"/><circle cx="23" cy="29" r="2.9" fill="#3a2a14"/><circle cx="41" cy="29" r="2.9" fill="#3a2a14"/><path d="M24 43 Q32 47 40 43" stroke="#3a2a14" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="0.5 4.6" fill="none"/><g transform="translate(34 34)"><path d="M1.5 17 L3 10.5 L13.5 0 L18.5 5 L8 15.5 L1.5 17 Z" fill="#f0a432" stroke="#6b4a12" stroke-width="1.6" stroke-linejoin="round"/><path d="M11 3 L15.5 7.5" stroke="#6b4a12" stroke-width="1.6"/></g></svg>`,
};

const VEIN_SPINNER =
  `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="currentColor" stroke-width="11" stroke-linecap="round" fill="none"><path d="M22 38 Q34 18 50 33"/><path d="M78 38 Q66 18 50 33"/><path d="M22 62 Q34 82 50 67"/><path d="M78 62 Q66 82 50 67"/></g></svg>`;
const CHECK_ICON =
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const labelKey = (id) => "emo" + id.charAt(0).toUpperCase() + id.slice(1);
const chipEl = (id) => document.querySelector(`.emo-chip[data-emo="${id}"]`);

// Build the 7-emotion + custom grid. Labels resolve through i18n at build time
// (language is chosen on the home screen, before this ever renders).
function renderEmotionPicker() {
  const label = (id) => t(labelKey(id));
  const chip = (id) =>
    `<button class="emo-chip" type="button" role="radio" aria-checked="false" data-emo="${id}" title="${label(id)}">` +
    `<span class="emo-icon" aria-hidden="true">${EMO_ICON[id]}</span>` +
    `<span class="emo-spinner" aria-hidden="true">${VEIN_SPINNER}</span>` +
    `<span class="emo-label">${label(id)}</span>` +
    `<span class="emo-badge" aria-hidden="true">${CHECK_ICON}</span>` +
    `</button>`;
  $("#emotion-grid").innerHTML = [...EMO_ORDER, "custom"].map(chip).join("");
  const input = $("#custom-input");
  input.value = "";
  input.placeholder = t("emoCustomPh");
  $("#custom-row").classList.add("hidden");
}

// Per-chip lifecycle class (idle | generating | ready | error). `is-selected`
// is managed separately by markSelected so a chip can be ready AND selected.
function setChip(id, status) {
  const chip = chipEl(id);
  if (!chip) return;
  chip.classList.remove("is-generating", "is-error");
  if (status === "generating") chip.classList.add("is-generating");
  else if (status === "error") chip.classList.add("is-error");
  else if (status === "ready") chip.classList.add("is-ready");
}

function markSelected(id) {
  document.querySelectorAll(".emo-chip").forEach((c) => {
    const on = c.dataset.emo === id;
    c.classList.toggle("is-selected", on);
    c.setAttribute("aria-checked", String(on));
  });
}

function setPreviewLoading(on) {
  $("#preview-emotion-fig").classList.toggle("is-loading", on);
}

function setPreviewCaption(id, custom) {
  $("#preview-emotion-cap").textContent = id === "custom" && custom ? custom : t(labelKey(id));
}

function enableStart(on) {
  $("#btn-selfie-start").disabled = !on;
}

// Put the preview back to the last good chosen emotion (so a failed generation
// never leaves the slot blank).
function revertPreview() {
  const sf = state.selfie;
  if (sf?.chosen && sf.emotions[sf.chosen]) {
    $("#preview-angry").src = sf.emotions[sf.chosen];
    setPreviewCaption(sf.chosen, sf.customText);
  }
}

// Tap a chip: cached emotions select instantly; otherwise generate (one at a
// time). Custom is routed to its text input by the caller.
function selectEmotion(id) {
  const sf = state.selfie;
  if (!sf) return;
  if (sf.emotions[id]) {
    sf.chosen = id;
    markSelected(id);
    setChip(id, "ready");
    $("#preview-angry").src = sf.emotions[id];
    setPreviewCaption(id, sf.customText);
    setPreviewLoading(false);
    enableStart(true);
    $("#selfie-note").textContent = t("noteReady");
    return;
  }
  if (sf.generating) return; // one generation at a time (cached re-selects allowed above)
  generateEmotion(id);
}

async function generateEmotion(id, custom) {
  const sf = state.selfie;
  if (!sf) return;
  sf.generating = id;
  setChip(id, "generating");
  setPreviewLoading(true);
  setPreviewCaption(id, custom);
  $("#selfie-note").textContent = t("noteGenerating");

  const cut = await generateCutout(sf.src, id, custom);
  if (state.selfie !== sf) return; // a new selfie replaced this one mid-flight
  sf.generating = null;

  if (cut) {
    sf.emotions[id] = cut;
    if (id === "custom") sf.customText = custom;
    setChip(id, "ready");
    sf.chosen = id;
    markSelected(id);
    $("#preview-angry").src = cut;
    setPreviewLoading(false);
    enableStart(true);
    $("#selfie-note").textContent = t("noteReady");
  } else {
    setChip(id, "error");
    setPreviewLoading(false);
    revertPreview();
    enableStart(Boolean(sf.chosen && sf.emotions[sf.chosen]));
    $("#selfie-note").textContent = t("noteEmotionFail");
  }
}

function openCustom() {
  const input = $("#custom-input");
  $("#custom-row").classList.remove("hidden");
  if (state.selfie?.customText) input.value = state.selfie.customText;
  input.focus();
}

function submitCustom() {
  if (state.busy) return;
  const sf = state.selfie;
  if (sf && sf.generating) return;
  // Mirror the server's sanitize enough to reject empty / quotes-only / control
  // input locally (saves a doomed request + rate-limit slot).
  const text = $("#custom-input").value.replace(/[\p{Cc}"“”`]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return;
  if (sf) {
    // post-capture: generate on the current selfie (or reuse the cached custom)
    if (sf.emotions.custom && text === sf.customText) {
      selectEmotion("custom");
      return;
    }
    // Keep the old custom cutout cached: a success overwrites it, a failure
    // reverts to it, so Start never points at a missing reveal.
    generateEmotion("custom", text);
  } else {
    pickPre("custom", text); // pre-capture: just the step-1 choice
  }
}

// A chip tap. Custom always opens its input. Before a selfie exists a tap just
// selects the target face and reveals capture (step 2); once a selfie exists it
// generates / selects on that selfie.
function pickEmotion(id) {
  if (state.busy) return;
  if (id === "custom") {
    openCustom();
    return;
  }
  if (state.selfie) selectEmotion(id);
  else pickPre(id, "");
}

// Record the step-1 choice and reveal the capture buttons.
function pickPre(id, custom) {
  state.pickedEmotion = id;
  state.pickedCustom = id === "custom" ? custom : "";
  markSelected(id);
  $("#custom-row").classList.add("hidden");
  $("#selfie-actions").classList.remove("hidden");
  $("#selfie-note").textContent = t("noteCapture");
}

// Entering Selfie Mode: render the picker, then either restore a finished selfie
// (returning to the screen) or reset to step 1 — pick a face, capture hidden.
function enterSelfie() {
  // invalidate any capture still in flight from a prior visit and never inherit
  // a stale lock, so the picker is always live on entry
  state.selfieToken++;
  state.busy = false;
  renderEmotionPicker();
  $("#selfie-error").classList.add("hidden");
  setProcessing(false);
  const sf = state.selfie;
  if (sf && sf.chosen && sf.emotions[sf.chosen]) {
    restoreSelfieUI();
  } else {
    state.selfie = null;
    state.pickedEmotion = null;
    state.pickedCustom = "";
    $("#selfie-actions").classList.add("hidden");
    $("#selfie-result").classList.add("hidden");
    $("#selfie-note").textContent = "";
  }
}

// Re-apply a finished selfie's cached chips, selection and preview onto the
// freshly-rendered grid, so returning to the screen keeps prior work.
function restoreSelfieUI() {
  const sf = state.selfie;
  for (const id of Object.keys(sf.emotions)) setChip(id, "ready");
  markSelected(sf.chosen);
  $("#preview-normal").src = sf.calm;
  $("#preview-angry").src = sf.emotions[sf.chosen];
  setPreviewCaption(sf.chosen, sf.customText);
  setPreviewLoading(false);
  enableStart(true);
  $("#selfie-actions").classList.remove("hidden");
  $("#selfie-result").classList.remove("hidden");
  $("#selfie-note").textContent = t("noteReady");
}

/* ====================== Selfie processing flow ====================== */

let loadingTimer = null;
function setProcessing(on) {
  const panel = $("#selfie-processing");
  panel.classList.toggle("hidden", !on);
  clearInterval(loadingTimer);
  if (on) {
    const lines = t("processing");
    let i = 0;
    const line = $("#processing-line");
    line.textContent = lines[0];
    loadingTimer = setInterval(() => {
      i = (i + 1) % lines.length;
      line.textContent = lines[i];
    }, 2200);
  }
}

function showSelfieError(msg) {
  const el = $("#selfie-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

// Capture flow: the face was chosen in step 1 (or carried over from a prior
// selfie). Generate the CALM cut-out (every board face) plus the chosen reveal,
// in parallel. Calm is required — if it fails we surface an error and never
// enter the game (NO heuristic fallback). The re-take lock (state.busy) covers
// only the calm critical path; once calm lands the reveal keeps generating in
// the background (a re-take from here is handled by the state.selfie identity
// guard). Switching to other emotions afterward generates them on demand.
async function handleSelfie(file) {
  if (!file || state.busy) return;
  // target = the step-1 pick, or (on a re-take) the currently-chosen emotion
  const target = (state.selfie && state.selfie.chosen) || state.pickedEmotion;
  if (!target) return; // capture is gated on a pick — shouldn't happen
  const targetCustom =
    target === "custom"
      ? (state.selfie && state.selfie.customText) || state.pickedCustom || ""
      : "";

  const token = state.selfieToken; // this capture is void if the user leaves/re-enters

  state.busy = true;
  $("#selfie-note").textContent = "";
  $("#selfie-result").classList.add("hidden");
  $("#selfie-error").classList.add("hidden");
  $("#selfie-actions").classList.add("hidden");
  setProcessing(true);

  let src;
  try {
    src = await optimizeFile(file);
  } catch (err) {
    if (token !== state.selfieToken) return; // navigated away — leave the new screen alone
    console.error(err);
    setProcessing(false);
    $("#selfie-actions").classList.remove("hidden");
    state.busy = false;
    showSelfieError(t("noteError"));
    return;
  }

  const calmP = generateCutout(src, "calm");
  const revealP = generateCutout(src, target, targetCustom);
  const calm = await calmP;
  // Bail BEFORE touching busy/UI/state if the user left and re-entered (or this
  // capture was abandoned) — otherwise an orphaned calm clobbers a fresh screen.
  if (token !== state.selfieToken) return;
  setProcessing(false);
  state.busy = false; // calm done — a re-take is allowed from here on
  $("#selfie-actions").classList.remove("hidden");

  if (!calm) {
    showSelfieError(t("noteError"));
    // keep the previous good selfie visible so chip taps aren't a dead end
    const prev = state.selfie;
    if (prev && prev.chosen && prev.emotions[prev.chosen]) restoreSelfieUI();
    return;
  }

  const sf = { src, calm, emotions: {}, chosen: null, customText: "", generating: target };
  state.selfie = sf;
  renderEmotionPicker(); // reset stale chip states (e.g. cached "ready" from a prior photo on a re-take)
  markSelected(target);
  setChip(target, "generating");
  $("#preview-normal").src = calm;
  $("#preview-angry").removeAttribute("src");
  setPreviewCaption(target, targetCustom);
  setPreviewLoading(true);
  enableStart(false);
  $("#selfie-result").classList.remove("hidden");
  $("#selfie-note").textContent = t("noteGenerating");

  const reveal = await revealP;
  if (token !== state.selfieToken || state.selfie !== sf) return; // left/re-entered or a newer capture replaced this
  sf.generating = null;
  if (reveal) {
    sf.emotions[target] = reveal;
    if (target === "custom") sf.customText = targetCustom;
    sf.chosen = target;
    setChip(target, "ready");
    markSelected(target);
    $("#preview-angry").src = reveal;
    setPreviewCaption(target, targetCustom);
    setPreviewLoading(false);
    enableStart(true);
    $("#selfie-note").textContent = t("noteReady");
  } else {
    setChip(target, "error");
    setPreviewLoading(false);
    $("#selfie-note").textContent = t("noteEmotionFail");
  }
}

/* ========================= Drinking game ========================= */

// When you clear an uncle, a dare can pop — a full-screen "make your friends
// drink" moment. Below are the built-in dares; players toggle which are in play
// and can add their own in the settings sheet. i18n holds built-in text; SVG
// icons keep us off emojis per house style. "Everyone but you" is the big one.
const BUILTIN_DRINKS = [
  { id: "one", i18n: "drinkOne", icon: "person" },
  { id: "left", i18n: "drinkLeft", icon: "left" },
  { id: "right", i18n: "drinkRight", icon: "right" },
  { id: "leftright", i18n: "drinkLeftRight", icon: "leftright" },
  { id: "allbutme", i18n: "drinkAllButMe", icon: "group" },
  { id: "youngest", i18n: "drinkYoungest", icon: "star" },
  { id: "you", i18n: "drinkYou", icon: "glass" },
];
const RULES_KEY = "ao_drink_rules";
const DEL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;

const DRINK_ICONS = {
  person: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  left: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H4m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  right: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  leftright: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M8 7l-5 5 5 5M16 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  group: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="9" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M15.5 7.2a3 3 0 0 1 0 5.6M17 14.4a5.5 5.5 0 0 1 3.5 4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  star: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2l2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.9 6.9 19.9 8 14.2 3.7 10.2l5.8-.7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  glass: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h8v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15 10h2.4A1.6 1.6 0 0 1 19 11.6v1.8A1.6 1.6 0 0 1 17.4 15H15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8c.4-2 6.6-2 7 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

/* ---- small helpers ---- */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Per-round dare-count distribution — independent of grid size (per spec):
// 40% none · 30% one · 20% two · 10% three.
function pickDrinkCount() {
  const r = Math.random();
  if (r < 0.4) return 0;
  if (r < 0.7) return 1;
  if (r < 0.9) return 2;
  return 3;
}

// ---- dare rules: built-ins + custom, each with on/off, persisted ----
// localStorage shape: { off: [builtinId…], custom: [{ id, text, on }] }
function buildDrinkRules() {
  let off = [];
  let custom = [];
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        if (Array.isArray(p.off)) off = p.off;
        if (Array.isArray(p.custom)) custom = p.custom;
      }
    }
  } catch {
    /* unavailable / corrupt — fall back to all-on defaults */
  }
  const offSet = new Set(off);
  const builtins = BUILTIN_DRINKS.map((d) => ({
    id: d.id, builtin: true, i18n: d.i18n, icon: d.icon, enabled: !offSet.has(d.id),
  }));
  const customs = custom
    .filter((c) => c && typeof c.text === "string" && c.text.trim())
    .map((c) => ({
      id: typeof c.id === "string" ? c.id : "c" + Math.random().toString(36).slice(2, 9),
      builtin: false,
      text: c.text.trim().slice(0, 60),
      icon: "star",
      enabled: c.on !== false,
    }));
  state.drinkRules = [...builtins, ...customs];
}

function saveDrinkRules() {
  const off = state.drinkRules.filter((r) => r.builtin && !r.enabled).map((r) => r.id);
  const custom = state.drinkRules
    .filter((r) => !r.builtin)
    .map((r) => ({ id: r.id, text: r.text, on: r.enabled }));
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify({ off, custom }));
  } catch {
    /* ignore */
  }
}

function enabledDrinkTypes() {
  return state.drinkRules.filter((r) => r.enabled);
}
function drinkLabel(rule) {
  return rule.builtin ? t(rule.i18n) : rule.text;
}
// the confirm button reads like the drink already happened (per spec)
function drinkConfirmKey(rule) {
  if (rule.id === "you") return "drinkConfirmSelf";
  if (rule.id === "allbutme") return "drinkConfirmAll";
  return "drinkConfirmOthers";
}
function isRareDrink(rule) {
  return rule.id === "allbutme";
}

// Decide up front which uncles hold a dare (the angry one never does — he ends
// the round before any card matters). Count from pickDrinkCount (NOT scaled by
// grid); each placed dare is an equal-chance pick among the enabled ones.
function assignDrinks() {
  const drinks = new Array(state.grid).fill(null);
  if (!state.drinkEnabled) return drinks;
  const pool = enabledDrinkTypes();
  if (!pool.length) return drinks;
  const candidates = [];
  for (let i = 0; i < state.grid; i++) if (i !== state.angryIndex) candidates.push(i);
  const count = Math.min(pickDrinkCount(), candidates.length);
  shuffle(candidates);
  for (let k = 0; k < count; k++) {
    drinks[candidates[k]] = pool[Math.floor(Math.random() * pool.length)];
  }
  return drinks;
}

/* ---- celebration: a happy "you win, they drink" flourish ---- */
const CONFETTI_COLORS = ["#ff5b4d", "#ffce47", "#4db6f0", "#6bd47a", "#ff8fb0", "#b98cff", "#f0a432"];

function cheerSound(rare) {
  // rising major arpeggio — a little "you win" fanfare, brighter for the big one
  const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
  notes.forEach((f, i) => tone({ type: "triangle", from: f, to: f, dur: 0.14, vol: 0.16, delay: i * 0.07 }));
  tone({ type: "sine", from: 1568, to: 2093, dur: 0.18, vol: 0.12, delay: 0.3 });
  if (rare) {
    tone({ type: "sine", from: 1047, to: 1760, dur: 0.22, vol: 0.16, delay: 0.42 });
    tone({ type: "square", from: 220, to: 330, dur: 0.2, vol: 0.08, delay: 0.42 });
  }
}

function burstConfetti() {
  const wrap = $("#drink-confetti");
  if (!wrap) return;
  wrap.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 20; i++) {
    const pc = document.createElement("span");
    pc.className = "confetti-pc";
    const angle = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 210;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist * 0.7 + 140; // bias downward so it rains
    pc.style.left = 50 + (Math.random() * 26 - 13) + "%";
    pc.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    pc.style.setProperty("--dx", dx.toFixed(0) + "px");
    pc.style.setProperty("--dy", dy.toFixed(0) + "px");
    pc.style.setProperty("--dr", (Math.random() * 720 - 360).toFixed(0) + "deg");
    pc.style.animationDelay = (Math.random() * 0.12).toFixed(2) + "s";
    frag.appendChild(pc);
  }
  wrap.appendChild(frag);
}

// A dare is a full-screen modal so the whole table sees it; it blocks the board
// until the confirm button is tapped. The button is disabled for a beat first,
// so a stray rapid tap can't dismiss it unread — and a backdrop tap never closes
// it (both per spec: people tap consecutively and would skip the dare).
const DRINK_ARM_MS = 800;
let drinkArmTimer = null;

function openDrinkModal(rule) {
  const overlay = $("#overlay-drink");
  const rare = isRareDrink(rule);
  $("#drink-modal-icon").innerHTML = DRINK_ICONS[rule.icon] || DRINK_ICONS.glass;
  $("#drink-modal-text").textContent = drinkLabel(rule);
  $("#drink-modal-kicker").textContent = t("drinkCheers");
  overlay.querySelector(".drink-modal").classList.toggle("rare", rare);
  overlay.classList.toggle("rare", rare);
  burstConfetti();
  overlay.classList.add("show");
  cheerSound(rare);
  buzz(rare ? [40, 30, 70] : 22);

  const btn = $("#btn-drink-close");
  btn.textContent = t(drinkConfirmKey(rule));
  btn.disabled = true;
  btn.style.setProperty("--arm", DRINK_ARM_MS / 1000 + "s");
  clearTimeout(drinkArmTimer);
  drinkArmTimer = setTimeout(() => { btn.disabled = false; }, DRINK_ARM_MS);
}

function closeDrinkModal() {
  clearTimeout(drinkArmTimer);
  $("#btn-drink-close").disabled = false;
  $("#overlay-drink").classList.remove("show");
}

/* ============================== Game ============================== */

const board = $("#board");
let cells = [];

function newRound() {
  state.round++;
  state.angryIndex = Math.floor(Math.random() * state.grid);
  state.openedCount = 0;
  state.over = false;
  state.drinks = assignDrinks();

  // the secretly-furious uncle's angry face, generated from his own seed so
  // the reveal looks like "that same uncle, now enraged"
  state.classicAngryReveal =
    state.mode === "classic"
      ? makeOjisan(state.classic.seeds[state.angryIndex], true)
      : null;

  const dim = Math.round(Math.sqrt(state.grid)); // 3 | 4 | 5 | 6
  board.style.gridTemplateColumns = `repeat(${dim}, 1fr)`;
  board.style.gridTemplateRows = `repeat(${dim}, 1fr)`;

  board.innerHTML = "";
  cells = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < state.grid; i++) {
    const cell = document.createElement("button");
    cell.className = "cell";
    cell.dataset.i = i;
    // random tilt + stacking so the crowd reads as crammed-in, not a tidy grid
    cell.style.setProperty("--rot", (Math.random() * 14 - 7).toFixed(1) + "deg");
    cell.style.setProperty("--z", String(2 + Math.floor(Math.random() * 6)));
    cell.setAttribute("aria-label", `Uncle ${i + 1}`);
    cell.innerHTML = `<span class="face"><img alt="" draggable="false" src="${characterFor(i)}"></span>`;
    frag.appendChild(cell);
    cells.push(cell);
  }
  board.appendChild(frag);
  updateHud();
  $("#overlay-lose").classList.remove("show", "panel-in");
  closeDrinkModal();
}

// Every uncle looks calm up front — you can't tell which is the bad one until tapped.
function characterFor(index) {
  if (state.mode === "selfie" && state.selfie) return state.selfie.calm;
  return state.classic.calm[index];
}

// The chosen-emotion reveal face — swapped into the tapped cell and shown full
// on the lose overlay (the same cut-out serves both).
function selfieReveal() {
  const sf = state.selfie;
  return sf ? sf.emotions[sf.chosen] : null;
}
function angryThumbImage() {
  if (state.mode === "selfie" && state.selfie) return selfieReveal();
  return state.classicAngryReveal;
}
function angryRevealImage() {
  if (state.mode === "selfie" && state.selfie) return selfieReveal();
  return state.classicAngryReveal;
}

function updateHud() {
  $("#hud-remaining").textContent = t("hud")(state.grid - state.openedCount);
}

// No global lock: every tap fires independently, so you can rip through the
// crowd as fast as you like. Each cell guards itself against re-taps; only the
// angry reveal (state.over) stops the board.
function openCell(cell, i) {
  if (state.over || cell.classList.contains("tapped")) return;
  // a dare modal already blocks the board via z-index, but two genuinely
  // simultaneous touches can both resolve to cells in one frame — guard so the
  // second can't open (and overwrite) a dare unseen, or trigger a loss under it
  if ($("#overlay-drink").classList.contains("show")) return;
  cell.classList.add("tapped");
  const round = state.round;

  if (i === state.angryIndex) {
    // tapped the wrong uncle — he wakes up
    state.over = true;
    cell.querySelector(".face img").src = angryThumbImage();
    cell.classList.add("angering");
    tickSound();
    buzz(30);
    setTimeout(() => {
      if (state.round === round) loseSequence(cell);
    }, 380);
    return;
  }

  // a calm uncle — pops out and flies off. ~10% (when enabled) carry a drinking
  // instruction, which opens a modal everyone can see and must dismiss.
  popSound();
  buzz(16);
  cell.classList.add("flying");
  state.openedCount++;
  updateHud();
  const drink = state.drinks?.[i];
  if (drink) openDrinkModal(drink);
  setTimeout(() => {
    if (state.round === round) cell.classList.add("gone");
  }, 640);
}

function loseSequence(cell) {
  state.over = true;
  angryRoar();
  buzz([60, 40, 120, 40, 200]);
  document.body.classList.add("quake");

  const overlay = $("#overlay-lose");
  $("#lose-face").src = angryRevealImage();
  $("#lose-quote").textContent = t("angryQuote");
  $("#lose-stats").textContent = t("loseStats")(state.openedCount);

  setTimeout(() => {
    overlay.classList.add("show");
    setTimeout(() => overlay.classList.add("panel-in"), 1100);
    setTimeout(() => document.body.classList.remove("quake"), 900);
  }, 250);
}

/* ============================== Wiring ============================== */

function startGame(mode) {
  state.mode = mode;
  if (mode === "classic" && !state.classic) state.classic = classicSet();
  newRound();
  show("game");
}

/* ============================== i18n ============================== */

const LANG_KEY = "ao_lang";

// Apply translations to every static element tagged with data-i18n /
// data-i18n-html, and refresh dynamic strings on the current screen.
function applyLang() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  // dynamic, screen-dependent text
  if ($("#screen-game").classList.contains("active")) updateHud();
  if ($("#overlay-drink-settings").classList.contains("show")) renderDrinkRules();
}

function initLang() {
  let saved = "en";
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v && STRINGS[v]) saved = v;
  } catch {
    /* localStorage unavailable — default English */
  }
  setLang(saved);
  document.querySelectorAll("#lang-switch button").forEach((b) => {
    b.classList.toggle("sel", b.dataset.lang === saved);
  });
  applyLang();
}

/* ===================== Settings (drinking game) ===================== */

const DRINK_KEY = "ao_drink";

function setDrinkEnabled(on, persist, celebrate) {
  state.drinkEnabled = on;
  const toggle = $("#drink-toggle");
  toggle.classList.toggle("on", on);
  toggle.setAttribute("aria-checked", String(on));
  $(".settings").classList.toggle("is-off", !on); // collapses the "customize" row when off
  if (persist) {
    try {
      localStorage.setItem(DRINK_KEY, on ? "on" : "off");
    } catch {
      /* ignore */
    }
  }
  if (celebrate && on) {
    // a little happy "now you get to make people drink" flourish
    toggle.classList.remove("celebrate");
    void toggle.offsetWidth; // reflow so the bounce restarts on every toggle-on
    toggle.classList.add("celebrate");
    cheerSound(false);
  }
}

function initDrinkToggle() {
  let on = true; // default on
  try {
    if (localStorage.getItem(DRINK_KEY) === "off") on = false;
  } catch {
    /* localStorage unavailable — default on */
  }
  setDrinkEnabled(on, false);
}

/* ---- the dare-settings bottom sheet ---- */
function updateDrinkNoneHint() {
  $("#drink-none-hint").classList.toggle("hidden", enabledDrinkTypes().length > 0);
}

function renderDrinkRules() {
  const wrap = $("#drink-rules");
  wrap.innerHTML = state.drinkRules
    .map((r) => {
      const label = r.builtin ? t(r.i18n) : escapeHtml(r.text);
      const icon = DRINK_ICONS[r.icon] || DRINK_ICONS.star;
      const del = r.builtin
        ? ""
        : `<button class="drink-rule-del" data-act="del" data-id="${r.id}" aria-label="remove dare">${DEL_ICON}</button>`;
      return (
        `<div class="drink-rule${r.enabled ? "" : " off"}" data-id="${r.id}">` +
        `<span class="drink-rule-icon" aria-hidden="true">${icon}</span>` +
        `<span class="drink-rule-text">${label}</span>` +
        del +
        `<button class="toggle toggle-sm${r.enabled ? " on" : ""}" data-act="toggle" data-id="${r.id}" role="switch" aria-checked="${r.enabled}" aria-label="toggle dare"><span class="toggle-knob"></span></button>` +
        `</div>`
      );
    })
    .join("");
  updateDrinkNoneHint();
}

function toggleDrinkRule(id) {
  const r = state.drinkRules.find((x) => x.id === id);
  if (!r) return;
  r.enabled = !r.enabled;
  saveDrinkRules();
  // update just this row (keeps the toggle's slide animation live)
  const row = document.querySelector(`.drink-rule[data-id="${id}"]`);
  if (row) {
    row.classList.toggle("off", !r.enabled);
    const tg = row.querySelector(".toggle");
    tg.classList.toggle("on", r.enabled);
    tg.setAttribute("aria-checked", String(r.enabled));
  }
  updateDrinkNoneHint();
}

function deleteDrinkRule(id) {
  state.drinkRules = state.drinkRules.filter((r) => r.id !== id);
  saveDrinkRules();
  renderDrinkRules();
}

function addCustomDare() {
  const input = $("#drink-add-input");
  const text = input.value.replace(/[\p{Cc}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!text) return;
  const id = "c" + Math.random().toString(36).slice(2, 9);
  state.drinkRules.push({ id, builtin: false, text, icon: "star", enabled: true });
  saveDrinkRules();
  renderDrinkRules();
  input.value = "";
  input.focus();
  const row = document.querySelector(`.drink-rule[data-id="${id}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

function openDrinkSettings() {
  renderDrinkRules();
  const input = $("#drink-add-input");
  input.value = "";
  input.placeholder = t("drinkAddPh");
  const ov = $("#overlay-drink-settings");
  ov.classList.add("show");
  ov.setAttribute("aria-hidden", "false");
}

function closeDrinkSettings() {
  const ov = $("#overlay-drink-settings");
  ov.classList.remove("show");
  ov.setAttribute("aria-hidden", "true");
}

document.addEventListener("DOMContentLoaded", () => {
  // language switcher
  initLang();
  // drinking-game toggle + dare settings sheet
  buildDrinkRules();
  initDrinkToggle();
  $("#drink-toggle").addEventListener("click", () => setDrinkEnabled(!state.drinkEnabled, true, true));
  $("#btn-drink-customize").addEventListener("click", openDrinkSettings);
  $("#btn-drink-settings-done").addEventListener("click", closeDrinkSettings);
  $("#overlay-drink-settings").addEventListener("pointerdown", (e) => {
    if (e.target.id === "overlay-drink-settings") closeDrinkSettings();
  });
  $("#drink-rules").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "toggle") toggleDrinkRule(btn.dataset.id);
    else if (btn.dataset.act === "del") deleteDrinkRule(btn.dataset.id);
  });
  $("#drink-add-btn").addEventListener("click", addCustomDare);
  $("#drink-add-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomDare();
    }
  });
  document.querySelectorAll("#lang-switch button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#lang-switch button").forEach((b) => b.classList.remove("sel"));
      btn.classList.add("sel");
      setLang(btn.dataset.lang);
      try {
        localStorage.setItem(LANG_KEY, btn.dataset.lang);
      } catch {
        /* ignore */
      }
      applyLang();
    });
  });

  // home
  $("#btn-classic").addEventListener("click", () => {
    audio();
    startGame("classic");
  });
  $("#btn-selfie").addEventListener("click", () => {
    audio();
    enterSelfie();
    show("selfie");
  });

  // grid size segmented control
  document.querySelectorAll("#grid-picker button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#grid-picker button").forEach((b) => b.classList.remove("sel"));
      btn.classList.add("sel");
      state.grid = Number(btn.dataset.n);
    });
  });

  // selfie screen — reset the input value so picking the SAME file again still
  // fires `change` (lets you retake the same shot).
  const onPick = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    handleSelfie(file);
  };
  $("#input-camera").addEventListener("change", onPick);
  $("#input-library").addEventListener("change", onPick);
  $("#btn-selfie-start").addEventListener("click", () => {
    // disabled gate + a safety check: never start without a real reveal cutout
    if ($("#btn-selfie-start").disabled || !selfieReveal()) return;
    startGame("selfie");
  });
  $("#btn-selfie-back").addEventListener("click", () => show("home"));

  // emotion picker — delegate chip taps to pickEmotion (pre-capture = choose +
  // reveal capture; post-capture = generate/select on the selfie).
  $("#emotion-grid").addEventListener("click", (e) => {
    const chip = e.target.closest(".emo-chip");
    if (!chip) return;
    pickEmotion(chip.dataset.emo);
  });
  $("#custom-go").addEventListener("click", submitCustom);
  $("#custom-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitCustom();
    }
  });

  // game
  board.addEventListener("pointerdown", (e) => {
    const cell = e.target.closest(".cell");
    if (cell) openCell(cell, Number(cell.dataset.i));
  });
  $("#btn-restart").addEventListener("click", () => newRound());
  $("#btn-home").addEventListener("click", () => show("home"));
  $("#btn-again").addEventListener("click", () => newRound());
  $("#btn-lose-home").addEventListener("click", () => {
    $("#overlay-lose").classList.remove("show", "panel-in");
    show("home");
  });

  // drink instruction modal — the confirm button is the ONLY dismiss. A backdrop
  // tap must never close it: players tap fast and could skip the dare unseen.
  $("#btn-drink-close").addEventListener("click", closeDrinkModal);

  // prevent iOS double-tap zoom / scroll bounce inside the app
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!e.target.closest(".scrollable")) e.preventDefault();
    },
    { passive: false },
  );
});
