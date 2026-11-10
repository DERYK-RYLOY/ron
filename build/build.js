// RON — build real OpenType fonts from the glyph bitmaps in ../
//
//   RON Black    solid (the original design)
//   RON Mono     same outlines, monospaced advances — for terminals / code
//   RON Dot      braille / dot-matrix halftone theme
//   RON Scan     CRT scanline theme
//   RON Outline  hollow / ring theme
//
// All glyphs are traced to true vector outlines — resolution independent,
// sharp at any size, from a phone to a 40-foot wall.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const opentype = require('opentype.js');
const potrace = require('potrace');

const SRC_DIR = path.resolve(__dirname, '..', 'bitmaps');
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

const UPM = 1000;
const ASCENDER = 810, DESCENDER = -280;
const CAP_U = 620;                 // cap height in font units
const PX = CAP_U / 61;             // font units per source pixel
const SB = 80;                     // sidebearing in font units
const MONO_ADV = 980;
const VENDOR = 'ROND';
const VERSION = '1.000';
const KAPPA = 0.5522847498;

// ---------- masks ----------

async function loadMask(file, extract) {
  let img = sharp(path.join(SRC_DIR, file));
  if (extract) img = img.extract({ left: extract[0], top: extract[1], width: extract[2], height: extract[3] });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const alpha = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = data[i * C + (C - 1)];
  return { W, H, alpha };
}

function tightBBox(m) {
  let x0 = m.W, y0 = m.H, x1 = -1, y1 = -1;
  for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) {
    if (m.alpha[y * m.W + x] > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function cropMask(m, b) {
  const alpha = new Uint8Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++)
    alpha[y * b.w + x] = m.alpha[(b.y0 + y) * m.W + (b.x0 + x)];
  return { W: b.w, H: b.h, alpha };
}

function erode(m, n, hard = 110) {
  const { W, H } = m;
  let cur = Uint8Array.from(m.alpha, v => (v > hard ? 1 : 0));
  for (let it = 0; it < n; it++) {
    const next = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!cur[y * W + x]) continue;
      let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !cur[ny * W + nx]) ok = 0;
      }
      next[y * W + x] = ok;
    }
    cur = next;
  }
  return { W, H, alpha: Uint8Array.from(cur, v => (v ? 255 : 0)) };
}

// rasterize a white polygon on transparent bg -> mask (for synthetic glyphs)
async function maskFromPolygon(points, w, h) {
  const pts = points.map(p => p[0] + ',' + p[1]).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><polygon points="${pts}" fill="#fff"/></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const alpha = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = data[i * C + (C - 1)];
  return { W, H, alpha };
}

const chamfer = (x0, y0, x1, y1, cut) => [
  [x0 + cut, y0], [x1 - cut, y0], [x1, y0 + cut], [x1, y1 - cut],
  [x1 - cut, y1], [x0 + cut, y1], [x0, y1 - cut], [x0, y0 + cut],
];

// ---------- master outlines ----------
// The design is piecewise H / V / 45°-diagonal — we flatten potrace's contours
// fully, then re-fit them with a *constrained* simplifier that may only emit
// H / V / 45° edges (perpendicular error <= tau). The result is lattice-crisp
// geometry with no curve smoothing and no visible banding.

// full flatten of potrace output (handles C/Q curves by sampling)
async function traceRaw(m) {
  const gray = Buffer.alloc(m.W * m.H);
  for (let i = 0; i < gray.length; i++) gray[i] = 255 - m.alpha[i];
  const png = await sharp(gray, { raw: { width: m.W, height: m.H, channels: 1 } }).png().toBuffer();
  const svg = await new Promise((res, rej) =>
    potrace.trace(png, { turdSize: 4, alphaMax: 1.0, optCurve: false, optTolerance: 0.2, threshold: 128 },
      (err, svg) => (err ? rej(err) : res(svg))));
  const mD = svg.match(/d="([^"]+)"/);
  if (!mD) return [];
  const d = mD[1];
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const subs = [];
  let cur = null, cmd = null, i = 0;
  const read = n => { const v = []; for (let k = 0; k < n; k++) v.push(parseFloat(tokens[i++])); return v; };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[A-Za-z]/.test(t)) {
      i++;
      if (t === 'Z' || t === 'z') { if (cur) subs.push(cur); cur = null; cmd = null; continue; }
      cmd = t; continue;
    }
    if (!cmd) throw new Error('operator missing before ' + t);
    if (cmd === 'M') {
      const [x, y] = read(2);
      if (cur) subs.push(cur);
      cur = [[x, y]];
      cmd = 'L';
    } else if (cmd === 'L') {
      const [x, y] = read(2); cur.push([x, y]);
    } else if (cmd === 'C') {
      const [x1, y1, x2, y2, x, y] = read(6);
      const p0 = cur[cur.length - 1], p3 = [x, y];
      for (let k = 1; k <= 14; k++) cur.push(cubicAt(p0, [x1, y1], [x2, y2], p3, k / 14));
    } else if (cmd === 'Q') {
      const [x1, y1, x, y] = read(4);
      const p0 = cur[cur.length - 1], p2 = [x, y];
      for (let k = 1; k <= 10; k++) cur.push(quadAt(p0, [x1, y1], p2, k / 10));
    } else {
      throw new Error('Unexpected SVG command: ' + cmd);
    }
  }
  if (cur) subs.push(cur);
  return subs;
}

// open-chain DP: only H / V / 45-degree segments may be emitted; tau = max perpendicular error
function segErr(pts, a, b, tau) {
  const [x0, y0] = pts[a], [x1, y1] = pts[b];
  const dx = x1 - x0, dy = y1 - y0;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 1;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 1;
  let kind, worst = 0;
  if (ady <= 0.75 && adx > 0.75) kind = 0;
  else if (adx <= 0.75 && ady > 0.75) kind = 1;
  else if (adx > 1.5 && ady > 1.5 && Math.abs(adx - ady) <= 0.18 * Math.max(adx, ady)) kind = 2;
  else return Infinity;
  for (let i = a + 1; i < b; i++) {
    const [px, py] = pts[i];
    let d;
    if (kind === 0) d = Math.abs(py - y0);
    else if (kind === 1) d = Math.abs(px - x0);
    else d = Math.abs((px - x0) * sy - (py - y0) * sx) / Math.SQRT2;
    if (d > worst) worst = d;
    if (worst > tau) return Infinity;
  }
  return worst;
}

function simplifyOpen(pts, tau, lambda) {
  const n = pts.length;
  const cost = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  cost[0] = 0;
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (cost[j] === Infinity) continue;
      const e = segErr(pts, j, i, tau);
      if (e === Infinity) continue;
      const c = cost[j] + e * e + lambda;
      if (c < cost[i]) { cost[i] = c; prev[i] = j; }
    }
  }
  const chain = [];
  let i = n - 1;
  while (i > 0) { chain.push(i); i = prev[i]; if (i === -1) return null; }
  chain.push(0); chain.reverse();
  return chain;
}

// ring handling: break at leftmost point, simplify the open chain, rejoin;
// escalate tau until a feasible H/V/D segmentation exists (last resort: leave chain unsimplified)
function ringSimplify(pts, tau, lambda) {
  if (pts.length < 6) return [pts];
  let minI = 0;
  for (let i = 0; i < pts.length; i++) if (pts[i][0] < pts[minI][0]) minI = i;
  const chain = [];
  for (let k = 0; k <= pts.length; k++) chain.push(pts[(minI + k) % pts.length]);
  for (const t of [tau, 2.5, 4, Infinity]) {
    const keep = simplifyOpen(chain, t, lambda);
    if (keep) return [keep.map(i => chain[i])];
  }
  return [pts];
}

// force every edge to be exactly H / V / 45°, propagating along the chain; distribute closure error
function exactSnapChain(pts) {
  // NOTE: ring chains end where they begin (the anchor point is duplicated by ringSimplify),
  // so the total drift across the full ring is small; we spread it over the interior points.
  const out = [pts[0].slice()];
  for (let i = 1; i < pts.length; i++) {
    const p = out[i - 1], q = pts[i];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const deg = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI || 0;
    const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
    if (deg < 20) out.push([q[0], p[1]]);                       // snap horizontal
    else if (deg > 70) out.push([p[0], q[1]]);                  // snap vertical
    else if (Math.abs(deg - 45) <= 25) {                        // snap 45 degrees
      const len = (Math.abs(dx) + Math.abs(dy)) / 2;
      out.push([p[0] + sx * len, p[1] + sy * len]);
    } else out.push(q.slice());                                 // genuinely non-lattice edge: keep as is
  }
  // distribute closure error over the interior points
  const ex = out[out.length - 1][0] - out[0][0], ey = out[out.length - 1][1] - out[0][1];
  const m = out.length;
  for (let i = 1; i < m - 1; i++) { out[i][0] -= ex * i / (m - 1); out[i][1] -= ey * i / (m - 1); }
  return out;
}

// polygon area helper
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// master polygons: array of [x,y] points per contour; all edges exact H/V/45°
async function masterOutline(m) {
  const raw = await traceRaw(m);
  const polys = [];
  for (const sp of raw) {
    for (const poly of ringSimplify(sp, 1.5, 0.7)) {
      if (Math.abs(polyArea(poly)) >= 3) polys.push(exactSnapChain(poly));
    }
  }
  return polys;
}

// master outlines as segment lists (compatible with subpathsToPath)
async function masterSubpaths(m) {
  const polys = await masterOutline(m);
  return polys.map(pts => {
    const segs = [{ c: 'M', x: pts[0][0], y: pts[0][1] }];
    for (let i = 1; i < pts.length; i++) segs.push({ c: 'L', x: pts[i][0], y: pts[i][1] });
    segs.push({ c: 'Z' });
    return segs;
  });
}

// master outlines rasterized to a clean mask (for the theme variants)
async function masterMask(m) {
  const polys = await masterOutline(m);
  const pathD = polys.map(pts => 'M' + pts.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join('L') + 'Z').join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.W}" height="${m.H}" viewBox="0 0 ${m.W} ${m.H}"><path d="${pathD}" fill="#fff" fill-rule="evenodd"/></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(m.W * m.H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * info.channels];
  return { W: m.W, H: m.H, alpha };
}

// ---------- winding normalization ----------
// potrace's JS port does NOT alternate contour orientation, and PostScript/CFF
// fills with the nonzero winding rule — nested contours must wind in opposite
// directions or every counter fills solid. We flatten each subpath, measure its
// nesting depth via point-in-polygon, and reverse any contour whose winding
// does not match its depth parity (even = outer, odd = counter/hole).

function cubicAt(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}
function quadAt(p0, p1, p2, t) {
  const mt = 1 - t;
  const a = mt * mt, b = 2 * mt * t, c = t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]];
}
function flattenSubpath(sp) {
  const pts = [];
  let cur = null;
  for (const s of sp) {
    if (s.c === 'M') { cur = [s.x, s.y]; pts.push([s.x, s.y]); }
    else if (s.c === 'L') { cur = [s.x, s.y]; pts.push([s.x, s.y]); }
    else if (s.c === 'C') {
      const p0 = cur, p1 = [s.x1, s.y1], p2 = [s.x2, s.y2], p3 = [s.x, s.y];
      for (let i = 1; i <= 16; i++) pts.push(cubicAt(p0, p1, p2, p3, i / 16));
      cur = p3;
    } else if (s.c === 'Q') {
      const p0 = cur, p1 = [s.x1, s.y1], p2 = [s.x, s.y];
      for (let i = 1; i <= 12; i++) pts.push(quadAt(p0, p1, p2, i / 12));
      cur = p2;
    }
  }
  return pts;
}
function pointInPolygon(poly, pt) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function reverseSubpath(sp) {
  const head = sp[0]; // M
  let closing = [head.x, head.y];
  for (const s of sp) if (s.c !== 'M' && s.c !== 'Z') closing = [s.x, s.y];
  const out = [{ c: 'M', x: closing[0], y: closing[1] }];
  const withStart = [];
  let cur = [head.x, head.y];
  for (const s of sp) {
    if (s.c === 'M' || s.c === 'Z') continue;
    withStart.push({ s, start: cur });
    cur = [s.x, s.y];
  }
  for (let i = withStart.length - 1; i >= 0; i--) {
    const { s, start } = withStart[i];
    if (s.c === 'L') out.push({ c: 'L', x: start[0], y: start[1] });
    else if (s.c === 'C') out.push({ c: 'C', x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1, x: start[0], y: start[1] });
    else if (s.c === 'Q') out.push({ c: 'Q', x1: s.x1, y1: s.y1, x: start[0], y: start[1] });
  }
  out.push({ c: 'Z' });
  return out;
}
function fixWinding(subs) {
  const polys = subs.map(flattenSubpath);
  const areas = polys.map(polyArea);
  return subs.map((s, i) => {
    let depth = 0;
    const probe = polys[i][0];
    for (let j = 0; j < subs.length; j++) {
      if (i !== j && pointInPolygon(polys[j], probe)) depth++;
    }
    const wantPositive = depth % 2 === 0;
    const isPositive = areas[i] > 0;
    return wantPositive === isPositive ? s : reverseSubpath(s);
  });
}

// ---------- font-space assembly ----------

function makeYMap(va, H) {
  const Hf = H * PX;
  switch (va[0]) {
    case 'bottom':    { const Y = va[1]; return py => Y + (H - py) * PX; }
    case 'top':       { const Y = va[1]; return py => Y - py * PX; }
    case 'centerCap': return py => CAP_U / 2 + Hf / 2 - py * PX;
    default: throw new Error('bad valign');
  }
}

function subpathsToPath(subpaths, xOff, yMap) {
  subpaths = fixWinding(subpaths);
  const p = new opentype.Path();
  const fx = v => Math.round(v * PX + xOff);
  const fy = v => Math.round(yMap(v));
  for (const sp of subpaths) for (const s of sp) {
    if (s.c === 'M') p.moveTo(fx(s.x), fy(s.y));
    else if (s.c === 'L') p.lineTo(fx(s.x), fy(s.y));
    else if (s.c === 'C') p.curveTo(fx(s.x1), fy(s.y1), fx(s.x2), fy(s.y2), fx(s.x), fy(s.y));
    else if (s.c === 'Q') p.quadraticCurveTo(fx(s.x1), fy(s.y1), fx(s.x), fy(s.y));
    else if (s.c === 'Z') p.close();
  }
  return p;
}

function circleSubpath(cx, cy, r) {
  const k = KAPPA * r;
  return [
    { c: 'M', x: cx + r, y: cy },
    { c: 'C', x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
    { c: 'C', x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
    { c: 'C', x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
    { c: 'C', x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
    { c: 'Z' },
  ];
}

function rectSubpath(x0, y0, x1, y1) {
  return [
    { c: 'M', x: x0, y: y0 }, { c: 'L', x: x1, y: y0 },
    { c: 'L', x: x1, y: y1 }, { c: 'L', x: x0, y: y1 }, { c: 'Z' },
  ];
}

// dot-matrix sampling of a mask -> circle contours in pixel space
function dotSubpaths(m) {
  const { W, H, alpha } = m;
  const STEP = 6, R = 2.15;
  const subs = [];
  for (let cy = STEP / 2; cy < H + STEP / 2; cy += STEP) {
    for (let cx = STEP / 2; cx < W + STEP / 2; cx += STEP) {
      let sum = 0, n = 0;
      const r = STEP / 2;
      for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
          sum += alpha[y * W + x]; n++;
        }
      if (n && sum / n / 255 > 0.30) subs.push(circleSubpath(cx, cy, R));
    }
  }
  return subs;
}

// CRT scanlines: keep every 4 of 6 pixel rows, as run-rects
function scanSubpaths(m) {
  const { W, H, alpha } = m;
  const PERIOD = 6, ON = 4;
  const subs = [];
  for (let y = 0; y < H; y++) {
    if (y % PERIOD >= ON) continue;
    let run = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && alpha[y * W + x] > 110;
      if (on && run < 0) run = x;
      else if (!on && run >= 0) { subs.push(rectSubpath(run, y, x, y + 1)); run = -1; }
    }
  }
  return subs;
}

// outline ring: master mask minus its erosion, traced to clean geometry
async function outlineSubpaths(m) {
  const mm = await masterMask(m);
  const minDim = Math.min(mm.W, mm.H);
  const n = Math.max(1, Math.min(4, Math.floor(minDim / 2)));
  const er = erode(mm, n);
  const diff = { W: mm.W, H: mm.H, alpha: new Uint8Array(mm.W * mm.H) };
  for (let i = 0; i < diff.alpha.length; i++)
    diff.alpha[i] = (mm.alpha[i] > 110 && er.alpha[i] === 0) ? 200 : 0;
  return masterSubpaths(diff);
}

// ccw/cw alternation is preserved by the y-flip, so potrace output fills correctly

// ---------- glyph inventory ----------

const SPECS = (() => {
  const specs = [];
  specs.push({ file: 'a.png', name: 'A', uni: 0x41, va: ['bottom', 0] });
  const fb = { B:'02_B.png',C:'03_C.png',D:'04_D.png',E:'05_E.png',F:'06_F.png',G:'07_G.png',H:'08_H.png',I:'09_I.png',J:'10_J.png',K:'11_K.png',L:'12_L.png',M:'13_M.png',N:'14_N.png',O:'15_O.png',P:'16_P.png',Q:'17_Q.png',R:'18_R.png',S:'19_S.png',T:'20_T.png',U:'21_U.png',V:'22_V.png',W:'23_W.png',X:'24_X.png',Y:'25_Y.png',Z:'26_Z.png' };
  for (const [L, file] of Object.entries(fb)) specs.push({ file, name: L, uni: L.charCodeAt(0), va: ['bottom', 0] });
  const digits = [['32_1.png','one',0x31],['33_2.png','two',0x32],['34_3.png','three',0x33],['35_4.png','four',0x34],['36_5.png','five',0x35],['37_6.png','six',0x36],['38_7.png','seven',0x37],['39_8.png','eight',0x38],['40_9.png','nine',0x39],['41_0.png','zero',0x30]];
  for (const [file, name, uni] of digits) specs.push({ file, name, uni, va: ['bottom', 0] });
  specs.push({ file: '27_dot.png',       name: 'period',     uni: 0x2E, va: ['bottom', 0] });
  specs.push({ file: '28_exclam.png',    name: 'exclam',     uni: 0x21, va: ['bottom', 0] });
  specs.push({ file: '29_slash.png',     name: 'slash',      uni: 0x2F, va: ['bottom', 0] });
  specs.push({ file: '30_asterisk.png',  name: 'asterisk',   uni: 0x2A, va: ['centerCap'] });
  specs.push({ file: '31_comma.png',     name: 'comma',      uni: 0x2C, va: ['bottom', -140] });
  specs.push({ file: '42_quote.png',     name: 'quotedbl',   uni: 0x22, va: ['top', CAP_U + 40] });
  specs.push({ file: '45_amp.png',       name: 'ampersand',  uni: 0x26, va: ['bottom', 0] });
  specs.push({ file: '46_hash.png',      name: 'numbersign', uni: 0x23, va: ['bottom', 0] });
  specs.push({ file: '47_colon.png',     name: 'colon',      uni: 0x3A, va: ['bottom', 0] });
  specs.push({ file: '48_semicolon.png', name: 'semicolon',  uni: 0x3B, va: ['bottom', -140] });
  // pair images -> two glyphs each (empty columns 37..50)
  specs.push({ file: '43_brackets.png', name: 'bracketleft',  uni: 0x5B, va: ['centerCap'], extract: [0, 0, 37, 97] });
  specs.push({ file: '43_brackets.png', name: 'bracketright', uni: 0x5D, va: ['centerCap'], extract: [51, 0, 38, 97] });
  specs.push({ file: '44_parens.png',   name: 'parenleft',    uni: 0x28, va: ['centerCap'], extract: [0, 0, 37, 97] });
  specs.push({ file: '44_parens.png',   name: 'parenright',   uni: 0x29, va: ['centerCap'], extract: [51, 0, 38, 97] });
  // synthetic glyphs (drawn natively in the blocky style)
  specs.push({ synth: chamfer(0, 0, 26, 9, 4),   sw: 26, sh: 9,  name: 'hyphenminus', uni: 0x2D,    va: ['centerCap'] });
  specs.push({ synth: chamfer(0, 0, 42, 8, 3.5), sw: 42, sh: 8,  name: 'underscore',  uni: 0x5F,    va: ['bottom', -120] });
  specs.push({ synth: chamfer(0, 0, 15, 15, 5),  sw: 15, sh: 15, name: 'quotesingle', uni: 0x27,    va: ['top', CAP_U + 40] });
  specs.push({ synth: chamfer(0, 0, 15, 15, 5),  sw: 15, sh: 15, name: 'quoteright',  uni: 0x2019,  va: ['top', CAP_U + 40] });
  return specs;
})();

async function getSpecMask(spec) {
  if (spec.synth) return maskFromPolygon(spec.synth, spec.sw, spec.sh);
  const raw = await loadMask(spec.file, spec.extract);
  const bb = tightBBox(raw);
  return cropMask(raw, bb);
}

// ---------- theme rendering ----------

async function specSubpaths(mask, theme) {
  switch (theme) {
    case 'solid':   return masterSubpaths(mask);
    case 'outline': return outlineSubpaths(mask);
    case 'dot':     return dotSubpaths(await masterMask(mask));
    case 'scan':    return scanSubpaths(await masterMask(mask));
    default: throw new Error('unknown theme ' + theme);
  }
}

// ---------- font assembly ----------

function makeNotDefGlyph(advanceWidth) {
  const p = new opentype.Path();
  // chamfered octagon ring
  const cx = advanceWidth / 2, cy = 350, r = 175, ri = 115;
  const outer = chamfer(cx - r, cy - r, cx + r, cy + r, r * 0.42);
  const inner = chamfer(cx - ri, cy - ri, cx + ri, cy + ri, ri * 0.42).reverse();
  const rounded = Math.round;
  p.moveTo(rounded(outer[0][0]), rounded(outer[0][1]));
  for (let i = 1; i < outer.length; i++) p.lineTo(rounded(outer[i][0]), rounded(outer[i][1]));
  p.close();
  p.moveTo(rounded(inner[0][0]), rounded(inner[0][1]));
  for (let i = 1; i < inner.length; i++) p.lineTo(rounded(inner[i][0]), rounded(inner[i][1]));
  p.close();
  return new opentype.Glyph({ name: '.notdef', advanceWidth, path: p });
}

function makeSpaceGlyph(advanceWidth) {
  return new opentype.Glyph({ name: 'space', unicode: 0x20, advanceWidth, path: new opentype.Path() });
}

async function buildFont(familyName, outFile, theme, mono) {
  console.log(`\n=== ${familyName} (${theme}${mono ? ', mono' : ''}) ===`);
  const maskCache = new Map();
  const getMask = async spec => {
    if (!maskCache.has(spec.name + (spec.extract || ''))) maskCache.set(spec.name + (spec.extract || ''), await getSpecMask(spec));
    return maskCache.get(spec.name + (spec.extract || ''));
  };

  const glyphs = [makeNotDefGlyph(mono ? MONO_ADV : 500), makeSpaceGlyph(mono ? MONO_ADV : 480)];

  for (const spec of SPECS) {
    const mask = await getMask(spec);
    const subs = await specSubpaths(mask, theme);
    const yMap = makeYMap(spec.va, mask.H);
    const glyphW = Math.round(mask.W * PX);
    const advanceWidth = mono ? MONO_ADV : glyphW + 2 * SB;
    const xOff = mono ? Math.round((MONO_ADV - glyphW) / 2) : SB;
    const path = subpathsToPath(subs, xOff, yMap);
    const glyph = new opentype.Glyph({ name: spec.name, unicode: spec.uni, advanceWidth, path });
    glyphs.push(glyph);
    // lowercase twin -> same outline (RON is an all-caps display face)
    if (spec.uni >= 0x41 && spec.uni <= 0x5A) {
      glyphs.push(new opentype.Glyph({ name: spec.name.toLowerCase(), unicode: spec.uni + 32, advanceWidth, path }));
    }
    const cmds = path.commands.length;
    if (cmds < 5) console.warn(`  ! ${spec.name}: only ${cmds} path commands — check source art`);
  }

  const font = new opentype.Font({
    familyName,
    styleName: 'Regular',
    unitsPerEm: UPM,
    ascender: ASCENDER,
    descender: DESCENDER,
    weightClass: 900,
    tables: { os2: { achVendID: VENDOR, fsType: 0 } },
    glyphs,
  });

  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
  const outPath = path.join(DIST_DIR, outFile);
  const otfBytes = Buffer.from(font.toArrayBuffer());
  fs.writeFileSync(outPath, otfBytes);
  const kb = (otfBytes.length / 1024).toFixed(1);
  console.log(`  wrote ${outPath}  (${glyphs.length} glyphs, ${kb} KB)`);

  // WOFF2 twin (web)
  try {
    const wawoff2 = require('wawoff2');
    const w2 = await wawoff2.compress(new Uint8Array(otfBytes));
    const w2Path = outPath.replace(/\.otf$/, '.woff2');
    fs.writeFileSync(w2Path, Buffer.from(w2));
    console.log(`  wrote ${w2Path}  (${(w2.length / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.warn(`  ! woff2 step skipped for ${outFile}: ${e.message} (install wawoff2 to enable)`);
  }
  return font;
}

(async () => {
  const jobs = [
    ['RON Black',   'RON-Black.otf',   'solid',   false],
    ['RON Mono',    'RON-Mono.otf',    'solid',   true],
    ['RON Dot',     'RON-Dot.otf',     'dot',     false],
    ['RON Scan',    'RON-Scan.otf',    'scan',    false],
    ['RON Outline', 'RON-Outline.otf', 'outline', false],
  ];
  for (const [fam, out, theme, mono] of jobs) await buildFont(fam, out, theme, mono);
  console.log('\nDone. Heroes: solid vectors, dot halftone, scanlines and outline rings.');
})().catch(e => { console.error(e); process.exit(1); });
