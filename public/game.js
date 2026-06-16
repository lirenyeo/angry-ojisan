import { classicSet, makeOjisan, CLASSIC_SAFE_QUIPS, CLASSIC_ANGRY_QUOTE } from "./characters.js";

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
  selfie: null, // {normalThumb, angryThumb, angryFull}
  quotes: { angryQuote: CLASSIC_ANGRY_QUOTE, safeQuips: CLASSIC_SAFE_QUIPS },
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

/** Downscale + recompress a user photo to <=1024px JPEG before upload. */
async function optimizeFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const MAX = 1024;
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

const FALLBACK_ANALYSIS = {
  faceDetected: false,
  face: { x: 0.22, y: 0.14, w: 0.56, h: 0.62 },
  tiltDegrees: 0,
  leftBrow: { inner: { x: 0.44, y: 0.36 }, outer: { x: 0.32, y: 0.35 } },
  rightBrow: { inner: { x: 0.56, y: 0.36 }, outer: { x: 0.68, y: 0.35 } },
  leftEye: { x: 0.38, y: 0.41, w: 0.09 },
  rightEye: { x: 0.62, y: 0.41, w: 0.09 },
  mouth: { x: 0.4, y: 0.6, w: 0.2, h: 0.08 },
  foreheadCenter: { x: 0.5, y: 0.25 },
  cheekLeft: { x: 0.34, y: 0.52 },
  cheekRight: { x: 0.66, y: 0.52 },
  angryQuote: "WHO TOUCHED MY STUFF?!",
  safeQuips: CLASSIC_SAFE_QUIPS,
};

// Returns the server payload verbatim: { ok, kind: "cutout"|"landmarks", ... }
// or { ok:false, reason }. Never throws — network failure resolves to ok:false.
async function requestAngrify(dataUrl) {
  const controller = new AbortController();
  // Must exceed the server's worst case (~75s: parallel Gemini ≤45s + Claude
  // landmark fallback ≤30s) so we don't abandon a request that's about to succeed.
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch("/api/angrify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
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
// the green out to transparent so it becomes a clean cut-out sticker.
//
// We flood-fill inward from the borders through connected green only — so
// green clothing/eyes in the SUBJECT keep their pixels (no holes), and if
// Gemini didn't actually produce a green background nothing is removed and the
// face simply stays on whatever backdrop it has (never a green rectangle).
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
    const stack = [];
    const visit = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0 || !isGreen(i)) return;
      d[i + 3] = 0;
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
    return c.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}

/* --------------------- Canvas rage compositor --------------------- */

function drawAngerVein(ctx, cx, cy, r, lineW) {
  ctx.save();
  ctx.strokeStyle = "rgba(200,26,26,0.9)";
  ctx.lineWidth = lineW;
  ctx.lineCap = "round";
  const arc = (x1, y1, qx, qy, x2, y2) => {
    ctx.beginPath();
    ctx.moveTo(cx + x1 * r, cy + y1 * r);
    ctx.quadraticCurveTo(cx + qx * r, cy + qy * r, cx + x2 * r, cy + y2 * r);
    ctx.stroke();
  };
  // 4 bulges of the classic anime cross-vein
  arc(-1.0, -0.35, -0.45, -1.0, 0.0, -0.35);
  arc(0.0, -0.35, 0.45, -1.0, 1.0, -0.35);
  arc(-1.0, 0.35, -0.45, 1.0, 0.0, 0.35);
  arc(0.0, 0.35, 0.45, 1.0, 1.0, 0.35);
  ctx.restore();
}

function angryBrow(ctx, brow, eyeW, lineW, side) {
  // Exaggerate: pull the inner end DOWN and toward the nose for the furious V.
  const inner = { ...brow.inner };
  const outer = { ...brow.outer };
  inner.y += eyeW * 0.55;
  outer.y -= eyeW * 0.18;
  ctx.beginPath();
  ctx.moveTo(outer.x, outer.y);
  const midX = (outer.x + inner.x) / 2;
  const midY = (outer.y + inner.y) / 2 - eyeW * 0.1;
  ctx.quadraticCurveTo(midX, midY, inner.x, inner.y);
  ctx.lineWidth = lineW;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(28,16,10,0.92)";
  ctx.stroke();
  // shadow under brow for depth
  ctx.beginPath();
  ctx.moveTo(outer.x + (side === "L" ? lineW * 0.3 : -lineW * 0.3), outer.y + lineW * 0.55);
  ctx.quadraticCurveTo(midX, midY + lineW * 0.6, inner.x, inner.y + lineW * 0.6);
  ctx.lineWidth = lineW * 0.45;
  ctx.strokeStyle = "rgba(90,30,20,0.35)";
  ctx.stroke();
}

/** Composite the rage onto the photo using Claude's landmarks. Returns dataURL. */
function angrifyImage(img, analysis) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const a = analysis;
  const px = (p) => ({ x: p.x * W, y: p.y * H });
  const face = { x: a.face.x * W, y: a.face.y * H, w: a.face.w * W, h: a.face.h * H };
  const faceCx = face.x + face.w / 2;
  const faceCy = face.y + face.h / 2;
  const eyeW = Math.max(((a.leftEye.w + a.rightEye.w) / 2) * W, face.w * 0.16);

  // 1. warm rage tint over the face region
  ctx.save();
  const flushGrad = ctx.createRadialGradient(faceCx, faceCy, face.w * 0.1, faceCx, faceCy, face.w * 0.85);
  flushGrad.addColorStop(0, "rgba(255,46,18,0.30)");
  flushGrad.addColorStop(0.7, "rgba(255,46,18,0.16)");
  flushGrad.addColorStop(1, "rgba(255,46,18,0)");
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = flushGrad;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // 2. hot cheeks
  for (const cheek of [px(a.cheekLeft), px(a.cheekRight)]) {
    const g = ctx.createRadialGradient(cheek.x, cheek.y, 1, cheek.x, cheek.y, eyeW * 1.1);
    g.addColorStop(0, "rgba(225,40,30,0.34)");
    g.addColorStop(1, "rgba(225,40,30,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cheek.x - eyeW * 1.2, cheek.y - eyeW * 1.2, eyeW * 2.4, eyeW * 2.4);
  }

  // 3. furious brows (landmarks are already in image space, tilt included)
  const browW = Math.max(face.w * 0.045, 3);
  angryBrow(
    ctx,
    { inner: px(a.leftBrow.inner), outer: px(a.leftBrow.outer) },
    eyeW,
    browW,
    "L",
  );
  angryBrow(
    ctx,
    { inner: px(a.rightBrow.inner), outer: px(a.rightBrow.outer) },
    eyeW,
    browW,
    "R",
  );

  // 4. furrow wrinkles between the brows
  const glabX = (a.leftBrow.inner.x + a.rightBrow.inner.x) / 2 * W;
  const glabY = (a.leftBrow.inner.y + a.rightBrow.inner.y) / 2 * H;
  ctx.strokeStyle = "rgba(70,30,20,0.5)";
  ctx.lineWidth = browW * 0.35;
  ctx.lineCap = "round";
  for (const dx of [-0.35, 0.35]) {
    ctx.beginPath();
    ctx.moveTo(glabX + dx * eyeW * 0.8, glabY - eyeW * 0.15);
    ctx.lineTo(glabX + dx * eyeW * 0.45, glabY + eyeW * 0.55);
    ctx.stroke();
  }

  // 5. anime anger vein near the temple/forehead — pick the side with room,
  // then clamp inside the canvas for faces near the edge
  const fh = px(a.foreheadCenter);
  const veinR = eyeW * 0.55;
  let veinX = fh.x + face.w * 0.28;
  if (veinX + veinR * 1.2 > W) veinX = fh.x - face.w * 0.28;
  veinX = Math.min(Math.max(veinX, veinR * 1.2), W - veinR * 1.2);
  const veinY = Math.min(Math.max(fh.y - face.h * 0.02, veinR * 1.2), H - veinR * 1.2);
  drawAngerVein(ctx, veinX, veinY, veinR, Math.max(face.w * 0.022, 2));

  // 6. red vignette closing in
  const vig = ctx.createRadialGradient(faceCx, faceCy, Math.max(face.w, face.h) * 0.7, W / 2, H / 2, Math.max(W, H) * 0.85);
  vig.addColorStop(0, "rgba(120,0,0,0)");
  vig.addColorStop(1, "rgba(90,0,0,0.55)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, W, H);

  return canvas.toDataURL("image/jpeg", 0.9);
}

/** Square crop centered on the face (with padding) for grid thumbnails. */
function cropFace(img, face, padFactor = 0.55, size = 360) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const fw = face.w * W;
  const fh = face.h * H;
  const cx = (face.x + face.w / 2) * W;
  const cy = (face.y + face.h / 2) * H - fh * 0.04;
  let side = Math.max(fw, fh) * (1 + padFactor);
  side = Math.min(side, W, H);
  const sx = Math.min(Math.max(cx - side / 2, 0), W - side);
  const sy = Math.min(Math.max(cy - side / 2, 0), H - side);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.88);
}

/* ====================== Selfie processing flow ====================== */

const LOADING_LINES = [
  "Locating your inner ojisan...",
  "Cutting you out of the photo...",
  "Measuring eyebrow fury...",
  "Heating up your cheeks...",
  "Inflating the anger vein...",
  "Brewing the rage...",
  "Almost mad enough...",
];

let loadingTimer = null;
function setProcessing(on) {
  const panel = $("#selfie-processing");
  panel.classList.toggle("hidden", !on);
  $("#selfie-actions").classList.toggle("hidden", on);
  clearInterval(loadingTimer);
  if (on) {
    let i = 0;
    const line = $("#processing-line");
    line.textContent = LOADING_LINES[0];
    loadingTimer = setInterval(() => {
      i = (i + 1) % LOADING_LINES.length;
      line.textContent = LOADING_LINES[i];
    }, 2200);
  }
}

// Build state.selfie from a Claude landmark analysis using the canvas
// compositor (the fallback path when Gemini isn't available).
async function buildFromLandmarks(img, raw) {
  const analysis = raw.faceDetected
    ? raw
    : {
        ...FALLBACK_ANALYSIS,
        angryQuote: raw.angryQuote || FALLBACK_ANALYSIS.angryQuote,
        safeQuips: raw.safeQuips?.length ? raw.safeQuips : FALLBACK_ANALYSIS.safeQuips,
        faceDetected: false,
      };
  const angryFull = angrifyImage(img, analysis);
  const angryImg = await loadImage(angryFull);
  state.selfie = {
    normalThumb: cropFace(img, analysis.face),
    angryThumb: cropFace(angryImg, analysis.face),
    angryFull,
  };
  state.quotes = {
    angryQuote: analysis.angryQuote || FALLBACK_ANALYSIS.angryQuote,
    safeQuips: analysis.safeQuips?.length ? analysis.safeQuips : CLASSIC_SAFE_QUIPS,
  };
}

async function handleSelfie(file) {
  if (!file || state.busy) return;
  state.busy = true;
  $("#selfie-result").classList.add("hidden");
  setProcessing(true);
  try {
    const dataUrl = await optimizeFile(file);
    const img = await loadImage(dataUrl);
    const res = await requestAngrify(dataUrl);
    let note;

    if (res?.ok && res.kind === "cutout" && res.calm && res.angry) {
      // Gemini gave us the face on a green screen — key it out to a sticker.
      const [calm, angry] = await Promise.all([
        chromaKeyCutout(res.calm),
        chromaKeyCutout(res.angry),
      ]);
      state.selfie = { normalThumb: calm, angryThumb: angry, angryFull: angry };
      state.quotes = {
        angryQuote: res.angryQuote || FALLBACK_ANALYSIS.angryQuote,
        safeQuips: res.safeQuips?.length ? res.safeQuips : CLASSIC_SAFE_QUIPS,
      };
      note = "Gemini cut you out and made you furious.";
    } else if (res?.ok && res.kind === "landmarks" && res.analysis) {
      // Claude found landmarks; composite the rage on canvas.
      await buildFromLandmarks(img, res.analysis);
      note = res.analysis.faceDetected
        ? "Claude found your face. It is not happy."
        : "Claude couldn't spot a face — applied generic rage instead.";
    } else {
      // No image service reachable — heuristic rage so the game still plays.
      await buildFromLandmarks(img, { ...FALLBACK_ANALYSIS });
      note = "AI is offline — applied generic rage instead.";
    }

    $("#preview-normal").src = state.selfie.normalThumb;
    $("#preview-angry").src = state.selfie.angryThumb;
    $("#selfie-note").textContent = note;
    $("#selfie-result").classList.remove("hidden");
  } catch (err) {
    console.error(err);
    $("#selfie-note").textContent = "Something went wrong with that photo — try another one.";
  } finally {
    setProcessing(false);
    state.busy = false;
  }
}

/* ============================== Game ============================== */

const board = $("#board");
let cells = [];

function newRound() {
  state.round++;
  state.angryIndex = Math.floor(Math.random() * state.grid);
  state.openedCount = 0;
  state.over = false;

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
    cell.innerHTML = `
      <span class="face"><img alt="" draggable="false" src="${characterFor(i)}"></span>
      <span class="quip"></span>`;
    frag.appendChild(cell);
    cells.push(cell);
  }
  board.appendChild(frag);
  updateHud();
  $("#overlay-lose").classList.remove("show", "panel-in");
}

// Every uncle looks calm up front — you can't tell which is angry until tapped.
function characterFor(index) {
  if (state.mode === "selfie" && state.selfie) return state.selfie.normalThumb;
  return state.classic.calm[index];
}

// Small angry face swapped into the tapped cell.
function angryThumbImage() {
  if (state.mode === "selfie" && state.selfie) return state.selfie.angryThumb;
  return state.classicAngryReveal;
}

// Full-size angry face for the lose overlay.
function angryRevealImage() {
  if (state.mode === "selfie" && state.selfie) return state.selfie.angryFull;
  return state.classicAngryReveal;
}

function updateHud() {
  $("#hud-remaining").textContent = state.grid - state.openedCount;
}

function randomQuip() {
  const list = state.quotes.safeQuips;
  return list[Math.floor(Math.random() * list.length)];
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

  // a calm uncle — pops out with a quip and flies off
  popSound();
  buzz(16);
  cell.querySelector(".quip").textContent = randomQuip();
  cell.classList.add("flying");
  state.openedCount++;
  updateHud();
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
  $("#lose-quote").textContent = state.quotes.angryQuote || CLASSIC_ANGRY_QUOTE;
  const safe = state.openedCount;
  const word = safe === 1 ? "uncle" : "uncles";
  $("#lose-stats").textContent = `You cleared ${safe} ${word} before waking the angry one.`;

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
  if (mode === "classic") {
    state.quotes = { angryQuote: CLASSIC_ANGRY_QUOTE, safeQuips: CLASSIC_SAFE_QUIPS };
  }
  newRound();
  show("game");
}

document.addEventListener("DOMContentLoaded", () => {
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

  // selfie screen
  $("#input-camera").addEventListener("change", (e) => handleSelfie(e.target.files[0]));
  $("#input-library").addEventListener("change", (e) => handleSelfie(e.target.files[0]));
  $("#btn-selfie-start").addEventListener("click", () => startGame("selfie"));
  $("#btn-selfie-back").addEventListener("click", () => show("home"));

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

  // prevent iOS double-tap zoom / scroll bounce inside the app
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!e.target.closest(".scrollable")) e.preventDefault();
    },
    { passive: false },
  );
});
