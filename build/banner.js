// Generates assets/banner-{dark,light}.svg — a typewriter animation, not a slideshow.
//
// Per theme, in sequence:
//   types  A  B  C    (one letter at a time, like a keyboard)
//   holds, then deletes  C  B  A    (backspace, one at a time)
//   types  1  2  3
//   holds, then deletes  3  2  1
//   switches to the next RON style and repeats forever.
//
// A blinking RON chamfered caret sits behind the last typed letter and moves
// with every keystroke and every backspace.

const fs = require("fs"), path = require("path");
const opentype = require("opentype.js");

const SRC = path.resolve(__dirname, "..");
const DIST = path.join(SRC, "dist");
const ASSETS = path.join(SRC, "assets");
if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });

const THEMES = [
  { file: "RON-Black.otf",   label: "RON Black" },
  { file: "RON-Mono.otf",    label: "RON Mono" },
  { file: "RON-Dot.otf",     label: "RON Dot" },
  { file: "RON-Scan.otf",    label: "RON Scan" },
  { file: "RON-Outline.otf", label: "RON Outline" },
];

const SLICE = 6.4;                  // seconds per theme
const CYCLE = THEMES.length * SLICE;  // 32s
const TARGET_W = 1120;

const SEQUENCE = ["A", "B", "C", "1", "2", "3"];
const APPEAR = { A: 0.4, B: 0.8, C: 1.2, "1": 3.2, "2": 3.6, "3": 4.0 };  // type times (slice-local, s)
const VANISH = { A: 2.6, B: 2.2, C: 1.8, "1": 5.6, "2": 5.2, "3": 4.8 };  // backspace times

// caret jumps: [time (slice-local), slot index into slots array]
const JUMPS = [
  [0.0, 0],
  [0.4, 1], [0.8, 2], [1.2, 3],
  [1.8, 2], [2.2, 1], [2.6, 0],
  [3.2, 4], [3.6, 5], [4.0, 6],
  [4.8, 5], [5.2, 4], [5.6, 0],
];

const SCHEMES = [
  { key: "dark",  letter: "#f2f2ed" },
  { key: "light", letter: "#101014" },
];

function glyph(font, ch) {
  const g = font.charToGlyph(ch);
  let d = "";
  if (!g || !g.path) return { d: "", advance: 500 };
  for (const c of g.path.commands) {
    if (c.type === "M") d += `M${c.x} ${c.y} `;
    else if (c.type === "L") d += `L${c.x} ${c.y} `;
    else if (c.type === "C") d += `C${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y} `;
    else if (c.type === "Q") d += `Q${c.x1} ${c.y1} ${c.x} ${c.y} `;
    else if (c.type === "Z") d += "Z ";
  }
  return { d, advance: g.advanceWidth || 500 };
}

function loadFont(file) {
  const b = fs.readFileSync(path.join(DIST, file));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return opentype.parse(ab);
}

// unit-scale layout (advance widths in font units), shared by all themes for measure
const unitLayout = font => {
  const adv = SEQUENCE.map(ch => font.charToGlyph(ch).advanceWidth);
  const space = font.charToGlyph(" ").advanceWidth || 480;
  const track = 60;
  const a = SEQUENCE.map(() => 0);
  let x = 0;
  const per = [];
  for (let i = 0; i < SEQUENCE.length; i++) {
    let xi = x;
    if (i === 3) xi += space; // word gap exactly once, between C and 1
    per.push(xi);
    x = xi + adv[i] + track;
  }
  const total = per[5] + adv[5];
  return { adv, per, total, track, space };
};

const pct = t => +(t / CYCLE * 100).toFixed(2);

// measure everything at scale 1, pick one scale so every theme fits TARGET_W
const themesUnit = THEMES.map(t => {
  const font = loadFont(t.file);
  return { ...t, font, unit: unitLayout(font) };
});
const maxUnit = Math.max(...themesUnit.map(t => t.unit.total));
const scale = TARGET_W / maxUnit;
const CAP_PX = Math.round(620 * scale);
const baseline = Math.round(CAP_PX * 1.16);
const height = Math.round(CAP_PX * 1.58);

const themes = themesUnit.map(t => {
  const s = scale;
  const track = t.unit.track * s;
  const per = t.unit.per.map(v => v * s);
  const adv = t.unit.adv.map(v => v * s);
  const space = t.unit.space * s;
  const letters = SEQUENCE.map((ch, i) => {
    const { d } = glyph(t.font, ch);
    return { ch, d, x: per[i], w: adv[i] };
  });
  const total = letters[5].x + letters[5].w;
  const offsetX = Math.round((TARGET_W - total) / 2);
  // caret slots: 0 = before A, 1 = after A, 2 = after B, 3 = after C, 4 = after 1, 5 = after 2, 6 = after 3
  const gap = 16;
  const slots = [
    0,
    letters[0].x + letters[0].w + gap,
    letters[1].x + letters[1].w + gap,
    letters[2].x + letters[2].w + gap,
    letters[3].x + letters[3].w + gap,
    letters[4].x + letters[4].w + gap,
    letters[5].x + letters[5].w + gap,
  ];
  return { ...t, letters, total, offsetX, slots, baseline, CAP_PX };
});
const maxW = TARGET_W;

// ---------- keyframes (same for both color schemes) ----------
let cssKeyframes = "";
const themeGroups = [];

for (let k = 0; k < themes.length; k++) {
  const t = themes[k];
  const base = k * SLICE;
  const basePct = k * (SLICE / CYCLE) * 100;
  const hideAt = pct(base + 6.0);
  const sliceEnd = pct(base + SLICE);

  // theme switcher: hard cut per slice (typewriter "page turn")
  if (k === 0) {
    cssKeyframes += `@keyframes theme0{0%,${hideAt}%{opacity:1}${hideAt}%,100%{opacity:0}}\n`;
  } else {
    cssKeyframes += `@keyframes theme${k}{0%,${pct(base - 0.01)}%{opacity:0}${pct(base)}%{opacity:0}${pct(base)}%,${hideAt}%{opacity:1}${hideAt}%,100%{opacity:0}}\n`;
  }

  // letters: appear instantly on keypress, vanish instantly on backspace
  const letterEls = [];
  t.letters.forEach((it, i) => {
    const tOn = pct(base + APPEAR[it.ch]);
    const tOff = pct(base + VANISH[it.ch]);
    const name = `typ${k}_${i}`;
    cssKeyframes += `@keyframes ${name}{0%,${tOn}%{opacity:0}${tOn}%{opacity:1}${tOff}%{opacity:1}${tOff}%,100%{opacity:0}}\n`;
    letterEls.push(
      `<path class="l" style="animation-name:${name}" transform="translate(${it.x.toFixed(1)},${baseline}) scale(${scale.toFixed(5)},${-scale.toFixed(5)})" d="${it.d}"/>`
    );
  });

  // caret: instant jump on every keystroke and backspace, holds between events
  const caretPoints = JUMPS.map(([tS, slot]) => [pct(base + tS), slot]);
  let ck = `@keyframes caret${k}{`;
  for (let i = 0; i < caretPoints.length; i++) {
    const [p, slot] = caretPoints[i];
    if (i === 0) ck += `0%{transform:translateX(${t.slots[slot].toFixed(1)}px)}`;
    else {
      const [pPrev, slotPrev] = caretPoints[i - 1];
      ck += `${p}%{transform:translateX(${t.slots[slotPrev].toFixed(1)}px)}${p}%{transform:translateX(${t.slots[slot].toFixed(1)}px)}`;
    }
  }
  ck += `${hideAt}%{opacity:1}${hideAt}%{opacity:0}100%{opacity:0}}`;
  cssKeyframes += ck + "\n";

  themeGroups.push(
    `<g class="theme theme${k}" transform="translate(${t.offsetX},0)">\n` +
    letterEls.join("\n") + "\n" +
    `<g class="caretPos" style="animation-name:caret${k}"><g class="blink"><path class="cursor" transform="translate(0,${baseline - CAP_PX})" d="M7 0H15L22 7V${CAP_PX - 7}L15 ${CAP_PX}H7L0 ${CAP_PX - 7}V7Z"/></g></g>\n` +
    `</g>`
  );
}

for (const scheme of SCHEMES) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 0 ${maxW + 80} ${height}" width="${maxW + 80}" height="${height}" role="img" aria-label="RON types ABC, deletes it, types 123, deletes it — cycling through all five RON themes">
<title>RON — typewriter animation across five themes</title>
<style>
.l{fill:${scheme.letter};opacity:0;animation-duration:${CYCLE}s;animation-iteration-count:infinite;animation-timing-function:linear}
.cursor{fill:#d8ff3a}
.blink{animation:blink 0.9s steps(1,end) infinite}
.theme{opacity:0;animation-duration:${CYCLE}s;animation-iteration-count:infinite;animation-timing-function:linear}
.theme0{animation-name:theme0}.theme1{animation-name:theme1}.theme2{animation-name:theme2}.theme3{animation-name:theme3}.theme4{animation-name:theme4}
.caretPos{animation-duration:${CYCLE}s;animation-iteration-count:infinite;animation-timing-function:linear}
${cssKeyframes}@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@media (prefers-reduced-motion: reduce){.l{animation:none!important;opacity:1!important}.theme{animation:none!important;opacity:0!important}.theme0{opacity:1!important}.blink{animation:none!important;opacity:1!important}}
</style>
${themeGroups.join("\n")}
</svg>
`;
  const out = `banner-${scheme.key}.svg`;
  fs.writeFileSync(path.join(ASSETS, out), svg);
  console.log("wrote assets/" + out, `${maxW + 80}x${height}`);
}

// ---------- RON Black headings (light + dark variants) ----------
const ronBlack = loadFont(THEMES[0].file);
const HEADS = [
  ["h-skins.svg",   "THE FIVE SKINS"],
  ["h-get.svg",     "GET THE FONT"],
  ["h-spec.svg",    "SPEC SHEET"],
  ["h-license.svg", "LICENSE"],
];
const HS = 56 / 620;
for (const [file, text] of HEADS) {
  let x = 0;
  const items = [];
  for (const ch of text) {
    if (ch === " ") { x += 300 * HS; continue; }
    const { d, advance } = glyph(ronBlack, ch);
    items.push({ d, x });
    x += advance * HS + 26 * HS;
  }
  const dot = glyph(ronBlack, ".");
  const w = Math.ceil(x + 700 * HS), h = 84, base = 62;
  const paths = items.map(it =>
    `<path transform="translate(${it.x.toFixed(1)},${base}) scale(${HS.toFixed(5)},${-HS.toFixed(5)})" d="${it.d}"/>`
  ).join("");
  for (const scheme of SCHEMES) {
    const out = file.replace(/\.svg$/, `-${scheme.key}.svg`);
    const svgH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${text}">
<title>${text}</title>
<style>
.fg{fill:${scheme.letter}}
.acid{fill:#d8ff3a}
</style>
<g class="fg">${paths}<path class="acid" transform="translate(${(x + 10).toFixed(1)},${base}) scale(${HS.toFixed(5)},${-HS.toFixed(5)})" d="${dot.d}"/></g>
</svg>`;
    fs.writeFileSync(path.join(ASSETS, out), svgH);
  }
  console.log("wrote assets/" + file.replace(".svg", "-{dark,light}.svg"));
}
