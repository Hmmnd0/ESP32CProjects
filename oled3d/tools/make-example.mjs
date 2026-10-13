// Builds scenes/spinner-landing.json (the hand-coded spinner scene, as editor data)
// and exports it to firmware/include/scene.h.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeBits } from '../editor/engine.js';
import { exportSceneH } from '../editor/exporter.js';
import { LIBRARY } from '../editor/library.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let seed = 1234567;
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => Math.floor(a + rnd() * (b - a));   // [a, b)

const objects = [];
let n = 0;
const box = (name, x0, x1, y1, z0, z1, extra = {}) => objects.push({ id: 'o' + (++n), type: 'box', name, group: extra.group, x0, x1, y0: 0, y1, z0, z1,
  windows: 0.375, winStyle: 'grid', edges: true, bright: false, seed: ri(0, 256), ...extra });

const BB = { x: -7, z0: 86, z1: 102, y0: 15, y1: 34 };
for (const side of [-1, 1]) {
  for (let z = -30; z < 290;) {
    const d = ri(8, 16), inner = 6 + ri(0, 3), outer = inner + ri(8, 14), h = ri(14, 46) + (ri(0, 5) === 0 ? 30 : 0);
    if (side < 0 && z < BB.z1 + 4 && z + d > BB.z0 - 4) {
      box('Billboard tower', -20, BB.x, 44, BB.z0 - 4, BB.z1 + 4, { group: 'Street' });
      z = BB.z1 + 7; continue;
    }
    box('Street', side < 0 ? -outer : inner, side < 0 ? -inner : outer, h, z, z + d, { group: 'Street' });
    z += d + ri(2, 5);
  }
  for (let z = -20; z < 300;) {
    const d = ri(10, 20), inner = 24 + ri(0, 6), outer = inner + ri(10, 18), h = ri(36, 80);
    box('Skyline', side < 0 ? -outer : inner, side < 0 ? -inner : outer, h, z, z + d, { group: 'Skyline' });
    z += d + ri(3, 9);
  }
}
box('HQ base', -24, 24, 30, 316, 364, { group: 'Police HQ', winStyle: 'bands', bright: true });
box('HQ middle', -16, 16, 44, 322, 358, { group: 'Police HQ', winStyle: 'bands', bright: true });
box('HQ pad', -11, 11, 50, 329, 351, { group: 'Police HQ', winStyle: 'bands', bright: true });
box('HQ mast', 8.8, 9.2, 62, 348.8, 349.2, { group: 'Police HQ', y0: 50, windows: 0, winStyle: 'none', bright: true });
for (let i = 0; i < 6; i++) { const x = -60 + i * 22 + ri(-4, 4), z = 400 + ri(0, 30); box('Far tower', x, x + 10, ri(50, 95), z, z + 12, { group: 'Distance' }); }

// The geisha billboard, two frames: eyes open (3.15 s), blink (0.15 s)
const inE = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
function geisha(x, y, blinking) {
  let on = (x + y) % 4 === 0;
  const hair = inE(x, y, 17, 10, 11, 9) || inE(x, y, 9, 15, 6, 7) || inE(x, y, 25, 15, 6, 7);
  const rim = !hair && (inE(x, y, 17, 10, 12, 10) || inE(x, y, 9, 15, 7, 8) || inE(x, y, 25, 15, 7, 8));
  if (rim) on = true;
  if (hair) on = (x * 3 + y) % 11 === 0;
  const face = inE(x, y, 17, 22, 7.5, 9.5) && y > 14;
  if (face) {
    on = true;
    if (!blinking && ((y === 21 && [13, 14, 20, 21].includes(x)) || (y === 20 && (x === 15 || x === 19)))) on = false;
    if (blinking && y === 21 && ((x >= 13 && x <= 15) || (x >= 19 && x <= 21))) on = false;
    if (y === 18 && ((x >= 12 && x <= 14) || (x >= 20 && x <= 22))) on = false;
    if (y === 27 && x >= 16 && x <= 18) on = false;
  }
  const c = Math.abs(x - 17), edge = 4 + (y - 31) * 1.4;
  if (y >= 31) { if (c < 4) on = true; else if (c < edge - 1) on = false; else if (c < edge + 1) on = true; }
  return on;
}
const frame = (blink) => { const b = new Uint8Array(34 * 38); for (let y = 0; y < 38; y++) for (let x = 0; x < 34; x++) b[y * 34 + x] = geisha(x, y, blink) ? 1 : 0; return encodeBits(b, 34, 38); };
objects.push({ id: 'o' + (++n), type: 'billboard', name: 'Geisha billboard', pos: [BB.x + 0.05, (BB.y0 + BB.y1) / 2, (BB.z0 + BB.z1) / 2], yaw: 90,
  w: BB.z1 - BB.z0, h: BB.y1 - BB.y0, tex: { w: 34, h: 38, frames: [{ bits: frame(false), dur: 3.15 }, { bits: frame(true), dur: 0.15 }] },
  scanline: true, glitch: true, border: true });

// The spinner
const sp = structuredClone(LIBRARY.spinner);
objects.push({ id: 'spinner', type: 'model', name: 'Spinner', mesh: sp.mesh, scale: 1.5, autoOrient: true, bob: 0.25, headlights: true, thrusters: true, powerDown: true,
  lights: sp.lights,
  keys: [
    { t: 0, p: [0, 20, -10], ease: 'linear' }, { t: 4, p: [2, 22, 70], ease: 'linear' }, { t: 8, p: [-1, 24, 150], ease: 'linear' },
    { t: 12, p: [0, 38, 240], ease: 'linear' }, { t: 16, p: [3, 57, 318], ease: 'linear' }, { t: 19.5, p: [0, 50.3, 340], ease: 'linear' },
  ] });

// Pad lights and the mast beacon
objects.push({ id: 'o' + (++n), type: 'lights', name: 'Pad lights', shape: 'rect', a: [-11, 50.1, 329], b: [11, 50.1, 351], spacing: 2, mode: 'chase', rate: 8 });
objects.push({ id: 'o' + (++n), type: 'lights', name: 'Mast beacon', shape: 'line', a: [8.6, 62.6, 349], b: [9.4, 62.6, 349], spacing: 0.4, mode: 'blink', rate: 1.5 });

const follow = (t, lookSide = 0, lookUp = 0.6) => ({ t, mode: 'follow', target: 'spinner', back: 9, side: 3.5, up: 3, ahead: 4, lookSide, lookUp, ease: 'smooth' });
const scene = {
  version: 1, name: 'spinner-landing', duration: 25,
  settings: { focal: 36, near: 0.6, far: 130, fogDist: 110, winSpacingX: 3.5, winSpacingY: 4, rain: { count: 16, slant: 0.3, speed: 60 },
    fadeIn: 0.7, fadeOut: 2, lightDir: [-0.5, 1, -0.4] },
  objects,
  camera: { keys: [follow(0), follow(2.2), follow(3.4, 9, 3.6), follow(5.2, 9, 3.6), follow(6.4), follow(13),
    { t: 16.5, mode: 'fixed', eye: [13, 57, 325], look: [0, 50.5, 340], ease: 'smooth' }] },
};
fs.writeFileSync(path.join(root, 'scenes/spinner-landing.json'), JSON.stringify(scene, null, 1));
fs.writeFileSync(path.join(root, 'firmware/include/scene.h'), exportSceneH(scene));
console.log(`scene: ${objects.length} objects; exported scene.h`);
