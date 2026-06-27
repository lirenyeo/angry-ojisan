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
  drinks: null, // per-cell drink instruction (or null) for this round — the drinking game
  drinkEnabled: true, // home-screen toggle; off = no drinking instructions at all
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

// Stroke-SVG faces in the house style (24x24, currentColor, no emoji) — each
// chip's face tints amber when selected and is swapped for the anger-vein
// spinner while its cut-out generates. Order here = order in the grid.
const EMO_ORDER = ["angry", "sad", "shocked", "drunk", "laughing", "disgusted", "smug"];

const EMO_ICON = {
  angry:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M7.4 8.2 10.6 9.9"/><path d="M16.6 8.2 13.4 9.9"/><path d="M8.6 16.7Q12 14.3 15.4 16.7"/></g><g fill="currentColor"><circle cx="9.4" cy="11.6" r="1"/><circle cx="14.6" cy="11.6" r="1"/></g></svg>`,
  sad:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M7.6 9.6Q9 8.4 10.4 9.4"/><path d="M16.4 9.6Q15 8.4 13.6 9.4"/><path d="M8.8 16.6Q12 14.3 15.2 16.6"/></g><g fill="currentColor"><circle cx="9.4" cy="11.8" r="1"/><circle cx="14.6" cy="11.8" r="1"/><path d="M9.2 12.6c-1 1.4-1 2.6 0 2.6s1-1.2 0-2.6z"/></g></svg>`,
  shocked:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M7.6 8Q9.2 7 10.8 8"/><path d="M16.4 8Q14.8 7 13.2 8"/><circle cx="9.4" cy="11.4" r="1.3"/><circle cx="14.6" cy="11.4" r="1.3"/><circle cx="12" cy="16.2" r="1.7"/></g></svg>`,
  drunk:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M8 11.4Q9.2 12.2 10.4 11.4"/><path d="M13.6 11.4Q14.8 12.2 16 11.4"/><path d="M8.4 15.6Q9.7 16.7 11 15.6 12.3 14.6 13.6 15.6 14.8 16.5 15.6 15.8"/></g><g fill="currentColor" opacity="0.55"><circle cx="8" cy="13.8" r="1.1"/><circle cx="16" cy="13.8" r="1.1"/></g></svg>`,
  laughing:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M7.8 11.6Q9.2 10.1 10.6 11.6"/><path d="M13.4 11.6Q14.8 10.1 16.2 11.6"/><path d="M8 14.2Q12 19 16 14.2Z"/></g></svg>`,
  disgusted:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M7.6 8.6 10.6 9.8"/><path d="M16.4 8.6 13.4 9.8"/><path d="M8.2 11.8Q9.3 11 10.4 11.8"/><path d="M11 12.6Q12 11.9 13 12.6"/><path d="M8.6 16Q11 14.7 13 15.8 14 16.3 15.4 15.4"/></g><g fill="currentColor"><circle cx="14.6" cy="11.9" r="1"/></g></svg>`,
  smug:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M7.6 8.2Q9.2 7.3 10.8 8.2"/><path d="M16.2 9.2Q15 8.8 13.6 9.2"/><path d="M8.2 11.6 10.4 11.6"/><path d="M13.6 11.6 15.8 11.6"/><path d="M8.8 16.2Q12 16.8 15.2 14.8"/></g></svg>`,
  custom:
    `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19l1-3.7L15.2 6 18 8.8 8.8 18 5 19Z"/><path d="M13.9 7.3 16.7 10.1"/></g></svg>`,
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
  const sf = state.selfie;
  if (!sf || sf.generating) return;
  // Mirror the server's sanitize enough to reject empty / quotes-only / control
  // input locally (saves a doomed request + rate-limit slot).
  const text = $("#custom-input").value.replace(/[\p{Cc}"“”`]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return;
  if (sf.emotions.custom && text === sf.customText) {
    selectEmotion("custom"); // unchanged text -> reuse the cached custom face
    return;
  }
  // Don't drop the old custom face: keep sf.chosen pointing at a valid cutout
  // while the new one generates (a success overwrites it; a failure reverts to
  // it), so Start never points at a missing reveal.
  generateEmotion("custom", text);
}

/* ====================== Selfie processing flow ====================== */

let loadingTimer = null;
function setProcessing(on) {
  const panel = $("#selfie-processing");
  panel.classList.toggle("hidden", !on);
  $("#selfie-actions").classList.toggle("hidden", on);
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

// Upload flow: generate the CALM cut-out (every board face) plus the default
// ANGRY reveal, in parallel. Calm is required — if it fails we surface an error
// and never enter the game (NO heuristic fallback). The re-take lock (state.busy)
// covers only the calm critical path; once calm lands the picker is shown and
// the default Angry keeps generating in the background (a re-take from here is
// handled safely by the state.selfie identity guard). Each further emotion is
// generated on demand and cached.
async function handleSelfie(file) {
  if (!file || state.busy) return;
  state.busy = true;
  $("#selfie-result").classList.add("hidden");
  $("#selfie-error").classList.add("hidden");
  setProcessing(true);

  let src;
  try {
    src = await optimizeFile(file);
  } catch (err) {
    console.error(err);
    setProcessing(false);
    state.busy = false;
    showSelfieError(t("noteError"));
    return;
  }

  const calmP = generateCutout(src, "calm");
  const angryP = generateCutout(src, "angry");
  const calm = await calmP;
  setProcessing(false);
  state.busy = false; // calm done — a re-take is allowed from here on

  if (!calm) {
    showSelfieError(t("noteError"));
    return;
  }

  const sf = { src, calm, emotions: {}, chosen: null, customText: "", generating: "angry" };
  state.selfie = sf;
  renderEmotionPicker();
  $("#preview-normal").src = calm;
  $("#preview-angry").removeAttribute("src");
  setPreviewCaption("angry");
  enableStart(false);
  $("#selfie-result").classList.remove("hidden");

  // the default Angry reveal is already in flight
  setChip("angry", "generating");
  setPreviewLoading(true);
  $("#selfie-note").textContent = t("noteGenerating");

  const angry = await angryP;
  if (state.selfie !== sf) return; // a newer selfie replaced this one mid-flight
  sf.generating = null;
  if (angry) {
    sf.emotions.angry = angry;
    sf.chosen = "angry";
    setChip("angry", "ready");
    markSelected("angry");
    $("#preview-angry").src = angry;
    setPreviewLoading(false);
    enableStart(true);
    $("#selfie-note").textContent = t("noteReady");
  } else {
    setChip("angry", "error");
    setPreviewLoading(false);
    $("#selfie-note").textContent = t("notePick");
  }
}

/* ========================= Drinking game ========================= */

// Some uncles, when tapped, pop a drinking instruction instead of a flavour
// quip. "Everyone drinks" is intentionally very rare (low weight); the rest are
// common. i18n holds the text; the SVG keeps us off emojis per house style.
const DRINK_TYPES = [
  { id: "one", i18n: "drinkOne", weight: 30 },
  { id: "left", i18n: "drinkLeft", weight: 28 },
  { id: "right", i18n: "drinkRight", weight: 28 },
  { id: "all", i18n: "drinkAll", weight: 3 }, // very rare
];
const DRINK_WEIGHT_TOTAL = DRINK_TYPES.reduce((s, d) => s + d.weight, 0);
const DRINK_RATE = 0.1; // ~10% of calm uncles carry a drinking instruction

const DRINK_ICONS = {
  one: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  left: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H4m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  right: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  all: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h8v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15 10h2.4A1.6 1.6 0 0 1 19 11.6v1.8A1.6 1.6 0 0 1 17.4 15H15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8c.4-2 6.6-2 7 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

function pickDrinkType() {
  let r = Math.random() * DRINK_WEIGHT_TOTAL;
  for (const d of DRINK_TYPES) {
    if ((r -= d.weight) < 0) return d;
  }
  return DRINK_TYPES[0];
}

// Decide up front which uncles hold a drink instruction (the angry one never
// does — he ends the round before any card matters). Empty if the toggle is off.
function assignDrinks() {
  const drinks = new Array(state.grid).fill(null);
  if (!state.drinkEnabled) return drinks;
  for (let i = 0; i < state.grid; i++) {
    if (i === state.angryIndex) continue;
    if (Math.random() < DRINK_RATE) drinks[i] = pickDrinkType();
  }
  return drinks;
}

function clinkSound(rare) {
  // light "ding ding" when a drink card appears; brighter triple for "everyone"
  tone({ type: "sine", from: 900, to: 1320, dur: 0.1, vol: 0.18 });
  tone({ type: "sine", from: 1320, to: 1760, dur: 0.12, vol: 0.16, delay: 0.08 });
  if (rare) tone({ type: "sine", from: 1760, to: 2300, dur: 0.16, vol: 0.18, delay: 0.18 });
}

// A drink instruction is a full-screen modal so the whole table sees it; it
// stays up (blocking the board) until someone taps "Cheers!" to dismiss.
function openDrinkModal(type) {
  const overlay = $("#overlay-drink");
  const rare = type.id === "all";
  $("#drink-modal-icon").innerHTML = DRINK_ICONS[type.id];
  $("#drink-modal-text").textContent = t(type.i18n);
  overlay.querySelector(".drink-modal").classList.toggle("rare", rare);
  overlay.classList.add("show");
  clinkSound(rare);
}

function closeDrinkModal() {
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

function setDrinkEnabled(on, persist) {
  state.drinkEnabled = on;
  const toggle = $("#drink-toggle");
  toggle.classList.toggle("on", on);
  toggle.setAttribute("aria-checked", String(on));
  if (persist) {
    try {
      localStorage.setItem(DRINK_KEY, on ? "on" : "off");
    } catch {
      /* ignore */
    }
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

document.addEventListener("DOMContentLoaded", () => {
  // language switcher
  initLang();
  // drinking-game toggle
  initDrinkToggle();
  $("#drink-toggle").addEventListener("click", () => setDrinkEnabled(!state.drinkEnabled, true));
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

  // emotion picker — delegate chip taps; custom opens a text input.
  $("#emotion-grid").addEventListener("click", (e) => {
    const chip = e.target.closest(".emo-chip");
    if (!chip) return;
    const id = chip.dataset.emo;
    if (id === "custom") openCustom();
    else selectEmotion(id);
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

  // drink instruction modal — manual dismiss only (button, or tap the backdrop)
  $("#btn-drink-close").addEventListener("click", closeDrinkModal);
  $("#overlay-drink").addEventListener("pointerdown", (e) => {
    if (e.target.id === "overlay-drink") closeDrinkModal();
  });

  // prevent iOS double-tap zoom / scroll bounce inside the app
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!e.target.closest(".scrollable")) e.preventDefault();
    },
    { passive: false },
  );
});
