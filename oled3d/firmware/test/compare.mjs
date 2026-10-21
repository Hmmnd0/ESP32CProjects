// Checks that the editor preview (editor/engine.js) and the board firmware (src/main.cpp)
// draw the same pixels. Builds the firmware engine for this computer against each scene,
// renders every 0.1 s of the loop with both, and compares the frames.
//
//   node firmware/test/compare.mjs [scene.json ...]      (default: every scene in scenes/)
//
// Needs a C++ compiler on the PATH as `c++` (macOS: Xcode command line tools,
// Linux: build-essential, Windows: MinGW-w64 or MSYS2) and Node 18+.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const STEP = 0.1;
const { compile, Renderer, W, H } = await import(pathToFileURL(path.join(root, 'editor', 'engine.js')));
const { exportSceneH } = await import(pathToFileURL(path.join(root, 'editor', 'exporter.js')));

const scenes = process.argv.slice(2);
if (!scenes.length) for (const f of fs.readdirSync(path.join(root, 'scenes'))) if (f.endsWith('.json')) scenes.push(path.join(root, 'scenes', f));

// Frames as 360-byte SSD1306 pages, like the firmware's buffer
function previewFrames(scene) {
  const c = compile(scene), r = new Renderer(), out = [];
  const st = Math.fround(STEP), dur = Math.fround(c.duration);
  for (let i = 0; Math.fround(i * st) < dur; i++) {   // float times, exactly like host_main.cpp
    const b = r.render(c, Math.fround(i * st)), p = Buffer.alloc(360);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (b[y * W + x]) p[(y >> 3) * 72 + x] |= 1 << (y & 7);
    out.push(p);
  }
  return Buffer.concat(out);
}

function boardFrames(scene, dir) {
  fs.writeFileSync(path.join(dir, 'scene.h'), exportSceneH(scene));
  const exe = path.join(dir, process.platform === 'win32' ? 'host.exe' : 'host');
  // -ffp-contract=off: no fused multiply-add, so float maths rounds like the ESP32's
  const cc = spawnSync('c++', ['-std=c++17', '-O2', '-w', '-ffp-contract=off', `-I${path.join(here, 'host')}`, `-I${dir}`,
    `-I${path.join(here, '..', 'include')}`, '-o', exe, path.join(here, 'host', 'host_main.cpp')], { encoding: 'utf8' });
  if (cc.status !== 0) throw new Error(`could not build the firmware engine:\n${cc.stderr || cc.error}`);
  const run = spawnSync(exe, [String(STEP)], { maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error('the firmware engine crashed');
  return run.stdout;
}

const bits = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) { let v = a[i] ^ b[i]; while (v) { n += v & 1; v >>= 1; } } return n; };
let worstAvg = 0;
for (const file of scenes) {
  const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oled3d-compare-'));
  try {
    const js = previewFrames(scene), fw = boardFrames(scene, dir);
    const n = Math.min(js.length, fw.length) / 360;
    let same = 0, sum = 0, worst = 0, worstAt = 0;
    for (let i = 0; i < n; i++) {
      const d = bits(js.subarray(i * 360, i * 360 + 360), fw.subarray(i * 360, i * 360 + 360));
      if (!d) same++;
      sum += d;
      if (d > worst) { worst = d; worstAt = i * STEP; }
    }
    if (js.length !== fw.length) console.log(`  note: preview made ${js.length / 360} frames, board ${fw.length / 360}`);
    console.log(`${path.basename(file, '.json')}: ${n} frames, ${same} identical (${(100 * same / n).toFixed(0)}%), ` +
      `avg ${(sum / n).toFixed(1)} px different of ${W * H}, worst ${worst} px at t=${worstAt.toFixed(1)} s`);
    worstAvg = Math.max(worstAvg, sum / n);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// More than a pixel a frame on average means the two engines have drifted apart
process.exit(worstAvg > 1 ? 1 : 0);
