// Builds scenes/blade-runner-flyby.json: a two-shot recreation of the spinner
// flyby (locked-off long-lens billboard shot, then a low-angle shot of the
// police HQ as the spinner descends to the roof). Layout/staging reference only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeBits } from '../editor/engine.js';
import { LIBRARY } from '../editor/library.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let seed = 4242;
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rr = (a, b) => a + rnd() * (b - a);
const objects = [];
let n = 0;
const id = () => 'f' + (++n);
const box = (name, group, x0, x1, y0, y1, z0, z1, extra = {}) =>
  objects.push({ id: id(), type: 'box', name, group, x0, x1, y0, y1, z0, z1, windows: 0.4, winStyle: 'grid', edges: true, bright: false, seed: Math.floor(rnd() * 256), ...extra });
const tex = (w, h, fn) => { const b = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = fn(x, y) ? 1 : 0; return encodeBits(b, w, h); };

// ---------- the geisha (same drawing as before, sampled at any scale) ----------
const inE = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
function geisha(x, y) {
  let on = (Math.floor(x) + Math.floor(y)) % 4 === 0;
  const hair = inE(x, y, 17, 10, 11, 9) || inE(x, y, 9, 15, 6, 7) || inE(x, y, 25, 15, 6, 7);
  const rim = !hair && (inE(x, y, 17, 10, 12, 10) || inE(x, y, 9, 15, 7, 8) || inE(x, y, 25, 15, 7, 8));
  if (rim) on = true;
  if (hair) on = (Math.floor(x) * 3 + Math.floor(y)) % 11 === 0;
  const face = inE(x, y, 17, 22, 7.5, 9.5) && y > 14;
  if (face) {
    on = true;
    const ex = x, ey = y;
    if ((Math.abs(ey - 21) < 0.6 && ((ex > 12.5 && ex < 15) || (ex > 19.5 && ex < 22))) || (Math.abs(ey - 20) < 0.6 && (Math.abs(ex - 15.2) < 0.6 || Math.abs(ex - 19.2) < 0.6))) on = false;
    if (Math.abs(ey - 18) < 0.5 && ((ex > 11.5 && ex < 15) || (ex > 19.5 && ex < 23))) on = false;
    if (Math.abs(ey - 27) < 0.6 && ex > 15.5 && ex < 18.8) on = false;
  }
  // a hand raised to her face (from the clip's pose), and a flower in her hair
  if (inE(x, y, 24, 25, 2.6, 4) && !inE(x, y, 24, 25, 1.6, 3)) on = true;
  if (inE(x, y, 25.5, 6, 2.2, 2.2)) on = !inE(x, y, 25.5, 6, 1, 1);
  const c = Math.abs(x - 17), edge = 4 + (y - 31) * 1.4;
  if (y >= 31) { if (c < 4) on = true; else if (c < edge - 1) on = false; else if (c < edge + 1) on = true; }
  return on;
}
// Tall portrait screen: 26 x 56 texels
const TW = 26, TH = 56;
const portrait = tex(TW, TH, (x, y) => geisha(x * 1.31, y * 1.31 - 2));
const closeUp = tex(TW, TH, (x, y) => geisha(9 + x * 0.62, 13 + y * 0.42));   // eyes-to-lips close-up
// Katakana ad: two big glyphs stacked, with scan stripes behind
const KANA = [[7, 1, 2, 2, 4], [2, 7, 5, 1, 2], [5, 7, 5, 1, 2], [0, 7, 1, 1, 7]];
const kanaAd = tex(TW, TH, (x, y) => {
  const gx = Math.floor((x - 5) / 5), gyAll = Math.floor((y - 3) / 5), slot = Math.floor(gyAll / 6), gy = gyAll % 6;
  if (x >= 5 && gx < 3 && slot < 2 && gy < 5 && y >= 3) { const g = KANA[slot === 0 ? 1 : 3]; if ((g[gy] >> (2 - gx)) & 1) return true; }
  return y % 6 === 0 && x % 2 === 0;
});
const ring = tex(16, 16, (x, y) => { const d = Math.hypot(x - 7.5, y - 7.5); return (d > 5.5 && d < 7.5) || (Math.abs(y - 7.5) < 1 && d < 5) || (Math.abs(x - 7.5) < 1 && d < 5); });
const hotel = tex(24, 8, (x, y) => (y === 0 || y === 7 || x === 0 || x === 23) || ((x % 6 > 1 && x % 6 < 5) && y > 1 && y < 6 && (x + y) % 3 !== 0));

// ======================= SHOT 1: the billboard (0-8 s) =======================
// The billboard tower: the screen is on its camera-facing (-z) side
box('Billboard tower', 'Shot 1', 6, 24, 0, 112, 70, 88, { windows: 0.15 });
objects.push({ id: 'geisha', type: 'billboard', name: 'Geisha screen', pos: [15, 48, 69.9], yaw: 180, w: 17, h: 50,
  tex: { w: TW, h: TH, frames: [{ bits: portrait, dur: 4.3 }, { bits: kanaAd, dur: 1.7 }, { bits: closeUp, dur: 15 }] },
  scanline: true, glitch: true, border: false });
// Dense tower to the right
box('Window tower', 'Shot 1', 24, 44, 0, 96, 62, 82, { windows: 0.62 });
box('Window tower 2', 'Shot 1', 46, 66, 0, 70, 90, 110, { windows: 0.5 });
// Left side: shorter buildings, a round neon sign high up, a small yellow sign
box('Left block', 'Shot 1', -34, -12, 0, 46, 74, 96, { windows: 0.3 });
box('Left low', 'Shot 1', -10, 4, 0, 26, 94, 108, { windows: 0.25 });
box('Left tall', 'Shot 1', -46, -30, 0, 70, 110, 130, { windows: 0.35 });
objects.push({ id: id(), type: 'billboard', name: 'Round neon', group: 'Shot 1', pos: [-24, 66, 109.9], yaw: 180, w: 7, h: 7,
  tex: { w: 16, h: 16, frames: [{ bits: ring, dur: 1 }] }, scanline: false, glitch: true, border: false });
objects.push({ id: id(), type: 'billboard', name: 'Hotel sign', group: 'Shot 1', pos: [-3, 31, 93.9], yaw: 180, w: 4, h: 1.4,
  tex: { w: 24, h: 8, frames: [{ bits: hotel, dur: 1 }] }, scanline: false, glitch: false, border: false });
// Deep background city that the spinner flies out of
for (let i = 0; i < 26; i++) {
  const x = rr(-70, 70), z = rr(150, 320), w = rr(8, 18), h = rr(40, 120);
  if (Math.abs(x) < 12 && z < 200) continue;
  box('Distant', 'Shot 1 background', x, x + w, 0, h, z, z + rr(8, 18), { windows: 0.35, edges: false });
}

// The spinner of shot 1: a speck far away, coming straight at us, then sweeping right past the screen
const sp = LIBRARY.spinner;
objects.push({ id: 'spinnerA', type: 'model', name: 'Spinner (shot 1)', mesh: structuredClone(sp.mesh), scale: 1.5, autoOrient: true, bob: 0.2,
  headlights: true, thrusters: true, powerDown: false, lights: structuredClone(sp.lights),
  // ...then a close pass right across the screen, big in frame, exiting right
  keys: [{ t: 0, p: [-6, 66, 300], ease: 'linear' }, { t: 3, p: [-4, 56, 200], ease: 'linear' }, { t: 5.5, p: [1, 46, 115], ease: 'linear' },
    { t: 6.8, p: [8, 39, 52], ease: 'linear' }, { t: 7.5, p: [14, 35, 26], ease: 'linear' }, { t: 8.2, p: [40, 30, 8], ease: 'linear' }] });

// ======================= SHOT 2: police HQ (8-21 s) =======================
// A massive stepped tower with an overhanging upper block; landing pad on top
const HQ = 'Shot 2 police HQ';
box('HQ shaft', HQ, -20, 20, 0, 70, 300, 345, { windows: 0.78, bright: true });
box('HQ overhang', HQ, -32, 26, 70, 86, 286, 350, { windows: 0.8, bright: true });
box('HQ crown', HQ, -18, 16, 86, 92, 296, 340, { windows: 0.3, winStyle: 'bands', bright: true });
box('HQ pad', HQ, -11, 11, 92, 96, 306, 330, { windows: 0, winStyle: 'none', bright: true });
box('HQ mast', HQ, 9, 9.6, 96, 110, 327, 327.6, { windows: 0, winStyle: 'none', bright: true });
box('HQ wing', HQ, 22, 40, 0, 62, 305, 340, { windows: 0.7, bright: true });
// Neighbouring towers filling the sky on the left
for (let i = 0; i < 7; i++) { const x = -70 + i * 9 + rr(-2, 2); box('Neighbour', 'Shot 2 city', x, x + 8, 0, rr(60, 115), rr(330, 380), rr(390, 420), { windows: 0.45, edges: false }); }
// Street level right in front of the camera: neon signs and lamps
const neon = tex(16, 6, (x, y) => (y === 0 || y === 5) ? x % 2 === 0 : (x > 1 && x < 14 && y > 1 && y < 4 && (x % 4) !== 3));
objects.push({ id: id(), type: 'billboard', name: 'Street neon 1', group: 'Shot 2 street', pos: [-7, 3, 284], yaw: 160, w: 5, h: 1.8, tex: { w: 16, h: 6, frames: [{ bits: neon, dur: 0.9 }, { bits: tex(16, 6, () => false), dur: 0.08 }] }, scanline: false, glitch: false, border: true });
objects.push({ id: id(), type: 'billboard', name: 'Street neon 2', group: 'Shot 2 street', pos: [4, 2, 288], yaw: 200, w: 3.5, h: 1.3, tex: { w: 16, h: 6, frames: [{ bits: neon, dur: 1 }] }, scanline: false, glitch: false, border: true });
objects.push({ id: id(), type: 'lights', name: 'Street lamps', group: 'Shot 2 street', shape: 'line', a: [-14, 1.6, 286], b: [12, 1.6, 296], spacing: 3, mode: 'steady', rate: 1 });
objects.push({ id: id(), type: 'lights', name: 'Pad lights', group: HQ, shape: 'rect', a: [-11, 96.1, 306], b: [11, 96.1, 330], spacing: 2, mode: 'chase', rate: 8 });
objects.push({ id: id(), type: 'lights', name: 'Mast beacon', group: HQ, shape: 'line', a: [8.8, 110.6, 327.3], b: [9.8, 110.6, 327.3], spacing: 0.5, mode: 'blink', rate: 1.5 });

// The spinner of shot 2: parked out of sight until the cut, then descending slowly to the pad
objects.push({ id: 'spinnerB', type: 'model', name: 'Spinner (shot 2)', mesh: structuredClone(sp.mesh), scale: 3, autoOrient: false, bob: 0.15,
  headlights: true, thrusters: true, powerDown: true, lights: structuredClone(sp.lights),
  keys: [{ t: 0, p: [26, 400, 336], r: [205, 0, 0], ease: 'linear' }, { t: 7.95, p: [26, 400, 336], r: [205, 0, 0], ease: 'cut' },
    { t: 8, p: [26, 150, 336], r: [205, 0, 0], ease: 'out' }, { t: 13, p: [15, 118, 326], r: [200, 4, -6], ease: 'smooth' },
    { t: 17, p: [5, 103, 320], r: [192, 2, 3], ease: 'out' }, { t: 19.5, p: [0, 96.35, 318], r: [190, 0, 0], ease: 'linear' }] });

// ======================= camera =======================
const fixed = (t, eye, look, ease = 'linear') => ({ t, mode: 'fixed', eye, look, ease });
const scene = {
  version: 1, name: 'blade-runner-flyby', duration: 21,
  settings: { focal: 50, near: 0.6, far: 240, fogDist: 190, winSpacingX: 3, winSpacingY: 3.5, rain: { count: 14, slant: 0.25, speed: 65 },
    fadeIn: 0.6, fadeOut: 1.5, lightDir: [-0.6, 1, -0.5] },
  objects,
  camera: { keys: [
    // Shot 1: long lens, slow push-in toward the screen
    fixed(0, [-6, 30, -6], [-4, 42, 80]), fixed(7.99, [-3, 31, 8], [-3, 42, 84], 'cut'),
    // Hard cut. Shot 2: low angle, looking steeply up at the HQ, barely drifting
    fixed(8, [10, 3, 266], [-4, 72, 322]), fixed(21, [11, 3.4, 268], [-5, 73, 322]),
  ] },
};
fs.writeFileSync(path.join(root, 'scenes/blade-runner-flyby.json'), JSON.stringify(scene, null, 1));
console.log(`blade-runner-flyby: ${objects.length} objects`);
