// Runs a Game Boy emulator in the page, shrinks every frame to 72x40 1-bit,
// and streams it to the ESP32-C3 over Web Serial.
import getWasmBoyWasmCore from './node_modules/wasmboy/dist/core/getWasmBoyWasmCore.esm.js';
import FONT from './font4x6.js';

const GB_W = 160, GB_H = 144;
const OW = 72, OH = 40, OLED_BYTES = OW * OH / 8;
const FRAME_MS = 1000 / 59.7275;
const $ = (id) => document.getElementById(id);

// ---------- settings (remembered per browser) ----------
const SETTINGS_VERSION = 2;
const defaults = {
  v: SETTINGS_VERSION, mode: 'crop', zoom: 2, cx: 72, cy: 68, shades: 4, outline: 0.6,
  dither: 'atkinson', brightness: 0, contrast: 1, invert: false, scatter: true, pokeText: true,
};
const saved = load('gb-settings', {});
const settings = { ...defaults, ...(saved.v === SETTINGS_VERSION ? saved : {}) };
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function persist() { try { localStorage.setItem('gb-settings', JSON.stringify(settings)); } catch {} }

// ---------- emulator ----------
let ex = null;          // wasm exports
let romTitle = null, ramSize = 0, isPokemonGen1 = false;
let running = false, paused = false;

const RAM_SIZES = { 0: 0, 1: 2048, 2: 8192, 3: 32768, 4: 131072, 5: 65536 };

async function startRom(bytes, name) {
  if (!ex) ex = (await getWasmBoyWasmCore(true)).instance.exports;
  const mem = new Uint8Array(ex.memory.buffer);
  mem.fill(0, ex.CARTRIDGE_ROM_LOCATION.valueOf(), ex.CARTRIDGE_ROM_LOCATION.valueOf() + ex.CARTRIDGE_ROM_SIZE.valueOf());
  mem.set(bytes, ex.CARTRIDGE_ROM_LOCATION.valueOf());
  mem.fill(0, ex.CARTRIDGE_RAM_LOCATION.valueOf(), ex.CARTRIDGE_RAM_LOCATION.valueOf() + ex.CARTRIDGE_RAM_SIZE.valueOf());
  ex.config(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

  romTitle = String.fromCharCode(...bytes.slice(0x134, 0x144)).replace(/\0.*$/, '').trim() || name;
  ramSize = RAM_SIZES[bytes[0x149]] ?? 0;
  restoreBatterySave();

  isPokemonGen1 = /^POKEMON (RED|BLUE|YELLOW)/.test(romTitle);
  $('textRow').hidden = !isPokemonGen1;
  $('romName').textContent = romTitle;
  $('romDot').className = 'dot on';
  $('drop').classList.add('hidden');
  running = true;
  idbPut('lastRom', { name, bytes });
}

// ---------- battery saves (in-game saves) ----------
function ramView() {
  return new Uint8Array(ex.memory.buffer, ex.CARTRIDGE_RAM_LOCATION.valueOf(), ramSize);
}
function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }

let lastSaved = '';
function storeBatterySave() {
  if (!ex || !ramSize) return;
  const b64 = toB64(ramView());
  if (b64 === lastSaved) return;
  try { localStorage.setItem('gb-sav:' + romTitle, b64); lastSaved = b64; } catch (e) { console.warn('save failed', e); }
}
function restoreBatterySave() {
  lastSaved = '';
  if (!ramSize) return;
  const b64 = localStorage.getItem('gb-sav:' + romTitle);
  if (b64) { ramView().set(fromB64(b64).subarray(0, ramSize)); lastSaved = b64; }
}
setInterval(storeBatterySave, 3000);
addEventListener('beforeunload', storeBatterySave);

$('exportSav').onclick = () => {
  if (!ex || !ramSize) return alert('Load a game that has save memory first.');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ramView().slice()]));
  a.download = romTitle + '.sav';
  a.click();
};
$('importSav').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !ex || !ramSize) return;
  if (!confirm('Replace the current save and restart the game?')) return;
  const sav = new Uint8Array(await f.arrayBuffer());
  localStorage.setItem('gb-sav:' + romTitle, toB64(sav.subarray(0, ramSize)));
  const last = await idbGet('lastRom');
  if (last) startRom(last.bytes, last.name);
};

// ---------- remember the last ROM (IndexedDB, stays on this computer) ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('gb-stream', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbPut(k, v) { try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch {} }
async function idbGet(k) {
  try {
    const db = await idb();
    return await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
  } catch { return null; }
}

// ---------- input ----------
const keys = new Set();
const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyX: 'a', KeyZ: 'b', Enter: 'start', ShiftLeft: 'select', ShiftRight: 'select', Backspace: 'select', Space: 'turbo' };
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') { if (!KEYMAP[e.code]) return; e.target.blur(); }
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
  if (e.code === 'KeyV' && !e.repeat) cycleMode();
  if (e.code === 'KeyP' && !e.repeat) paused = !paused;
});
addEventListener('keyup', (e) => { if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]); });
addEventListener('blur', () => keys.clear());

function readButtons() {
  const s = { up: 0, down: 0, left: 0, right: 0, a: 0, b: 0, start: 0, select: 0, turbo: 0 };
  for (const k of keys) s[k] = 1;
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad) continue;
    const p = (i) => pad.buttons[i]?.pressed ? 1 : 0;
    const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
    s.a |= p(1); s.b |= p(0);                 // Nintendo layout: right = A, bottom = B
    s.select |= p(8); s.start |= p(9); s.turbo |= p(7);
    s.up |= p(12) | (ay < -0.5); s.down |= p(13) | (ay > 0.5);
    s.left |= p(14) | (ax < -0.5); s.right |= p(15) | (ax > 0.5);
  }
  return s;
}

// ---------- picture: 160x144 RGB -> 72x40 with 4 (or 2) brightness levels ----------
const luma = new Float32Array(GB_W * GB_H);
const gray = new Float32Array(OW * OH);   // 0..255, or -1 for "not picture"
const lvl = new Uint8Array(OW * OH);      // what the OLED shows: 0..3
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// Crop box (in Game Boy pixels) for a destination of OW x dh, kept inside maxH rows
function cropRect(dh = OH, maxH = GB_H) {
  const sw = Math.min(GB_W, OW * settings.zoom), sh = Math.min(maxH, dh * settings.zoom);
  const cx = Math.min(Math.max(settings.cx, sw / 2), GB_W - sw / 2);
  const cy = Math.min(Math.max(settings.cy, sh / 2), maxH - sh / 2);
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

// Which part of the Game Boy screen goes where on the OLED.
function layout(textMode) {
  if (textMode) return { ...cropRect(25, 96), dx: 0, dy: 0, dw: OW, dh: 25 };  // picture above the dialog box
  if (settings.mode === 'fit') {
    const dw = Math.round(GB_W * OH / GB_H);   // 44 x 40, centred
    return { sx: 0, sy: 0, sw: GB_W, sh: GB_H, dx: (OW - dw) >> 1, dy: 0, dw, dh: OH };
  }
  if (settings.mode === 'fill') return { sx: 0, sy: 0, sw: GB_W, sh: GB_H, dx: 0, dy: 0, dw: OW, dh: OH };
  return { ...cropRect(), dx: 0, dy: 0, dw: OW, dh: OH };
}

// Exact area-weighted shrink. "Outlines" pulls each pixel toward the darkest
// Game Boy pixel it covers, so 1-pixel black lines survive being shrunk.
function shrink(L) {
  const kx = L.sw / L.dw, ky = L.sh / L.dh, k = settings.outline;
  const gain = settings.contrast, bias = settings.brightness * 1.28;
  for (let y = 0; y < L.dh; y++) {
    const y0 = L.sy + y * ky, y1 = y0 + ky;
    for (let x = 0; x < L.dw; x++) {
      const x0 = L.sx + x * kx, x1 = x0 + kx;
      let sum = 0, area = 0, min = 255;
      for (let sy = Math.floor(y0); sy < y1 && sy < GB_H; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < x1 && sx < GB_W; sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          if (w <= 0) continue;
          const v = luma[sy * GB_W + sx];
          sum += v * w; area += w;
          if (w >= 0.25 && v < min) min = v;
        }
      }
      const mean = sum / area;
      let v = mean - k * Math.max(0, mean - min);
      v = (v - 128) * gain + 128 + bias;
      if (settings.invert) v = 255 - v;
      gray[(y + L.dy) * OW + x + L.dx] = Math.max(0, Math.min(255, v));
    }
  }
}

// Quantise gray -> N levels with the chosen dither, written into lvl as 0..3
function quantise() {
  const N = settings.shades, step = 255 / (N - 1), scale = 3 / (N - 1);
  const d = settings.dither;
  lvl.fill(0);
  if (d === 'threshold' || d === 'bayer') {
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
      const i = y * OW + x, v = gray[i];
      if (v < 0) continue;
      const q = d === 'bayer' ? Math.floor(v / step + (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16) : Math.round(v / step);
      lvl[i] = Math.min(N - 1, Math.max(0, q)) * scale;
    }
    return;
  }
  const g = Float32Array.from(gray);
  const spread = d === 'floyd'
    ? [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
    : [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]];
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    const i = y * OW + x;
    if (gray[i] < 0) continue;
    const q = Math.min(N - 1, Math.max(0, Math.round(g[i] / step)));
    lvl[i] = q * scale;
    const err = g[i] - q * step;
    for (const [ox, oy, w] of spread) {
      const nx = x + ox, ny = y + oy;
      if (nx >= 0 && nx < OW && ny < OH && gray[ny * OW + nx] >= 0) g[ny * OW + nx] += err * w;
    }
  }
}

// ---------- Pokémon Red/Blue/Yellow dialog text ----------
// The game keeps a 20x18 copy of the screen's tiles at $C3A0 (wTileMap).
// The dialog box is rows 12-17; its two text lines are rows 14 and 16.
const POKE_CHARS = (() => {
  const m = { 0x7F: ' ', 0xE8: '.', 0xF4: ',', 0xE6: '?', 0xE7: '!', 0xE3: '-', 0xE0: "'", 0x9A: '(', 0x9B: ')', 0x9C: ':',
    0x9D: ';', 0x9E: '[', 0x9F: ']', 0xBA: 'e', 0xBB: "'d", 0xBC: "'l", 0xBD: "'s", 0xBE: "'t", 0xBF: "'v", 0xE1: 'Pk',
    0xE2: 'Mn', 0xE4: "'r", 0xE5: "'m", 0xEC: '>', 0xED: '>', 0xEE: 'v', 0xEF: 'm', 0xF5: 'f', 0xF0: '$', 0xF1: 'x', 0xF3: '/' };
  for (let i = 0; i < 26; i++) { m[0x80 + i] = String.fromCharCode(65 + i); m[0xA0 + i] = String.fromCharCode(97 + i); }
  for (let i = 0; i < 10; i++) m[0xF6 + i] = String(i);
  return m;
})();

function readPokemonDialog() {
  const base = ex.getWasmBoyOffsetFromGameBoyOffset(0xC3A0);
  const m = new Uint8Array(ex.memory.buffer, base, 360);
  const t = (c, r) => m[r * 20 + c];
  if (!(t(0, 12) === 0x79 && t(19, 12) === 0x7B && t(0, 17) === 0x7D && t(19, 17) === 0x7E)) return null;
  const line = (r) => { let s = ''; for (let c = 1; c < 19; c++) s += POKE_CHARS[t(c, r)] ?? ' '; return s.trimEnd(); };
  return [line(14), line(16)];
}

// Draw text with the same 4x6 font the firmware has. bottom = row of the letters' feet.
function drawText(str, x, bottom, level) {
  for (const ch of str) {
    const G = FONT.glyphs[ch.charCodeAt(0)];
    if (!G) { x += 4; continue; }
    for (let r = 0; r < G.h; r++) for (let c = 0; c < G.w; c++) {
      if (!((G.rows[r] >> c) & 1)) continue;
      const px = x + G.x + c, py = bottom + 1 - (G.y + G.h) + r;
      if (px >= 0 && px < OW && py >= 0 && py < OH) lvl[py * OW + px] = level;
    }
    x += G.dx;
    if (x >= OW) break;
  }
}

let textOnScreen = false;
function buildOledFrame(rgb) {
  for (let i = 0, p = 0; i < luma.length; i++, p += 3) luma[i] = 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];

  const dialog = isPokemonGen1 && settings.pokeText ? readPokemonDialog() : null;
  textOnScreen = !!dialog;
  gray.fill(-1);
  shrink(layout(textOnScreen));
  quantise();
  if (dialog) {
    for (let x = 0; x < OW; x += 2) lvl[25 * OW + x] = 1;   // faint dotted divider
    drawText(dialog[0], 0, 31, 3);
    drawText(dialog[1], 0, 38, 3);
  }
  return packFrame();
}

// SSD1306 page format: 5 pages x 72 columns, LSB = top pixel
function packPlane(out, offset, test) {
  for (let page = 0; page < OH / 8; page++) for (let x = 0; x < OW; x++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) if (test(lvl[(page * 8 + bit) * OW + x])) b |= 1 << bit;
    out[offset + page * OW + x] = b;
  }
}
function packFrame() {
  if (settings.shades === 2) {
    const p = new Uint8Array(2 + OLED_BYTES);
    p[0] = 0xA5; p[1] = 0x5A;
    packPlane(p, 2, (v) => v > 0);
    return p;
  }
  const p = new Uint8Array(3 + OLED_BYTES * 2);
  p[0] = 0xA5; p[1] = 0x5B; p[2] = settings.scatter ? 1 : 0;
  packPlane(p, 3, (v) => v & 1);
  packPlane(p, 3 + OLED_BYTES, (v) => v & 2);
  return p;
}

// ---------- drawing on the page ----------
const gameCtx = $('game').getContext('2d');
const gbCanvas = new OffscreenCanvas(GB_W, GB_H), gbCtx = gbCanvas.getContext('2d');
const gbImage = gbCtx.createImageData(GB_W, GB_H);
const oledCtx = $('oled').getContext('2d');
const oledImage = oledCtx.createImageData(OW, OH);

function drawGame(rgb) {
  const d = gbImage.data;
  for (let i = 0, p = 0; i < GB_W * GB_H; i++, p += 3) { d[i * 4] = rgb[p]; d[i * 4 + 1] = rgb[p + 1]; d[i * 4 + 2] = rgb[p + 2]; d[i * 4 + 3] = 255; }
  gbCtx.putImageData(gbImage, 0, 0);
  const c = $('game'), s = c.width / GB_W;
  gameCtx.imageSmoothingEnabled = false;
  gameCtx.drawImage(gbCanvas, 0, 0, c.width, c.height);
  // Outline what the OLED is showing: the crop box, plus the dialog box when it's shown as text
  const boxes = [];
  if (textOnScreen) boxes.push(cropRect(25, 96), { sx: 0, sy: 96, sw: GB_W, sh: 48 });
  else if (settings.mode === 'crop') boxes.push(cropRect());
  if (!boxes.length) return;
  gameCtx.fillStyle = 'rgba(0,0,0,0.45)';
  gameCtx.beginPath();
  gameCtx.rect(0, 0, c.width, c.height);
  for (const r of boxes) gameCtx.rect(r.sx * s, r.sy * s, r.sw * s, r.sh * s);
  gameCtx.fill('evenodd');
  gameCtx.strokeStyle = '#8bd450'; gameCtx.lineWidth = 2;
  for (const r of boxes) gameCtx.strokeRect(r.sx * s, r.sy * s, r.sw * s, r.sh * s);
}

// Approximate how bright each level looks on the OLED
const LEVEL_RGB = [0, 1, 2, 3].map((l) => [0x9f, 0xe3, 0xff].map((c) => Math.round(c * l / 3)));
function drawOled() {
  const d = oledImage.data;
  for (let i = 0; i < lvl.length; i++) {
    const [r, g, b] = LEVEL_RGB[lvl[i]];
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  oledCtx.putImageData(oledImage, 0, 0);
}

// Drag on the game to move the crop box
function moveCrop(e) {
  const r = $('game').getBoundingClientRect();
  settings.cx = (e.clientX - r.left) / r.width * GB_W;
  settings.cy = (e.clientY - r.top) / r.height * GB_H;
  const c = cropRect();            // store the clamped centre
  settings.cx = c.sx + c.sw / 2; settings.cy = c.sy + c.sh / 2;
  persist();
}
$('game').addEventListener('pointerdown', (e) => {
  if (settings.mode !== 'crop') return;
  $('game').setPointerCapture(e.pointerId); moveCrop(e);
});
$('game').addEventListener('pointermove', (e) => { if (e.buttons && settings.mode === 'crop') moveCrop(e); });

// ---------- Web Serial ----------
let port = null, writer = null, reader = null, sending = false, sentCount = 0;
let wanted = null;   // the port the user picked, so we can re-open it if the board re-appears
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  if (!('serial' in navigator)) return;
  try {
    wanted = await navigator.serial.requestPort();
    await openPort(wanted, true);
  } catch (e) {
    console.warn(e);
    if (e.name !== 'NotFoundError') setSerialStatus(false, 'Could not open the board: ' + e.message);
  }
}

async function openPort(p, reset) {
  port = p;
  await port.open({ baudRate: 115200 });
  if (reset) {
    // Opening the port wiggles DTR/RTS, which can drop the ESP32-C3 into its
    // USB bootloader (screen freezes, frames ignored). Pulse RTS with DTR low:
    // that's a plain reset into our firmware, the same thing esptool does.
    setSerialStatus(false, 'Restarting board…');
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(150);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(1200);
    if (!port?.writable) return;   // board re-enumerated; the 'connect' handler takes over
  }
  writer = port.writable.getWriter();
  setSerialStatus(true);
  readStats();
}

// If the board drops off USB (reset or replug) and comes back, pick it up again
navigator.serial?.addEventListener('connect', async (e) => {
  if (!wanted || port) return;
  const again = (await navigator.serial.getPorts()).find((p) => p === e.target) ?? e.target;
  try { await sleep(300); await openPort(again, false); wanted = again; } catch (err) { console.warn(err); port = null; }
});

async function disconnect() {
  wanted = null;
  try { await reader?.cancel(); } catch {}
  try { writer?.releaseLock(); await port?.close(); } catch {}
  port = writer = reader = null; setSerialStatus(false);
  $('oledHz').textContent = 'oled –';
}

// The board prints "STATS <sub-frames/s> <frames received/s>" once a second
async function readStats() {
  const decoder = new TextDecoder();
  let text = '';
  try {
    reader = port.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = text.indexOf('\n')) >= 0) {
        const m = /^STATS (\d+) (\d+)/.exec(text.slice(0, nl));
        text = text.slice(nl + 1);
        if (m) $('oledHz').textContent = settings.shades === 4 ? `oled ${Math.round(m[1] / 3)} Hz grey cycle` : `oled ${m[2]} fps`;
      }
    }
  } catch (e) { console.warn(e); }
  finally { try { reader?.releaseLock(); } catch {} }
}
function setSerialStatus(on, msg) {
  $('serialDot').className = 'dot' + (on ? ' on' : msg ? ' warn' : '');
  $('serialText').textContent = on ? 'Board connected' : msg || 'Board not connected';
  $('connectBtn').textContent = on ? 'Disconnect' : 'Connect board';
}
function send(packet) {
  if (!writer || sending) return;     // drop frames rather than queue them up
  sending = true;
  writer.write(packet).then(() => { sentCount++; }, (e) => { console.warn(e); disconnect(); setSerialStatus(false, 'Board disconnected'); })
    .finally(() => { sending = false; });
}
$('connectBtn').onclick = () => (port ? disconnect() : connect());
navigator.serial?.addEventListener('disconnect', (e) => { if (e.target === port) { port = writer = null; setSerialStatus(false, wanted ? 'Waiting for board…' : 'Board unplugged'); } });
if (!('serial' in navigator)) { $('unsupported').style.display = 'block'; $('connectBtn').disabled = true; }

// ---------- main loop ----------
let acc = 0, last = performance.now(), emuFrames = 0;
function tick() {
  const now = performance.now();
  const dt = Math.min(100, now - last); last = now;
  if (!running || paused) return;

  const b = readButtons();
  ex.setJoypadState(b.up, b.right, b.down, b.left, b.a, b.b, b.select, b.start);

  acc += dt * (b.turbo ? 4 : 1);
  let ran = 0;
  while (acc >= FRAME_MS && ran < 8) { ex.executeFrame(); acc -= FRAME_MS; ran++; }
  if (!ran) return;
  emuFrames += ran;

  const f = ex.FRAME_LOCATION.valueOf();
  const rgb = new Uint8Array(ex.memory.buffer, f, GB_W * GB_H * 3);
  drawGame(rgb);
  const packet = buildOledFrame(rgb);
  drawOled();
  send(packet);
}

// Clock the game from a worker, not requestAnimationFrame: the browser stops
// animation frames (and slows page timers to 1/s) when the window is covered,
// which would freeze the OLED whenever you look at something else. Messages
// from a worker keep arriving at full speed.
const clock = new Worker(URL.createObjectURL(new Blob(
  ['let t = performance.now(); (function loop() { postMessage(0); t += 1000 / 120; setTimeout(loop, Math.max(0, t - performance.now())); })();'],
  { type: 'text/javascript' })));
clock.onmessage = tick;

setInterval(() => {
  $('emuFps').textContent = `emu ${emuFrames} fps${paused ? ' (paused)' : ''}`;
  $('sendFps').textContent = `sent ${sentCount} fps`;
  emuFrames = 0; sentCount = 0;
}, 1000);

// ---------- ROM loading ----------
async function openFile(file) {
  if (!file) return;
  if (!/\.(gb|gbc)$/i.test(file.name)) return alert('That doesn’t look like a .gb file.');
  storeBatterySave();
  startRom(new Uint8Array(await file.arrayBuffer()), file.name);
}
$('romInput').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('dragging'); openFile(e.dataTransfer.files[0]); });

// ---------- settings UI ----------
function cycleMode() { const m = ['crop', 'fit', 'fill']; settings.mode = m[(m.indexOf(settings.mode) + 1) % 3]; syncUI(); persist(); }
function syncUI() {
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.v === settings.mode);
  $('zoomRow').style.opacity = settings.mode === 'crop' ? 1 : 0.35;
  for (const b of $('zoomSeg').children) b.classList.toggle('on', Number(b.dataset.v) === settings.zoom);
  for (const b of $('shadesSeg').children) b.classList.toggle('on', Number(b.dataset.v) === settings.shades);
  $('scatterRow').style.opacity = settings.shades === 4 ? 1 : 0.35;
  $('outline').value = settings.outline; $('outlineOut').textContent = Math.round(settings.outline * 100) + '%';
  $('brightness').value = settings.brightness; $('brightnessOut').textContent = settings.brightness;
  $('contrast').value = settings.contrast; $('contrastOut').textContent = settings.contrast.toFixed(2);
  $('dither').value = settings.dither; $('invert').checked = settings.invert;
  $('scatter').checked = settings.scatter; $('pokeText').checked = settings.pokeText;
}
const segPicker = (id, key, parse) => ($(id).onclick = (e) => {
  if (e.target.dataset.v) { settings[key] = parse(e.target.dataset.v); syncUI(); persist(); }
});
segPicker('modeSeg', 'mode', String);
segPicker('zoomSeg', 'zoom', Number);
segPicker('shadesSeg', 'shades', Number);
for (const id of ['outline', 'brightness', 'contrast']) $(id).oninput = (e) => { settings[id] = Number(e.target.value); syncUI(); persist(); };
$('dither').onchange = (e) => { settings.dither = e.target.value; persist(); };
for (const id of ['invert', 'scatter', 'pokeText']) $(id).onchange = (e) => { settings[id] = e.target.checked; persist(); };
syncUI();

// Pick up where you left off
idbGet('lastRom').then((r) => { if (r && !running) startRom(r.bytes, r.name); });
