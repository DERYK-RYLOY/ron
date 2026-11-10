// Generates assets/banner-v5-{dark,light}.gif — the RON typewriter banner as a GIF.
// SMIL/CSS inside <img> SVGs don't step reliably on GitHub, so the banner ships as
// an ordinary animated GIF: type ABC -> delete -> type 123 -> delete -> next RON style.
const fs = require("fs"), path = require("path");
const sharp = require("sharp");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const opentype = require("opentype.js");

const SRC = path.resolve(__dirname, "..");
const DIST = path.join(SRC, "dist");
const ASSETS = path.join(SRC, "assets");

const THEMES = [
  { key: "black",   file: "RON-Black.otf"   },
  { key: "mono",    file: "RON-Mono.otf"    },
  { key: "dot",     file: "RON-Dot.otf"     },
  { key: "scan",    file: "RON-Scan.otf"    },
  { key: "outline", file: "RON-Outline.otf" },
];
const SEQUENCE = ["A", "B", "C", "1", "2", "3"];
const APPEAR = { A: 0.34, B: 0.71, C: 1.08, "1": 3.12, "2": 3.62, "3": 4.03 };
const VANISH = { A: 2.44, B: 2.26, C: 2.08, "1": 5.12, "2": 4.93, "3": 4.75 };
const SLICE = 6.4, CYCLE = 5 * SLICE;
const FRAME_MS = 70;
const FRAMES = Math.round(CYCLE * 1000 / FRAME_MS); // ~457
const TARGET_W = 1120;

const JUMPS = [
  [0.0, 0], [0.34, 1], [0.71, 2], [1.08, 3],
  [2.08, 2], [2.26, 1], [2.44, 0],
  [3.12, 4], [3.62, 5], [4.03, 6],
  [4.75, 5], [4.93, 4], [5.12, 0],
];

function glyph(font, ch) {
  const g = font.charToGlyph(ch);
  let d = "";
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
const unitLayout = font => {
  const adv = SEQUENCE.map(ch => font.charToGlyph(ch).advanceWidth);
  const space = font.charToGlyph(" ").advanceWidth || 480;
  const track = 60;
  let x = 0; const per = [];
  for (let i = 0; i < SEQUENCE.length; i++) {
    let xi = x;
    if (i === 3) xi += space;
    per.push(xi);
    x = xi + adv[i] + track;
  }
  return { adv, per, total: per[5] + adv[5], track, space };
};

const themesUnit = THEMES.map(t => ({ ...t, font: loadFont(t.file) }));
themesUnit.forEach(t => (t.unit = unitLayout(t.font)));
const maxUnit = Math.max(...themesUnit.map(t => t.unit.total));
const scale = TARGET_W / maxUnit;
const CAP_PX = Math.round(620 * scale);
const baseline = Math.round(CAP_PX * 1.16);
const height = Math.round(CAP_PX * 1.58);
const maxW = TARGET_W + 80; // 40px margins (viewBox -40 .. W+40)

const themes = themesUnit.map(t => {
  const s = scale;
  const track = t.unit.track * s;
  const per = t.unit.per.map(v => v * s);
  const adv = t.unit.adv.map(v => v * s);
  const letters = SEQUENCE.map((ch, i) => {
    const { d } = glyph(t.font, ch);
    return { ch, d, x: per[i], w: adv[i] };
  });
  const total = letters[5].x + letters[5].w;
  const offsetX = Math.round((TARGET_W - total) / 2) + 40; // +40 margin
  const gap = 16;
  const slots = [0, ...letters.map(it => it.x + it.w + gap)].map(v => v + 40 + offsetX);
  return { ...t, letters, offsetX, slots };
});

const cursorD = `M7 0H15L22 7V${CAP_PX - 7}L15 ${CAP_PX}H7L0 ${CAP_PX - 7}V7Z`;
const BLINK = 1.06, BLINK_ON = 0.53; // half period on

function slotAt(localT, slots) {
  let s = 0;
  for (const [tt, idx] of JUMPS) if (localT >= tt) s = slots[idx];
  return s;
}

function frameSvg(t, scheme) {
  const k = Math.floor(t / SLICE);
  const th = themes[k];
  const localT = t - k * SLICE;
  const parts = [];
  th.letters.forEach(it => {
    if (localT < APPEAR[it.ch] || localT >= VANISH[it.ch]) return;
    parts.push(`<path transform="translate(${(th.offsetX + it.x).toFixed(1)},${baseline}) scale(${scale.toFixed(5)},${-scale.toFixed(5)})" fill="${scheme.letter}" d="${it.d}"/>`);
  });
  const hideAt = 6.0;
  if (localT < hideAt && (t % BLINK) < BLINK_ON) {
    parts.push(`<path transform="translate(${slotAt(localT, th.slots).toFixed(1)},${baseline - CAP_PX})" fill="#d8ff3a" d="${cursorD}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxW} ${height}" width="${maxW}" height="${height}">${parts.join("")}</svg>`;
}

const SCHEMES = [
  { key: "dark",  letter: "#f2f2ed" },
  { key: "light", letter: "#101014" },
];

(async () => {
  for (const scheme of SCHEMES) {
    const gif = GIFEncoder();
    for (let f = 0; f < FRAMES; f++) {
      const t = (f * FRAME_MS) / 1000;
      const svg = frameSvg(t, scheme);
      const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const palette = quantize(data, 64, { format: "rgba4444", oneBitAlpha: true });
      const index = applyPalette(data, palette, "rgba4444");
      const transparentIndex = palette.findIndex(p => p[3] === 0);
      const opt = { palette, delay: FRAME_MS, repeat: f === 0 ? 0 : -1 };
      if (transparentIndex >= 0) { opt.transparent = true; opt.transparentIndex = transparentIndex; }
      gif.writeFrame(index, info.width, info.height, opt);
      if (f % 60 === 0) process.stdout.write(`  ${scheme.key}: frame ${f}/${FRAMES}\r`);
    }
    gif.finish();
    const out = path.join(ASSETS, `banner-v5-${scheme.key}.gif`);
    fs.writeFileSync(out, Buffer.from(gif.bytes()));
    console.log(`\nwrote assets/banner-v5-${scheme.key}.gif  ${(fs.statSync(out).size / 1024).toFixed(0)} KB  (${FRAMES} frames)`);
  }
})();
