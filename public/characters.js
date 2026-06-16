/* Parametric cartoon "ojisan" (uncle) face generator.
   Produces inline SVG data URLs so Classic mode needs zero image assets. */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKINS = ["#f2c9a0", "#e8b88a", "#d9a06b", "#c08552", "#9c6a3f", "#f5d7b8"];
const HAIRS = ["#3a3128", "#544539", "#6e6258", "#857d74", "#2b2b33", "#9b948a"];
const SHIRTS = ["#5b7a8c", "#7a6a55", "#8c5b5b", "#56735f", "#6b5b8c", "#46606e", "#a0744e"];

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

function hairSvg(rnd, hair, skin) {
  const style = Math.floor(rnd() * 5);
  switch (style) {
    case 0: // bald with shine
      return `<ellipse cx="50" cy="30" rx="26" ry="6" fill="${hair}" opacity="0"/>
        <path d="M28 44 Q26 30 38 24 Q50 18 62 24 Q74 30 72 44" fill="${skin}"/>
        <ellipse cx="42" cy="26" rx="7" ry="3" fill="#ffffff" opacity="0.45" transform="rotate(-18 42 26)"/>`;
    case 1: // side ring hair (bald top)
      return `<path d="M26 46 Q25 38 30 34 L30 50 Q26 50 26 46 Z" fill="${hair}"/>
        <path d="M74 46 Q75 38 70 34 L70 50 Q74 50 74 46 Z" fill="${hair}"/>
        <ellipse cx="44" cy="25" rx="6" ry="2.5" fill="#ffffff" opacity="0.4" transform="rotate(-15 44 25)"/>`;
    case 2: // comb-over
      return `<path d="M27 40 Q28 22 50 21 Q72 22 73 40 Q73 30 64 28 Q44 24 33 32 Q28 35 27 40 Z" fill="${hair}"/>`;
    case 3: // flat-top buzz
      return `<path d="M28 38 Q28 24 50 23 Q72 24 72 38 L72 32 Q72 26 50 26 Q28 26 28 32 Z" fill="${hair}"/>
        <path d="M28 38 Q28 25 50 24 Q72 25 72 38 Q72 28 50 28 Q28 28 28 38 Z" fill="${hair}"/>`;
    default: // messy tufts
      return `<path d="M27 42 Q24 30 34 27 Q38 20 50 22 Q62 19 66 27 Q76 30 73 42 Q70 32 62 30 Q50 26 38 30 Q30 32 27 42 Z" fill="${hair}"/>`;
  }
}

function browSvg(rnd, hair, angry) {
  if (angry) {
    return `<path d="M30 41 L45 48" stroke="#2b1d14" stroke-width="5" stroke-linecap="round"/>
      <path d="M70 41 L55 48" stroke="#2b1d14" stroke-width="5" stroke-linecap="round"/>`;
  }
  const lift = rnd() * 3;
  return `<path d="M32 ${44 - lift} Q38 ${41 - lift} 45 ${44 - lift}" stroke="${hair}" stroke-width="4" stroke-linecap="round" fill="none"/>
    <path d="M55 ${44 - lift} Q62 ${41 - lift} 68 ${44 - lift}" stroke="${hair}" stroke-width="4" stroke-linecap="round" fill="none"/>`;
}

function eyesSvg(rnd, angry) {
  if (angry) {
    return `<circle cx="39" cy="52" r="4.5" fill="#ffffff"/><circle cx="61" cy="52" r="4.5" fill="#ffffff"/>
      <circle cx="39" cy="52" r="2" fill="#7a1010"/><circle cx="61" cy="52" r="2" fill="#7a1010"/>`;
  }
  const sleepy = rnd() < 0.3;
  if (sleepy) {
    return `<path d="M35 52 Q39 55 43 52" stroke="#2b1d14" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M57 52 Q61 55 65 52" stroke="#2b1d14" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
  }
  return `<circle cx="39" cy="52" r="2.6" fill="#2b1d14"/><circle cx="61" cy="52" r="2.6" fill="#2b1d14"/>`;
}

function glassesSvg(rnd) {
  if (rnd() < 0.55) return "";
  const round = rnd() < 0.5;
  const frame = `stroke="#33302c" stroke-width="2.2" fill="rgba(255,255,255,0.14)"`;
  if (round) {
    return `<circle cx="39" cy="52" r="8.5" ${frame}/><circle cx="61" cy="52" r="8.5" ${frame}/>
      <path d="M47.5 52 L52.5 52" stroke="#33302c" stroke-width="2.2"/>`;
  }
  return `<rect x="30.5" y="45" width="17" height="13" rx="3" ${frame}/><rect x="52.5" y="45" width="17" height="13" rx="3" ${frame}/>
    <path d="M47.5 51 L52.5 51" stroke="#33302c" stroke-width="2.2"/>`;
}

function stacheSvg(rnd, hair, angry) {
  const style = Math.floor(rnd() * 4);
  const y = angry ? 66 : 65;
  switch (style) {
    case 0:
      return `<path d="M38 ${y} Q50 ${y - 5} 62 ${y} Q50 ${y + 2} 38 ${y} Z" fill="${hair}"/>`;
    case 1:
      return `<path d="M40 ${y} Q50 ${y - 3} 60 ${y}" stroke="${hair}" stroke-width="3.4" fill="none" stroke-linecap="round"/>`;
    case 2: // goatee
      return `<path d="M44 ${y + 8} Q50 ${y + 13} 56 ${y + 8} Q50 ${y + 10} 44 ${y + 8} Z" fill="${hair}"/>`;
    default:
      return "";
  }
}

function mouthSvg(rnd, angry) {
  if (angry) {
    // gritted teeth
    return `<path d="M40 71 Q50 67 60 71 Q50 79 40 71 Z" fill="#5e1212"/>
      <path d="M41.5 70.5 Q50 67.5 58.5 70.5 L58 72.5 Q50 70 42 72.5 Z" fill="#ffffff"/>
      <path d="M44 69.5 L44.6 72.6 M48 68.8 L48.2 72 M52 68.8 L51.8 72 M56 69.5 L55.4 72.6" stroke="#caa" stroke-width="0.8"/>`;
  }
  const mood = Math.floor(rnd() * 3);
  if (mood === 0) return `<path d="M42 70 Q50 76 58 70" stroke="#7a4533" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
  if (mood === 1) return `<path d="M43 71 L57 71" stroke="#7a4533" stroke-width="2.8" stroke-linecap="round"/>`;
  return `<ellipse cx="50" cy="72" rx="6" ry="4.5" fill="#6e3026"/><ellipse cx="50" cy="74" rx="3.6" ry="2" fill="#d98a7e"/>`;
}

function angryExtras() {
  return `
    <!-- flush -->
    <ellipse cx="34" cy="60" rx="7" ry="4.5" fill="#e23a2e" opacity="0.5"/>
    <ellipse cx="66" cy="60" rx="7" ry="4.5" fill="#e23a2e" opacity="0.5"/>
    <!-- anime anger vein -->
    <g stroke="#c81e1e" stroke-width="3" stroke-linecap="round" fill="none">
      <path d="M68 30 Q71 33 68 36"/><path d="M76 30 Q73 33 76 36"/>
      <path d="M69 29 Q72 26 75 29"/><path d="M69 37 Q72 40 75 37"/>
    </g>
    <!-- steam -->
    <g fill="#ffffff" opacity="0.85">
      <circle cx="20" cy="26" r="4"/><circle cx="25" cy="22" r="5"/><circle cx="29" cy="27" r="3.5"/>
      <circle cx="80" cy="24" r="4"/><circle cx="75" cy="20" r="5"/><circle cx="71" cy="25" r="3.5"/>
    </g>`;
}

export function makeOjisan(seed, angry = false) {
  const rnd = mulberry32(seed * 7919 + (angry ? 1 : 0));
  const skin = angry ? "#e8755c" : pick(rnd, SKINS);
  const hair = pick(rnd, HAIRS);
  const shirt = pick(rnd, SHIRTS);
  const faceW = 23 + rnd() * 4;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <!-- shoulders -->
    <path d="M18 100 Q20 84 36 81 L64 81 Q80 84 82 100 Z" fill="${shirt}"/>
    <path d="M44 81 L50 90 L56 81 Z" fill="#f5efe2"/>
    <!-- neck -->
    <rect x="43" y="72" width="14" height="12" rx="5" fill="${skin}"/>
    <!-- ears -->
    <circle cx="${50 - faceW - 1.5}" cy="54" r="5" fill="${skin}"/>
    <circle cx="${50 + faceW + 1.5}" cy="54" r="5" fill="${skin}"/>
    <!-- head -->
    <path d="M${50 - faceW} 50 Q${50 - faceW} 24 50 24 Q${50 + faceW} 24 ${50 + faceW} 50 Q${50 + faceW} 66 ${50 + faceW - 7} 73 Q${50 + 8} 79 50 79 Q${50 - 8} 79 ${50 - faceW + 7} 73 Q${50 - faceW} 66 ${50 - faceW} 50 Z" fill="${skin}"/>
    <!-- nose -->
    <path d="M50 53 Q53.5 60 50 62.5 Q47.5 61.5 48.5 58.5" fill="rgba(0,0,0,0.13)"/>
    ${hairSvg(rnd, hair, skin)}
    ${angry ? angryExtras() : ""}
    ${browSvg(rnd, hair, angry)}
    ${eyesSvg(rnd, angry)}
    ${glassesSvg(rnd)}
    ${stacheSvg(rnd, hair, angry)}
    ${mouthSvg(rnd, angry)}
  </svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg.replace(/\s+/g, " "));
}

/** Up to 36 calm uncles for Classic mode (enough for the largest grid), all
 *  looking innocent. The angry reveal for whichever one is secretly furious is
 *  generated per-round from its seed, so the crowd is indistinguishable until
 *  you tap the wrong uncle. */
export function classicSet() {
  const calm = [];
  const seeds = [];
  for (let i = 0; i < 36; i++) {
    const seed = i + 1;
    seeds.push(seed);
    calm.push(makeOjisan(seed, false));
  }
  return { calm, seeds };
}
