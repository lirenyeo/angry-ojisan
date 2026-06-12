import { classicSet, CLASSIC_SAFE_QUIPS, CLASSIC_ANGRY_QUOTE } from "./characters.js";

/* ============================== State ============================== */

const GRID = 16;

const state = {
  mode: "classic", // 'classic' | 'selfie'
  players: 1,
  currentPlayer: 0,
  angryIndex: 0,
  openedCount: 0,
  over: false,
  busy: false, // a cell animation in flight
  round: 0, // bumped on every newRound so stale open-timeouts can bail
  classic: null, // {calm[], angry}
  selfie: null, // {normalThumb, angryThumb, angryFull, analysis}
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
  angryQuote: "WHO TOUCHED MY BOX?!",
  safeQuips: CLASSIC_SAFE_QUIPS,
};

async function requestAnalysis(dataUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 85_000);
  try {
    const res = await fetch("/api/angrify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.ok && json.analysis) return { analysis: json.analysis, live: true };
  } catch {
    /* fall through to heuristic */
  } finally {
    clearTimeout(timer);
  }
  return { analysis: FALLBACK_ANALYSIS, live: false };
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

async function handleSelfie(file) {
  if (!file || state.busy) return;
  state.busy = true;
  $("#selfie-result").classList.add("hidden");
  setProcessing(true);
  try {
    const dataUrl = await optimizeFile(file);
    const img = await loadImage(dataUrl);
    const { analysis: raw, live } = await requestAnalysis(dataUrl);
    // If the live API saw no face it zeroes the geometry — swap in the
    // heuristic geometry but keep Claude's quotes.
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
      analysis,
    };
    state.quotes = {
      angryQuote: analysis.angryQuote || FALLBACK_ANALYSIS.angryQuote,
      safeQuips: analysis.safeQuips?.length ? analysis.safeQuips : CLASSIC_SAFE_QUIPS,
    };
    $("#preview-normal").src = state.selfie.normalThumb;
    $("#preview-angry").src = state.selfie.angryThumb;
    $("#selfie-note").textContent = live
      ? raw.faceDetected
        ? "Claude found your face. It is not happy."
        : "Claude couldn't spot a face — applied generic rage instead."
      : "AI is offline — applied generic rage instead.";
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
  state.angryIndex = Math.floor(Math.random() * GRID);
  state.openedCount = 0;
  state.currentPlayer = 0;
  state.over = false;
  state.busy = false;

  board.innerHTML = "";
  cells = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < GRID; i++) {
    const cell = document.createElement("button");
    cell.className = "cell";
    cell.dataset.i = i;
    cell.setAttribute("aria-label", `Box ${i + 1}`);
    cell.innerHTML = `
      <span class="box">
        <svg class="qmark" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.1 9a3 3 0 1 1 4.6 2.5c-1 .7-1.7 1.3-1.7 2.5v.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
          <circle cx="12" cy="18.2" r="1.5" fill="currentColor"/>
        </svg>
        <span class="tape"></span>
      </span>
      <span class="popper"><img alt="" draggable="false"></span>
      <span class="quip"></span>`;
    frag.appendChild(cell);
    cells.push(cell);
  }
  board.appendChild(frag);
  updateHud();
  $("#overlay-lose").classList.remove("show", "panel-in");
}

function characterFor(index) {
  if (state.mode === "selfie" && state.selfie) {
    return index === state.angryIndex ? state.selfie.angryThumb : state.selfie.normalThumb;
  }
  if (index === state.angryIndex) return state.classic.angry;
  return state.classic.calm[index % state.classic.calm.length];
}

function angryRevealImage() {
  if (state.mode === "selfie" && state.selfie) return state.selfie.angryFull;
  return state.classic.angry;
}

function updateHud() {
  const remaining = GRID - state.openedCount;
  $("#hud-remaining").textContent = remaining;
  const turnEl = $("#hud-turn");
  if (state.players > 1) {
    turnEl.textContent = `Player ${state.currentPlayer + 1}`;
    turnEl.classList.remove("hidden");
  } else {
    turnEl.classList.add("hidden");
  }
}

function randomQuip() {
  const list = state.quotes.safeQuips;
  return list[Math.floor(Math.random() * list.length)];
}

function openCell(cell, i) {
  if (state.over || state.busy || cell.classList.contains("open")) return;
  state.busy = true;
  const round = state.round;
  const isAngry = i === state.angryIndex;
  cell.classList.add("rattle");
  tickSound();
  buzz(15);

  // brief suspense rattle before the reveal
  const suspense = isAngry ? 620 : 240 + Math.random() * 160;
  setTimeout(() => {
    if (state.round !== round) return; // round was reset mid-suspense
    cell.classList.remove("rattle");
    cell.classList.add("open");
    const img = cell.querySelector(".popper img");
    img.src = characterFor(i);
    state.openedCount++;

    if (isAngry) {
      loseSequence(cell);
      return;
    }

    popSound();
    buzz(20);
    const quip = cell.querySelector(".quip");
    quip.textContent = randomQuip();
    cell.classList.add("flying");
    state.currentPlayer = (state.currentPlayer + 1) % state.players;
    updateHud();
    setTimeout(() => {
      if (state.round !== round) return;
      cell.classList.add("done");
      state.busy = false;
      if (state.openedCount === GRID - 1) {
        // only the angry one remains — auto-dramatic ending
        $("#hud-remaining").textContent = "1";
      }
    }, 600);
  }, suspense);
}

function loseSequence(cell) {
  state.over = true;
  angryRoar();
  buzz([60, 40, 120, 40, 200]);
  document.body.classList.add("quake");

  const overlay = $("#overlay-lose");
  $("#lose-face").src = angryRevealImage();
  $("#lose-quote").textContent = state.quotes.angryQuote || CLASSIC_ANGRY_QUOTE;
  const safe = state.openedCount - 1;
  const boxWord = safe === 1 ? "box" : "boxes";
  $("#lose-stats").textContent =
    state.players > 1
      ? `Player ${state.currentPlayer + 1} woke the angry one after ${safe} safe ${boxWord}!`
      : `You survived ${safe} ${boxWord} before waking the angry one.`;

  setTimeout(() => {
    overlay.classList.add("show");
    setTimeout(() => overlay.classList.add("panel-in"), 1100);
    setTimeout(() => document.body.classList.remove("quake"), 900);
    state.busy = false;
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

  // player count segmented control
  document.querySelectorAll("#player-picker button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#player-picker button").forEach((b) => b.classList.remove("sel"));
      btn.classList.add("sel");
      state.players = Number(btn.dataset.n);
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
