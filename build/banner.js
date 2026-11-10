// Generates assets/banner.svg (animated typing banner) and assets/h-*.svg
// (RON Black section headings for the README) from the actual font files.
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
const SEQUENCE = ["A", "B", "C", "1", "2", "3"];
const TYPE_AT = [0.45, 1.05, 1.65, 2.45, 3.05, 3.65]; // seconds into a theme slice
const SLICE = 5.0, CYCLE = 5 * SLICE;                  // 25s cycle
const TARGET_W = 1120;                                  // px width of the banner

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

const pct = t => +(t / CYCLE * 100).toFixed(2);

function layout(font, scale) {
  const track = 60 * scale;
  let x = 0;
  const items = [];
  for (const ch of SEQUENCE) {
    const { d, advance } = glyph(font, ch);
    const w = advance * scale;
    items.push({ ch, d, w, x });
    x += w + track;
  }
  const space = (font.charToGlyph(" ").advanceWidth || 480) * scale;
  items[3].x += space; items[4].x += space; items[5].x += space;
  const total = items[items.length - 1].x + items[items.length - 1].w;
  return { items, total, space };
}

// measure at scale 1 first so every theme shares one scale (consistent letter height)
const themesUnit = THEMES.map(t => {
  const font = loadFont(t.file);
  return { ...t, font, layoutU: layout(font, 1) };
});
const maxUnit = Math.max(...themesUnit.map(t => t.layoutU.total));
const scale = TARGET_W / maxUnit;
const CAP_PX = Math.round(620 * scale);
const baseline = Math.round(CAP_PX * 1.16);
const height = Math.round(CAP_PX * 1.58);

const themes = themesUnit.map(t => ({
  ...t,
  layout: layout(t.font, scale),
  offsetX: 0, // filled after we know totals
}));
const totals = themes.map(t => t.layout.total);
const maxTotal = Math.max(...totals);
const maxW = TARGET_W;
themes.forEach(t => t.offsetX = Math.round((maxW - t.layout.total) / 2));

const chamRect = (w, h, c) =>
  `M${c} 0H${w - c}L${w} ${c}V${h - c}L${w - c} ${h}H${c}L0 ${h - c}V${c}Z`;
const cursorD = chamRect(22, CAP_PX, 7);

const SCHEMES = [
  { key: "dark",  letter: "#f2f2ed" },   // for dark backgrounds (GitHub dark)
  { key: "light", letter: "#101014" },   // for light backgrounds (GitHub light)
];

// ---------- build the theme groups + keyframes (shared; colors injected per scheme) ----------
let cssKeyframes = "";
const themeGroups = [];

for (let k = 0; k < themes.length; k++) {
  const t = themes[k];
  const base = k * SLICE;
  const endT = base + 4.55;
  const showEnd = pct(endT);
  const hideAt = pct(base + 4.9);

  // per-theme opacity keyframes (theme switcher)
  if (k === 0) {
    cssKeyframes += `@keyframes theme0{0%,${showEnd}%{opacity:1}${hideAt}%,100%{opacity:0}}\n`;
  } else {
    cssKeyframes += `@keyframes theme${k}{0%,${pct(base - 0.01)}%{opacity:0}${pct(base)}%{opacity:1}${showEnd}%{opacity:1}${hideAt}%,100%{opacity:0}}\n`;
  }

  // per-letter pop keyframes (absolute positions across the whole cycle)
  const letters = [];
  t.layout.items.forEach((it, i) => {
    const on = pct(base + TYPE_AT[i]);
    const onEnd = pct(base + TYPE_AT[i] + 0.18);
    const name = `pop${k}_${i}`;
    cssKeyframes += `@keyframes ${name}{0%,${on}%{opacity:0}${onEnd}%{opacity:1}${showEnd}%{opacity:1}${hideAt}%,100%{opacity:0}}\n`;
    letters.push(
      `<path class="l" style="animation-name:${name}" transform="translate(${it.x.toFixed(1)},${baseline}) scale(${scale.toFixed(5)},${-scale.toFixed(5)})" d="${it.d}"/>`
    );
  });

  // cursor: slots after each reveal step, jumps with the typing rhythm
  const slots = [0, ...t.layout.items.map(it => it.x + it.w + 14)];
  const jumpAt = [0, 0.45, 1.05, 1.65, 2.15, 2.45, 3.05, 3.65, 4.55];
  const jumpTo = [0, 1, 2, 3, 3, 4, 5, 6, 6];
  let ck = `@keyframes cursor${k}{`;
  jumpAt.forEach((tS, idx) => {
    const p = pct(base + tS);
    ck += `${(idx === 0 ? 0 : p - 0.5).toFixed(2)}%,${p}%{transform:translateX(${slots[jumpTo[idx]].toFixed(1)}px)}`;
  });
  ck += `${hideAt}%{opacity:0}100%{opacity:0}}`;
  cssKeyframes += ck + "\n";

  themeGroups.push(
    `<g class="theme theme${k}" transform="translate(${t.offsetX},0)">\n` +
    letters.join("\n") + "\n" +
    `<g class="cursorPos" style="animation-name:cursor${k}" transform="translate(0,0)"><g class="blink"><path class="cursor" transform="translate(0,${baseline - CAP_PX})" d="${cursorD}"/></g></g>\n` +
    `</g>`
  );
}

for (const scheme of SCHEMES) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 0 ${maxW + 80} ${height}" width="${maxW + 80}" height="${height}" role="img" aria-label="RON types ABC 123, cycling through five themes">
<title>RON — typing ABC 123 across five themes</title>
<style>
.l{fill:${scheme.letter};opacity:0;animation-duration:25s;animation-iteration-count:infinite;animation-timing-function:linear}
.cursor{fill:#d8ff3a}
.blink{animation:blink 0.9s steps(1,end) infinite}
.theme{opacity:0;animation-duration:25s;animation-iteration-count:infinite;animation-timing-function:linear}
.theme0{animation-name:theme0}.theme1{animation-name:theme1}.theme2{animation-name:theme2}.theme3{animation-name:theme3}.theme4{animation-name:theme4}
.cursorPos{animation-duration:25s;animation-iteration-count:infinite;animation-timing-function:linear}
${cssKeyframes}@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@media (prefers-reduced-motion: reduce){.l{animation:none!important;opacity:1!important}.theme{animation:none!important;opacity:0!important}.theme0{opacity:1!important}.blink{animation:none!important;opacity:1!important}}
</style>
${themeGroups.join("\n")}
</svg>
`;
  const outName = `banner-${scheme.key}.svg`;
  fs.writeFileSync(path.join(ASSETS, outName), svg);
  console.log("wrote assets/" + outName, `${maxW + 80}x${height}`);
}

// ---------- RON Black headings (light + dark variants for <picture>) ----------
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
    console.log("wrote assets/" + out);
  }
}
