// ron — braille.js
// Render any text as Unicode braille art drawn in the shapes of the RON alphabet.
// Usage:  node braille.js "SHIP IT"          (to a terminal)
//         node braille.js --plain "SHIP IT"  (no ANSI colors)
//
// Needs the source PNGs in ../ (this script lives in build/).

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = path.resolve(__dirname, '..');

const FILE = {
  A: 'a.png', B: '02_B.png', C: '03_C.png', D: '04_D.png', E: '05_E.png',
  F: '06_F.png', G: '07_G.png', H: '08_H.png', I: '09_I.png', J: '10_J.png',
  K: '11_K.png', L: '12_L.png', M: '13_M.png', N: '14_N.png', O: '15_O.png',
  P: '16_P.png', Q: '17_Q.png', R: '18_R.png', S: '19_S.png', T: '20_T.png',
  U: '21_U.png', V: '22_V.png', W: '23_W.png', X: '24_X.png', Y: '25_Y.png', Z: '26_Z.png',
  '0': '41_0.png', '1': '32_1.png', '2': '33_2.png', '3': '34_3.png', '4': '35_4.png',
  '5': '36_5.png', '6': '37_6.png', '7': '38_7.png', '8': '39_8.png', '9': '40_9.png',
  '.': '27_dot.png', '!': '28_exclam.png', '/': '29_slash.png', '*': '30_asterisk.png',
  ',': '31_comma.png', '"': '42_quote.png', '&': '45_amp.png', '#': '46_hash.png',
  ':': '47_colon.png', ';': '48_semicolon.png', '(': '44_parens.png', ')': '44_parens.png',
  '[': '43_brackets.png', ']': '43_brackets.png',
};

// braille dot bits, indexed [row 0..3 (top→bottom)][col 0..1]
const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
const GW = 4, GH = 3;               // braille chars per glyph (4 wide × 3 tall)
const PX_W = GW * 2, PX_H = GH * 4; // sample grid 8 × 12

async function loadTight(file) {
  const { data, info } = await sharp(path.join(SRC, file)).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const alpha = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = data[i * C + (C - 1)];
  // trim
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (alpha[y * W + x] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = alpha[(y0 + y) * W + (x0 + x)];
  return { W: w, H: h, alpha: a };
}

const blank = () => Array.from({ length: GH }, () => '⠀'.repeat(GW));

async function glyphBraille(ch) {
  const entry = FILE[ch];
  if (!entry) return blank();
  const m = await loadTight(entry);
  if (!m) return blank();
  const rows = [];
  for (let by = 0; by < GH; by++) {
    let line = '';
    for (let bx = 0; bx < GW; bx++) {
      let bits = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
        const gx = bx * 2 + dx, gy = by * 4 + dy;
        const sx = Math.min(m.W - 1, Math.floor((gx + 0.5) * m.W / PX_W));
        const sy = Math.min(m.H - 1, Math.floor((gy + 0.5) * m.H / PX_H));
        if (m.alpha[sy * m.W + sx] > 110) bits |= BIT[dy][dx];
      }
      line += String.fromCharCode(0x2800 + bits);
    }
    rows.push(line);
  }
  return rows;
}

(async () => {
  const args = process.argv.slice(2);
  const plain = args[0] === '--plain';
  const text = (plain ? args.slice(1) : args).join(' ').toUpperCase();
  if (!text) { console.error('usage: node braille.js [--plain] "TEXT TO RENDER"'); process.exit(1); }

  const blocks = [];
  for (const ch of text) blocks.push(ch === ' ' ? blank() : await glyphBraille(ch));

  const ACID = plain ? '' : '\x1b[38;2;216;255;58m';
  const RESET = plain ? '' : '\x1b[0m';
  for (let r = 0; r < GH; r++) {
    console.log(ACID + blocks.map(b => b[r]).join('  ') + RESET);
  }
})().catch(e => { console.error(e); process.exit(1); });
