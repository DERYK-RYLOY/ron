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
// Human-like keystroke rhythm, baked in (irregular gaps, digits slower, deletes fast,
// one long "thinking" pause before the digits — same feel as the reference demo)
const APPEAR = { A: 0.34, B: 0.71, C: 1.08, "1": 3.12, "2": 3.62, "3": 4.03 };  // type times (slice-local, s)
const VANISH = { A: 2.44, B: 2.26, C: 2.08, "1": 5.12, "2": 4.93, "3": 4.75 };  // backspace times

// caret jumps: [time (slice-local), slot index into slots array]
const JUMPS = [
  [0.0, 0],
  [0.34, 1], [0.71, 2], [1.08, 3],
  [2.08, 2], [2.26, 1], [2.44, 0],
  [3.12, 4], [3.62, 5], [4.03, 6],
  [4.75, 5], [4.93, 4], [5.12, 0],
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

// ---------- SMIL timeline (works in <img> on GitHub; CSS keyframes there don't step) ----------
const fr = t => +(t / CYCLE).toFixed(4); // keyTimes are 0..1 fractions

function buildGroups(letterFill) {
  const themeGroups = [];
  for (let k = 0; k < themes.length; k++) {
    const t = themes[k];
    const base = k * SLICE;
    const baseF = fr(base);
    const hideAt = fr(base + 6.0);

    // theme visibility window (hard cut per slice)
    const themeAnim = k === 0
      ? `<animate attributeName="opacity" values="1;1;0" keyTimes="0;${hideAt};1" calcMode="discrete" dur="${CYCLE}s" repeatCount="indefinite"/>`
      : `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;${baseF};${hideAt};1" calcMode="discrete" dur="${CYCLE}s" repeatCount="indefinite"/>`;

    // letters: instant appear on keypress, instant vanish on backspace
    const letterEls = [];
    t.letters.forEach(it => {
      const tOn = fr(base + APPEAR[it.ch]);
      const tOff = fr(base + VANISH[it.ch]);
      letterEls.push(
        `<path transform="translate(${it.x.toFixed(1)},${baseline}) scale(${scale.toFixed(5)},${-scale.toFixed(5)})" fill="${letterFill}" opacity="0" d="${it.d}"><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;${tOn};${tOff};1" calcMode="discrete" dur="${CYCLE}s" repeatCount="indefinite"/></path>`
      );
    });

    // caret: discrete jumps at every key event, blinked by inner opacity animation
    const jumps = JUMPS.map(([tS, slot]) => [fr(base + tS), t.slots[slot]]);
    const values = jumps.map(([, s]) => `${s.toFixed(1)} 0`).join(";");
    const keyTimes = jumps.map(([tt]) => tt).join(";");
    themeGroups.push(
      `<g transform="translate(${t.offsetX},0)" opacity="0">${themeAnim}\n` +
      letterEls.join("\n") + "\n" +
      `<g><animateTransform attributeName="transform" type="translate" values="${values}" keyTimes="${keyTimes}" calcMode="discrete" dur="${CYCLE}s" repeatCount="indefinite"/><g><animate attributeName="opacity" values="1;0" keyTimes="0;0.5" calcMode="discrete" dur="1.06s" repeatCount="indefinite"/><path fill="#d8ff3a" transform="translate(0,${baseline - CAP_PX})" d="M7 0H15L22 7V${CAP_PX - 7}L15 ${CAP_PX}H7L0 ${CAP_PX - 7}V7Z"/></g></g>\n` +
      `</g>`
    );
  }
  return themeGroups;
}

for (const scheme of SCHEMES) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 0 ${maxW + 80} ${height}" width="${maxW + 80}" height="${height}" role="img" aria-label="RON types ABC, backspaces, types 123, backspaces — cycling through all five RON styles">
<title>RON — typewriter animation across five styles</title>
${buildGroups(scheme.letter).join("\n")}
</svg>
`;
  const out = `banner-v4-${scheme.key}.svg`;
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
