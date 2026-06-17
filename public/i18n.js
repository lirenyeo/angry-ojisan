/* Localized UI strings. English is the default; Simplified Chinese and Thai
   are fully translated. The flavour quips and the angry shout live here too,
   so both Classic and Selfie modes speak the chosen language. */

export const LANG_ORDER = ["en", "zh", "th"];

export const STRINGS = {
  en: {
    _name: "EN",
    tagline: "A crowd of uncles, crammed in tight.<br>One of them is <em>furious</em>.",
    btnClassic: "Classic Uncles",
    btnSelfie: "Angry Selfie Mode",
    gridSize: "Grid size",
    footnote: "Tap the uncles one by one — wake the angry one and you lose.",
    selfieTitle: "Angry Selfie Mode",
    selfieSub: "Take a selfie — AI cuts you out and turns you into the angry ojisan hiding in the crowd.",
    btnCamera: "Take a selfie",
    btnLibrary: "Choose from library",
    btnSelfieStart: "Hide me in the crowd",
    btnBack: "Back",
    privacy: "Your selfie is processed in-memory to generate your angry face, and never stored on our server.",
    previewYou: "You",
    previewAngry: "Angry You",
    processing: [
      "Locating your inner ojisan...",
      "Cutting you out of the photo...",
      "Measuring eyebrow fury...",
      "Heating up your cheeks...",
      "Inflating the anger vein...",
      "Brewing the rage...",
      "Almost mad enough...",
    ],
    noteCutout: "Your angry self is ready.",
    noteOffline: "AI is offline — applied a generic rage instead.",
    noteError: "Something went wrong with that photo — try another one.",
    loseBusted: "BUSTED!",
    playAgain: "Play again",
    menu: "Menu",
    angryQuote: "WHO WOKE ME UP?!",
    drinkGame: "Drinking game",
    drinkClose: "Cheers!",
    drinkOne: "Pick 1 friend to drink",
    drinkLeft: "Friend on your LEFT drinks",
    drinkRight: "Friend on your RIGHT drinks",
    drinkAll: "EVERYONE drinks!",
    hud: (n) => `${n} ${n === 1 ? "uncle" : "uncles"} left`,
    loseStats: (n) => `You cleared ${n} ${n === 1 ? "uncle" : "uncles"} before waking the angry one.`,
  },

  zh: {
    _name: "中文",
    tagline: "一群大叔挤在一起,<br>其中一个<em>怒火中烧</em>。",
    btnClassic: "经典大叔",
    btnSelfie: "愤怒自拍模式",
    gridSize: "网格大小",
    footnote: "逐个点开大叔——点到发怒的那个就输了。",
    selfieTitle: "愤怒自拍模式",
    selfieSub: "拍张自拍——AI 会把你抠出来,变成藏在人群里的愤怒大叔。",
    btnCamera: "拍张自拍",
    btnLibrary: "从相册选择",
    btnSelfieStart: "把我藏进人群",
    btnBack: "返回",
    privacy: "你的自拍仅在内存中处理以生成愤怒脸,绝不会保存在我们的服务器上。",
    previewYou: "你",
    previewAngry: "愤怒的你",
    processing: [
      "正在寻找你内心的大叔……",
      "正在把你从照片里抠出来……",
      "正在测量眉毛的怒气……",
      "正在加热你的脸颊……",
      "正在鼓起怒筋……",
      "正在酝酿怒火……",
      "快要够生气了……",
    ],
    noteCutout: "你的愤怒分身已就绪。",
    noteOffline: "AI 离线——改用了通用怒容。",
    noteError: "这张照片出了点问题——换一张试试。",
    loseBusted: "被抓到了!",
    playAgain: "再玩一次",
    menu: "菜单",
    angryQuote: "谁把我吵醒了?!",
    drinkGame: "喝酒游戏",
    drinkClose: "干杯!",
    drinkOne: "指定 1 位朋友喝",
    drinkLeft: "你左边的朋友喝",
    drinkRight: "你右边的朋友喝",
    drinkAll: "所有人都喝!",
    hud: (n) => `还剩 ${n} 个大叔`,
    loseStats: (n) => `你在吵醒愤怒大叔前清掉了 ${n} 个大叔。`,
  },

  th: {
    _name: "ไทย",
    tagline: "ลุง ๆ เบียดกันแน่นขนัด<br>หนึ่งในนั้น<em>โกรธจัด</em>",
    btnClassic: "ลุงคลาสสิก",
    btnSelfie: "โหมดเซลฟี่โกรธ",
    gridSize: "ขนาดตาราง",
    footnote: "แตะลุงทีละคน — ปลุกลุงที่โกรธแล้วคุณแพ้",
    selfieTitle: "โหมดเซลฟี่โกรธ",
    selfieSub: "ถ่ายเซลฟี่ — AI จะตัดภาพคุณออกมาและเปลี่ยนคุณให้เป็นลุงโกรธที่ซ่อนอยู่ในฝูงชน",
    btnCamera: "ถ่ายเซลฟี่",
    btnLibrary: "เลือกจากคลังภาพ",
    btnSelfieStart: "ซ่อนฉันในฝูงชน",
    btnBack: "กลับ",
    privacy: "เซลฟี่ของคุณถูกประมวลผลในหน่วยความจำเพื่อสร้างใบหน้าโกรธ และไม่เคยถูกเก็บไว้บนเซิร์ฟเวอร์ของเรา",
    previewYou: "คุณ",
    previewAngry: "คุณที่โกรธ",
    processing: [
      "กำลังค้นหาลุงในตัวคุณ...",
      "กำลังตัดภาพคุณออกจากรูป...",
      "กำลังวัดความโกรธของคิ้ว...",
      "กำลังทำให้แก้มร้อนผ่าว...",
      "กำลังเป่าเส้นเลือดโกรธ...",
      "กำลังบ่มความโกรธ...",
      "ใกล้จะโกรธพอแล้ว...",
    ],
    noteCutout: "ร่างโกรธของคุณพร้อมแล้ว",
    noteOffline: "AI ออฟไลน์ — ใช้ความโกรธแบบทั่วไปแทน",
    noteError: "รูปนี้มีปัญหา — ลองรูปอื่น",
    loseBusted: "โดนจับได้!",
    playAgain: "เล่นอีกครั้ง",
    menu: "เมนู",
    angryQuote: "ใครปลุกฉัน?!",
    drinkGame: "เกมดื่ม",
    drinkClose: "ชนแก้ว!",
    drinkOne: "เลือกเพื่อน 1 คนให้ดื่ม",
    drinkLeft: "เพื่อนทางซ้ายของคุณดื่ม",
    drinkRight: "เพื่อนทางขวาของคุณดื่ม",
    drinkAll: "ทุกคนดื่ม!",
    hud: (n) => `เหลือลุงอีก ${n} คน`,
    loseStats: (n) => `คุณเคลียร์ลุงไป ${n} คนก่อนจะปลุกลุงที่โกรธ`,
  },
};

let current = "en";

export function getLang() {
  return current;
}

export function setLang(lang) {
  if (STRINGS[lang]) current = lang;
  return current;
}

// Resolve a key for the current language, falling back to English.
export function t(key) {
  const v = STRINGS[current]?.[key];
  return v !== undefined ? v : STRINGS.en[key];
}
