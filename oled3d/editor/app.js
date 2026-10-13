// OLED3D editor: state, undo, outliner, properties, preview, timeline wiring,
// dialogs, saving/exporting/flashing and the live link to the board.
import { compile, Renderer, W, H, estimateMs, packFrame, interpKeys, modelPose, cameraAt, encodeBits, decodeBits, EASES } from './engine.js';
import { exportSceneH } from './exporter.js';
import { LIBRARY } from './library.js';
import { createView3D } from './view3d.js';
import { createTimeline } from './timeline.js';
import { ditherGray, imageToGray, loadImage, textToBits, parseOBJ, generateStreet } from './tools.js';

const $ = (id) => document.getElementById(id);
const round2 = (v) => Math.round(v * 100) / 100;

// ---------- state ----------
let scene = null, compiled = null;
let selection = { kind: 'scene' };
let time = 0, playing = false;
let undoStack = [], redoStack = [], pending = null;
let dirty = false;
let idCounter = 1;

const newId = () => { let id; do { id = 'o' + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 5); } while (scene?.objects.some((o) => o.id === id)); return id; };

function emptyScene(name = 'untitled') {
  return {
    version: 1, name, duration: 12,
    settings: { focal: 36, near: 0.6, far: 130, fogDist: 110, winSpacingX: 3.5, winSpacingY: 4, rain: { count: 12, slant: 0.3, speed: 60 }, fadeIn: 0.5, fadeOut: 1, lightDir: [-0.5, 1, -0.4] },
    objects: [], camera: { keys: [{ t: 0, mode: 'fixed', eye: [0, 12, -30], look: [0, 10, 0], ease: 'smooth' }] },
  };
}

function setScene(s, keepHistory = false) {
  scene = s;
  if (!keepHistory) { undoStack = []; redoStack = []; }
  selection = { kind: 'scene' };
  time = Math.min(time, scene.duration);
  recompile();
  view.rebuild();
  refreshAll();
  scheduleCost();
}
function recompile() { compiled = compile(scene); }

// Edits: beginEdit() snapshots once; liveEdit() mutates + refreshes; commitEdit() records undo.
function beginEdit() { if (!pending) pending = JSON.stringify(scene); }
function liveEdit(fn, source) {
  beginEdit();
  fn(scene);
  recompile();
  if (source !== 'view') view.rebuild(); else view.rebuildOverlay();
  refreshPanels();
}
function commitEdit() {
  if (!pending) return;
  if (pending !== JSON.stringify(scene)) { undoStack.push(pending); if (undoStack.length > 80) undoStack.shift(); redoStack = []; markDirty(); }
  pending = null;
  view.rebuild();
  refreshAll();
  scheduleCost();
}
function edit(fn) { beginEdit(); fn(scene); recompile(); commitEdit(); }
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(scene));
  scene = JSON.parse(undoStack.pop());
  afterHistory();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(scene));
  scene = JSON.parse(redoStack.pop());
  afterHistory();
}
function afterHistory() {
  if (selection.kind === 'object' && !scene.objects.some((o) => o.id === selection.id)) selection = { kind: 'scene' };
  recompile(); view.rebuild(); refreshAll(); markDirty(); scheduleCost();
}
function markDirty() {
  dirty = true;
  try { localStorage.setItem('oled3d-draft', JSON.stringify(scene)); } catch {}
  $('saveBtn').textContent = 'Save •';
}

function select(sel) {
  selection = sel;
  view.rebuild();
  refreshAll();
}
const selectedObject = () => selection.kind === 'object' ? scene.objects.find((o) => o.id === selection.id) : null;

function setTime(t) { time = Math.max(0, Math.min(scene.duration, t)); timeline.draw(); }

// Key helpers
function keyAtTime(o) {
  let i = o.keys.findIndex((k) => Math.abs(k.t - time) < 0.03);
  if (i >= 0) return i;
  const m = compiled.models[compiled.modelIndex[o.id]];
  const p = m ? interpKeys(m.keys, time, (k) => k.p) : [0, 10, 0];
  const r = o.keys.length ? interpKeys([...o.keys].sort((a, b) => a.t - b.t), time, (k) => k.r || [0, 0, 0]) : [0, 0, 0];
  const k = { t: round2(time), p: p.map(round2), r: r.map(round2), ease: 'smooth' };
  o.keys.push(k);
  o.keys.sort((a, b) => a.t - b.t);
  i = o.keys.indexOf(k);
  selection = { kind: 'object', id: o.id, key: i };
  return i;
}

function addKey(rowId, t) {
  setTime(t);
  if (rowId === 'camera') {
    edit((s) => {
      const keys = s.camera.keys;
      const prev = [...keys].reverse().find((k) => k.t <= t) || keys[0];
      let k;
      if (prev && prev.mode === 'follow') k = { ...structuredClone(prev), t };
      else {
        const cam = cameraAt(compiled, t, compiled.models.map((m) => modelPose(m, t)));
        k = { t, mode: 'fixed', eye: cam.eye.map(round2), look: cam.look.map(round2), ease: 'smooth' };
      }
      keys.push(k);
      keys.sort((a, b) => a.t - b.t);
      selection = { kind: 'camera', key: keys.indexOf(k) };
    });
  } else {
    edit((s) => { const o = s.objects.find((x) => x.id === rowId); if (o) keyAtTime(o); });
  }
}

// ---------- views ----------
const api = {
  getScene: () => scene, getCompiled: () => compiled, getSelection: () => selection, getTime: () => time,
  select, setTime, beginEdit, liveEdit, commitEdit, keyAtTime, addKey, getCostGraph: () => costGraph,
  // Block tool: a new box from a dragged rectangle
  addBox: (b) => addObject({ type: 'box', name: 'Block', ...b, windows: 0.4, winStyle: 'grid', edges: true, bright: false, seed: Math.floor(Math.random() * 256) }),
  onViewState: () => updateViewButtons(),
  toast: (m) => toast(m),
  // Model path tool: a key for the model at the playhead, then step the playhead on
  addModelKey: (id, p, yaw) => {
    const t = round2(time);
    edit((s) => {
      const o = s.objects.find((x) => x.id === id);
      if (!o) return;
      let k = o.keys.find((x) => Math.abs(x.t - t) < 0.03);
      if (!k) { k = { t, p, r: [0, 0, 0], ease: 'smooth' }; o.keys.push(k); o.keys.sort((a, b) => a.t - b.t); }
      k.p = p;
      if (yaw != null) k.r = [yaw, k.r?.[1] || 0, k.r?.[2] || 0];
      selection = { kind: 'object', id, key: o.keys.indexOf(k) };
    });
    const step = parseFloat($('camStep').value) || 2;
    toast(`Key at ${t.toFixed(2)} s`);
    setTime(Math.min(scene.duration, t + step));
  },
  // Camera path tool: a fixed key at the playhead, then step the playhead on
  addCameraKey: (eye, look) => {
    const t = round2(time);
    edit((s) => {
      const keys = s.camera.keys;
      let k = keys.find((x) => Math.abs(x.t - t) < 0.03);
      if (k) Object.assign(k, { mode: 'fixed', eye, look });
      else { k = { t, mode: 'fixed', eye, look, ease: 'smooth' }; keys.push(k); keys.sort((a, b) => a.t - b.t); }
      selection = { kind: 'camera', key: keys.indexOf(k) };
    });
    const step = parseFloat($('camStep').value) || 2;
    toast(`Camera key at ${t.toFixed(2)} s`);
    setTime(Math.min(scene.duration, t + step));
  },
};
const view = createView3D($('view'), api);
const timeline = createTimeline($('timeline'), api);
window.oled3d = { api, view, preview: () => preview };   // for debugging from the console

// ---------- preview + performance ----------
const preview = new Renderer();
const oledCtx = $('oled').getContext('2d');
const oledImg = oledCtx.createImageData(W, H);
let lastFrameAt = performance.now(), liveSentAt = 0;
let boardFps = null;

function drawPreview() {
  const buf = preview.render(compiled, time);
  const d = oledImg.data;
  for (let i = 0; i < W * H; i++) { const on = buf[i]; d[i * 4] = on ? 0x9f : 0; d[i * 4 + 1] = on ? 0xe3 : 0; d[i * 4 + 2] = on ? 0xff : 0; d[i * 4 + 3] = 255; }
  oledCtx.putImageData(oledImg, 0, 0);
  const ms = estimateMs(preview.stats), fps = Math.min(60, 1000 / ms);
  $('perfNow').textContent = `now ≈ ${fps.toFixed(0)} fps on board (${ms.toFixed(0)} ms)`;
  $('perfFill').style.width = Math.min(100, fps / 40 * 100) + '%';
  $('perfFill').style.background = fps < 12 ? 'var(--red)' : fps < 20 ? 'var(--amber)' : 'var(--accent)';
  const s = preview.stats;
  $('perfStats').textContent = `${s.faces} faces · ${s.windows} windows · ${s.modelFaces} model faces`;
  if (live && writer && performance.now() - liveSentAt > 33) { liveSentAt = performance.now(); sendFrame(packFrame(buf)); }
}

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;
  if (playing) { time += dt; if (time >= scene.duration) time = 0; }
  view.frame(time);
  drawPreview();
  $('timeText').textContent = `${time.toFixed(2)} / ${scene.duration.toFixed(2)} s`;
  if (playing) timeline.draw();
}

// Cost graph: estimated board fps along the whole loop (computed in the background)
let costGraph = [], costTimer = null, costJob = 0;
function scheduleCost() {
  clearTimeout(costTimer);
  costTimer = setTimeout(async () => {
    const job = ++costJob, r = new Renderer(), c = compiled, out = [], step = Math.max(0.1, scene.duration / 160);
    for (let t = 0; t < scene.duration; t += step) {
      r.render(c, t);
      out.push({ t, fps: Math.min(60, 1000 / estimateMs(r.stats)) });
      if (out.length % 20 === 0) { await new Promise((res) => setTimeout(res)); if (job !== costJob) return; }
    }
    costGraph = out;
    const worst = out.reduce((a, b) => (b.fps < a.fps ? b : a), out[0] || { fps: 60, t: 0 });
    $('perfWorst').textContent = `slowest ≈ ${worst.fps.toFixed(0)} fps at ${worst.t.toFixed(1)} s`;
    $('perfWorst').style.color = worst.fps < 12 ? 'var(--red)' : worst.fps < 20 ? 'var(--amber)' : '';
    timeline.draw();
  }, 350);
}

// ---------- outliner ----------
const collapsed = new Set(JSON.parse(localStorage.getItem('oled3d-collapsed') || '[]'));
const ICON = { box: '▭', billboard: '▣', model: '◆', lights: '✦' };

function renderOutliner() {
  const ul = $('outliner');
  ul.innerHTML = '';
  const li = (cls, icon, name, onClick, acts = []) => {
    const el = document.createElement('li');
    el.className = cls;
    el.innerHTML = `<span class="icon">${icon}</span><span class="name"></span>`;
    el.querySelector('.name').textContent = name;
    for (const [label, title, fn] of acts) {
      const a = document.createElement('span'); a.className = 'act'; a.textContent = label; a.title = title;
      a.onclick = (e) => { e.stopPropagation(); fn(); };
      el.appendChild(a);
    }
    el.onclick = onClick;
    return el;
  };
  ul.appendChild(li(selection.kind === 'scene' ? 'sel' : '', '⚙', 'Scene settings', () => select({ kind: 'scene' })));
  ul.appendChild(li(selection.kind === 'camera' ? 'sel' : '', '🎥', `Camera (${scene.camera.keys.length} keys)`, () => select({ kind: 'camera', key: null })));
  // group objects by their group name
  const groups = new Map();
  for (const o of scene.objects) { const g = o.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(o); }
  const objRow = (o) => li(`${selection.kind === 'object' && selection.id === o.id ? 'sel' : ''} ${o.hidden ? 'hidden' : ''}`, ICON[o.type], o.name,
    () => select({ kind: 'object', id: o.id, key: null }),
    [[o.hidden ? '◌' : '◉', 'Show / hide', () => edit(() => { o.hidden = !o.hidden; })], ['✕', 'Delete', () => deleteObjects([o.id])]]);
  for (const [g, list] of groups) {
    if (!g) { list.forEach((o) => ul.appendChild(objRow(o))); continue; }
    const open = !collapsed.has(g);
    ul.appendChild(li('group', open ? '▾' : '▸', `${g} (${list.length})`, () => {
      open ? collapsed.add(g) : collapsed.delete(g);
      localStorage.setItem('oled3d-collapsed', JSON.stringify([...collapsed]));
      renderOutliner();
    }, [[list.every((o) => o.hidden) ? '◌' : '◉', 'Show / hide group', () => edit(() => { const h = !list.every((o) => o.hidden); list.forEach((o) => { o.hidden = h; }); })],
      ['✕', 'Delete group', () => { if (confirm(`Delete all ${list.length} objects in "${g}"?`)) deleteObjects(list.map((o) => o.id)); }]]));
    if (open) { const kids = document.createElement('div'); kids.className = 'kids'; list.forEach((o) => kids.appendChild(objRow(o))); ul.appendChild(kids); }
  }
  $('objCount').textContent = scene.objects.length;
}

function deleteObjects(ids) {
  edit((s) => {
    s.objects = s.objects.filter((o) => !ids.includes(o.id));
    s.camera.keys = s.camera.keys.filter((k) => k.mode !== 'follow' || !ids.includes(k.target));
  });
  if (selection.kind === 'object' && ids.includes(selection.id)) select({ kind: 'scene' });
}

// ---------- properties ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e[k] = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
const field = (label, input) => el('div', { class: 'field' }, el('span', {}, label), input);
function num(get, set, { step = 0.1, min, max } = {}) {
  const i = el('input', { type: 'number', step, min, max });
  i.value = round2(get());
  i.onchange = () => { const v = parseFloat(i.value); if (Number.isFinite(v)) edit(() => set(v)); };
  return i;
}
function txt(get, set) { const i = el('input', { type: 'text' }); i.value = get() ?? ''; i.onchange = () => edit(() => set(i.value)); return i; }
function chk(get, set) { const i = el('input', { type: 'checkbox' }); i.checked = !!get(); i.onchange = () => edit(() => set(i.checked)); return i; }
function sel(options, get, set) {
  const s = el('select');
  for (const [v, label] of options) s.append(el('option', { value: v }, label));
  s.value = get();
  s.onchange = () => edit(() => set(s.value));
  return s;
}
function vec(get, set, step = 0.5) {
  const wrap = el('div', { class: 'vec' });
  ['x', 'y', 'z'].forEach((_, i) => wrap.append(num(() => get()[i], (v) => { const a = [...get()]; a[i] = v; set(a); }, { step })));
  return wrap;
}
const easeSel = (get, set) => sel([['linear', 'Linear'], ['smooth', 'Smooth'], ['in', 'Ease in'], ['out', 'Ease out'], ['cut', 'Cut (hold, then jump)']], get, set);
const btn = (label, onclick, cls) => el('button', { onclick, class: cls }, label);

function renderProps() {
  const p = $('props');
  p.innerHTML = '';
  if (selection.kind === 'scene') return renderSceneProps(p);
  if (selection.kind === 'camera') return renderCameraProps(p);
  const o = selectedObject();
  if (!o) return renderSceneProps(p);
  p.append(el('h2', {}, { box: 'Building', billboard: 'Billboard', model: 'Model', lights: 'Light strip' }[o.type]));
  p.append(field('Name', txt(() => o.name, (v) => { o.name = v; })));
  p.append(field('Group', txt(() => o.group, (v) => { o.group = v || undefined; })));
  if (o.type === 'box') {
    p.append(field('X from / to', el('div', { class: 'vec', style: 'grid-template-columns:1fr 1fr' }, num(() => o.x0, (v) => { o.x0 = v; }), num(() => o.x1, (v) => { o.x1 = v; }))));
    p.append(field('Y from / to', el('div', { class: 'vec', style: 'grid-template-columns:1fr 1fr' }, num(() => o.y0, (v) => { o.y0 = v; }), num(() => o.y1, (v) => { o.y1 = v; }))));
    p.append(field('Z from / to', el('div', { class: 'vec', style: 'grid-template-columns:1fr 1fr' }, num(() => o.z0, (v) => { o.z0 = v; }), num(() => o.z1, (v) => { o.z1 = v; }))));
    p.append(field('Windows', sel([['grid', 'Grid'], ['bands', 'Bands'], ['none', 'None']], () => o.winStyle, (v) => { o.winStyle = v; })));
    p.append(field('Lit windows', num(() => o.windows, (v) => { o.windows = Math.max(0, Math.min(1, v)); }, { step: 0.05, min: 0, max: 1 })));
    p.append(field('Lit edges', chk(() => o.edges, (v) => { o.edges = v; })));
    p.append(field('Ignore fog', chk(() => o.bright, (v) => { o.bright = v; })));
    p.append(field('Window seed', num(() => o.seed, (v) => { o.seed = Math.round(v) & 255; }, { step: 1 })));
  } else if (o.type === 'billboard') {
    p.append(field('Position', vec(() => o.pos, (v) => { o.pos = v; })));
    p.append(field('Facing (°)', num(() => o.yaw, (v) => { o.yaw = v; }, { step: 15 })));
    p.append(field('Size w / h', el('div', { class: 'vec', style: 'grid-template-columns:1fr 1fr' }, num(() => o.w, (v) => { o.w = v; }), num(() => o.h, (v) => { o.h = v; }))));
    p.append(field('Scanline', chk(() => o.scanline, (v) => { o.scanline = v; })));
    p.append(field('Glitches', chk(() => o.glitch, (v) => { o.glitch = v; })));
    p.append(field('Frame', chk(() => o.border, (v) => { o.border = v; })));
    const frames = el('div', { class: 'sub' }, el('h3', {}, `Frames (${o.tex.w}×${o.tex.h} px)`, el('span')));
    o.tex.frames.forEach((f, i) => {
      const c = el('canvas', { width: o.tex.w, height: o.tex.h, style: 'width:60px;image-rendering:pixelated;background:#000;vertical-align:middle;border:1px solid #2b3038' });
      const bits = decodeBits(f.bits, o.tex.w, o.tex.h), x = c.getContext('2d'), im = x.createImageData(o.tex.w, o.tex.h);
      bits.forEach((b, k) => im.data.set(b ? [159, 227, 255, 255] : [0, 0, 0, 255], k * 4));
      x.putImageData(im, 0, 0);
      frames.append(el('div', { class: 'row', style: 'align-items:center' }, c, el('span', { class: 'hint' }, 'for'),
        el('div', { style: 'width:70px' }, num(() => f.dur, (v) => { f.dur = Math.max(0.02, v); }, { step: 0.05 })), el('span', { class: 'hint' }, 's'),
        o.tex.frames.length > 1 ? btn('✕', () => edit(() => o.tex.frames.splice(i, 1))) : null));
    });
    frames.append(el('div', { class: 'row' }, btn('Add frame from image…', () => openImageDialog(o)), btn('Replace with image…', () => openImageDialog(o, true))));
    if (o.tex.frames.length >= 4) frames.append(el('div', { class: 'hint' }, 'Up to 4 frames are exported.'));
    p.append(frames);
  } else if (o.type === 'model') {
    p.append(field('Scale', num(() => o.scale, (v) => { o.scale = v; }, { step: 0.1 })));
    p.append(field('Face travel', chk(() => o.autoOrient, (v) => { o.autoOrient = v; })));
    p.append(field('Bob', num(() => o.bob, (v) => { o.bob = v; }, { step: 0.05 })));
    p.append(field('Headlights', chk(() => o.headlights, (v) => { o.headlights = v; })));
    p.append(field('Thrusters', chk(() => o.thrusters, (v) => { o.thrusters = v; })));
    p.append(field('Power down at end', chk(() => o.powerDown, (v) => { o.powerDown = v; })));
    p.append(el('div', { class: 'hint' }, `${o.mesh.verts.length} vertices, ${o.mesh.faces.length} faces.` + (o.mesh.faces.length > 30 ? ' Lots of faces are slow on the board.' : '')));
    if (o.mesh.faces.length > 30) p.lastChild.className = 'warn';
    // Lights
    const lights = el('div', { class: 'sub' }, el('h3', {}, 'Lights', btn('+ Add', () => edit(() => o.lights.push({ p: [0, 1, 0], mode: 'blink', rate: 2, phase: 0 })))));
    o.lights.forEach((l, i) => {
      lights.append(field('Position', vec(() => l.p, (v) => { l.p = v; }, 0.05)));
      lights.append(el('div', { class: 'row', style: 'align-items:center' },
        sel([['steady', 'Steady'], ['blink', 'Blink'], ['alt', 'Alternate'], ['strobe', 'Strobe']], () => l.mode, (v) => { l.mode = v; }),
        el('span', { class: 'hint' }, 'rate'), el('div', { style: 'width:56px' }, num(() => l.rate, (v) => { l.rate = v; })),
        el('span', { class: 'hint' }, 'phase'), el('div', { style: 'width:56px' }, num(() => l.phase, (v) => { l.phase = v; })),
        btn('✕', () => edit(() => o.lights.splice(i, 1)))));
    });
    p.append(lights);
    // Keys
    const keys = el('div', { class: 'sub' }, el('h3', {}, `Flight keys (${o.keys.length})`, btn('◆ Key at playhead', () => addKey(o.id, round2(time)))));
    const k = selection.key != null ? o.keys[selection.key] : null;
    if (k) {
      keys.append(field('Time (s)', num(() => k.t, (v) => { k.t = Math.max(0, Math.min(scene.duration, v)); o.keys.sort((a, b) => a.t - b.t); selection.key = o.keys.indexOf(k); }, { step: 0.05 })));
      keys.append(field('Position', vec(() => k.p, (v) => { k.p = v; })));
      if (!o.autoOrient) keys.append(field('Yaw/pitch/roll °', vec(() => k.r || [0, 0, 0], (v) => { k.r = v; }, 5)));
      keys.append(field('Ease to next', easeSel(() => k.ease || 'smooth', (v) => { k.ease = v; })));
      keys.append(el('div', { class: 'row' }, btn('Delete key', () => { edit(() => o.keys.splice(selection.key, 1)); select({ kind: 'object', id: o.id, key: null }); })));
    } else keys.append(el('div', { class: 'hint' }, 'Select a key on the timeline or in the view. Dragging the model with no key selected adds a key at the playhead.'));
    p.append(keys);
    p.append(el('div', { class: 'row' }, el('label', { class: 'btn' }, 'Replace mesh with .obj…', el('input', { type: 'file', accept: '.obj', onchange: (e) => importOBJ(e.target.files[0], o) }))));
  } else if (o.type === 'lights') {
    p.append(field('Shape', sel([['line', 'Line'], ['rect', 'Rectangle (flat)']], () => o.shape, (v) => { o.shape = v; })));
    p.append(field('From', vec(() => o.a, (v) => { o.a = v; })));
    p.append(field('To', vec(() => o.b, (v) => { o.b = v; })));
    p.append(field('Spacing', num(() => o.spacing, (v) => { o.spacing = Math.max(0.3, v); })));
    p.append(field('Mode', sel([['steady', 'Steady'], ['blink', 'Blink'], ['strobe', 'Strobe'], ['chase', 'Chase']], () => o.mode, (v) => { o.mode = v; })));
    p.append(field('Rate', num(() => o.rate, (v) => { o.rate = v; })));
  }
  p.append(el('div', { class: 'row' }, btn('Duplicate', () => duplicate(o)), btn('Delete', () => deleteObjects([o.id]))));
}

function renderSceneProps(p) {
  const S = scene.settings;
  p.append(el('h2', {}, 'Scene settings'));
  p.append(field('Name', txt(() => scene.name, (v) => { scene.name = v.replace(/[^\w\- ]/g, '').slice(0, 60) || 'untitled'; })));
  p.append(field('Length (s)', num(() => scene.duration, (v) => { scene.duration = Math.max(1, v); }, { step: 0.5 })));
  p.append(field('Lens (focal)', num(() => S.focal, (v) => { S.focal = Math.max(10, v); }, { step: 1 })));
  p.append(field('View distance', num(() => S.far, (v) => { S.far = Math.max(10, v); }, { step: 5 })));
  p.append(field('Fog distance', num(() => S.fogDist, (v) => { S.fogDist = Math.max(5, v); }, { step: 5 })));
  p.append(field('Window spacing', el('div', { class: 'vec', style: 'grid-template-columns:1fr 1fr' }, num(() => S.winSpacingX, (v) => { S.winSpacingX = Math.max(1, v); }), num(() => S.winSpacingY, (v) => { S.winSpacingY = Math.max(1, v); }))));
  p.append(field('Rain drops', num(() => S.rain.count, (v) => { S.rain.count = Math.max(0, Math.min(40, Math.round(v))); }, { step: 1 })));
  p.append(field('Rain slant', num(() => S.rain.slant, (v) => { S.rain.slant = v; }, { step: 0.05 })));
  p.append(field('Rain speed', num(() => S.rain.speed, (v) => { S.rain.speed = v; }, { step: 5 })));
  p.append(field('Fade in (s)', num(() => S.fadeIn, (v) => { S.fadeIn = Math.max(0, v); })));
  p.append(field('Fade out (s)', num(() => S.fadeOut, (v) => { S.fadeOut = Math.max(0, v); })));
  p.append(field('Light direction', vec(() => S.lightDir, (v) => { S.lightDir = v; }, 0.1)));
  p.append(el('div', { class: 'hint' }, 'Tip: the shaded graph behind the timeline is the estimated board frame rate across the loop. Keep it out of the red (under 12 fps).'));
}

function renderCameraProps(p) {
  p.append(el('h2', {}, 'Camera'));
  const keys = scene.camera.keys;
  p.append(el('div', { class: 'row' }, btn('◆ Key from current view', () => keyCameraFromView()), btn('◆ Key at playhead', () => addKey('camera', round2(time)))));
  const k = selection.key != null ? keys[selection.key] : null;
  if (!k) {
    p.append(el('div', { class: 'hint' }, 'Fixed keys place the camera at a point looking at a target. Follow keys chase a model. Select a key on the timeline to edit it. "Key from current view" records exactly what the editor view shows.'));
    return;
  }
  const models = scene.objects.filter((o) => o.type === 'model');
  p.append(field('Time (s)', num(() => k.t, (v) => { k.t = Math.max(0, Math.min(scene.duration, v)); keys.sort((a, b) => a.t - b.t); selection.key = keys.indexOf(k); }, { step: 0.05 })));
  p.append(field('Mode', sel([['fixed', 'Fixed'], ['follow', 'Follow a model']], () => k.mode, (v) => {
    if (v === 'follow' && !models.length) { toast('Add a model to follow first'); return; }
    if (v === 'follow') Object.assign(k, { mode: 'follow', target: k.target || models[0].id, back: 9, side: 3.5, up: 3, ahead: 4, lookSide: 0, lookUp: 0.6 });
    else {
      const cam = cameraAt(compiled, k.t, compiled.models.map((m) => modelPose(m, k.t)));
      Object.assign(k, { mode: 'fixed', eye: cam.eye.map(round2), look: cam.look.map(round2) });
    }
  })));
  if (k.mode === 'fixed') {
    p.append(field('Eye', vec(() => k.eye, (v) => { k.eye = v; })));
    p.append(field('Looking at', vec(() => k.look, (v) => { k.look = v; })));
    p.append(el('div', { class: 'row' }, btn('Set from current view', () => edit(() => { const v = view.viewPose(); k.eye = v.eye; k.look = v.look; }))));
  } else {
    p.append(field('Follow', sel(models.map((m) => [m.id, m.name]), () => k.target, (v) => { k.target = v; })));
    p.append(field('Behind', num(() => k.back, (v) => { k.back = v; })));
    p.append(field('To the side', num(() => k.side, (v) => { k.side = v; })));
    p.append(field('Above', num(() => k.up, (v) => { k.up = v; })));
    p.append(field('Look ahead', num(() => k.ahead, (v) => { k.ahead = v; })));
    p.append(field('Look left', num(() => k.lookSide, (v) => { k.lookSide = v; })));
    p.append(field('Look up', num(() => k.lookUp, (v) => { k.lookUp = v; })));
  }
  p.append(field('Ease to next', easeSel(() => k.ease || 'smooth', (v) => { k.ease = v; })));
  p.append(el('div', { class: 'row' }, btn('Delete key', () => { if (keys.length <= 1) return toast('The camera needs at least one key'); edit(() => keys.splice(selection.key, 1)); select({ kind: 'camera', key: null }); })));
}

function keyCameraFromView() {
  const v = view.viewPose(), t = round2(time);
  edit((s) => {
    const keys = s.camera.keys;
    let k = keys.find((x) => Math.abs(x.t - t) < 0.03);
    if (k) Object.assign(k, { mode: 'fixed', eye: v.eye, look: v.look });
    else { k = { t, mode: 'fixed', eye: v.eye, look: v.look, ease: 'smooth' }; keys.push(k); keys.sort((a, b) => a.t - b.t); }
    selection = { kind: 'camera', key: keys.indexOf(k) };
  });
  toast(`Camera key at ${t.toFixed(2)} s`);
}

function duplicate(o) {
  const c = structuredClone(o);
  c.id = newId(); c.name = o.name + ' copy';
  const shift = (v) => [v[0] + 5, v[1], v[2]];
  if (c.type === 'box') { c.x0 += 5; c.x1 += 5; }
  else if (c.type === 'billboard') c.pos = shift(c.pos);
  else if (c.type === 'lights') { c.a = shift(c.a); c.b = shift(c.b); }
  else if (c.type === 'model') c.keys.forEach((k) => { k.p = shift(k.p); });
  edit((s) => s.objects.push(c));
  select({ kind: 'object', id: c.id, key: null });
}

function updateViewButtons() {
  let st;
  try { st = view.viewState(); } catch { return; }   // view not created yet
  $('quadBtn').classList.toggle('on', st.quad);
  $('blockBtn').classList.toggle('on', st.blockTool);
  $('camToolBtn').classList.toggle('on', st.camTool);
  $('pathToolBtn').classList.toggle('on', st.pathTool);
  $('gridText').textContent = `grid ${st.gridSize}`;
  $('viewHelp').innerHTML = st.quad
    ? (st.pathTool ? '<b>Model path:</b> select a model, then click points along its route in a 2D view. Each click keys the playhead, then steps it forward. In Top, drag to also set which way it faces (when "Face travel" is off). Esc: done'
      : st.camTool ? '<b>Camera path:</b> in a 2D view, press where the camera goes and drag to what it looks at. Each drag keys the playhead, then steps it forward. Click = move camera, keep direction. Esc: done'
      : '2D views: click select · drag move · handles resize · <b>B: block tool</b> · <b>P: camera path</b> · [ ] grid · right/middle-drag pan · scroll zoom · V: single view')
    : 'Drag: orbit · Middle-drag: pan · Scroll: zoom · <b>Right-drag + WASD: fly</b> (Q/E down/up, Shift fast) · Z: fly toggle · V: 4 views · Click: select · F: focus';
}

function refreshPanels() { renderOutliner(); renderProps(); timeline.draw(); updateButtons(); }
function refreshAll() { refreshPanels(); }
function updateButtons() {
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
  $('timeline').style.height = timeline.height(timeline.rowCount()) + 'px';
}

// ---------- adding objects ----------
const target = () => view.viewPose().look.map((v) => Math.round(v));
function addObject(o) { o.id = o.id || newId(); edit((s) => s.objects.push(o)); select({ kind: 'object', id: o.id, key: null }); }

$('addBox').onclick = () => { const [x, , z] = target(); addObject({ type: 'box', name: 'Building', x0: x - 5, x1: x + 5, y0: 0, y1: 24, z0: z - 5, z1: z + 5, windows: 0.4, winStyle: 'grid', edges: true, bright: false, seed: Math.floor(Math.random() * 256) }); };
$('addLights').onclick = () => { const [x, y, z] = target(); addObject({ type: 'lights', name: 'Lights', shape: 'line', a: [x - 6, y, z], b: [x + 6, y, z], spacing: 2, mode: 'chase', rate: 8 }); };
for (const [key, m] of Object.entries(LIBRARY)) $('addModel').append(el('option', { value: key }, m.name));
$('addModel').onchange = (e) => {
  const m = LIBRARY[e.target.value];
  e.target.value = '';
  e.target.blur();
  if (!m) return;
  const [x, y, z] = target();
  addObject({ type: 'model', name: m.name, mesh: structuredClone(m.mesh), scale: m.scale, autoOrient: m.autoOrient, bob: m.bob, headlights: m.headlights, thrusters: m.thrusters, powerDown: false,
    lights: structuredClone(m.lights), keys: [{ t: 0, p: [x, Math.max(y, 2), z], r: [0, 0, 0], ease: 'smooth' }] });
};
$('objInput').onchange = (e) => { importOBJ(e.target.files[0]); e.target.value = ''; };

async function importOBJ(file, replaceIn) {
  if (!file) return;
  try {
    const mesh = parseOBJ(await file.text());
    if (mesh.truncated) toast(`Only the first 160 of ${mesh.faceCount} faces were kept`);
    if (replaceIn) { edit(() => { replaceIn.mesh = { verts: mesh.verts, faces: mesh.faces }; }); return; }
    const [x, y, z] = target();
    addObject({ type: 'model', name: file.name.replace(/\.obj$/i, ''), mesh: { verts: mesh.verts, faces: mesh.faces }, scale: 1, autoOrient: false, bob: 0, headlights: false, thrusters: false, powerDown: false,
      lights: [], keys: [{ t: 0, p: [x, Math.max(y, 2), z], r: [0, 0, 0], ease: 'smooth' }] });
  } catch (err) { alert(err.message); }
}

// ---------- dialogs ----------
const dlg = $('dlg');
function dialog(title, body, actions) {
  dlg.innerHTML = '';
  dlg.append(el('h2', {}, title), body, el('div', { class: 'actions' }, ...actions));
  dlg.showModal();
}
const closeBtn = (label = 'Cancel') => btn(label, () => dlg.close());

$('addStreet').onclick = () => {
  const [x, , z] = target();
  const p = { group: 'Street', centerX: x, z0: z, length: 200, sides: 'both', inner: 6, depthMin: 8, depthMax: 16, gapMin: 2, gapMax: 5, heightMin: 14, heightMax: 46, windows: 0.375, backRow: true, seed: Math.floor(Math.random() * 1e6) };
  const body = el('div');
  const f = (label, key, step = 1) => { const i = el('input', { type: 'number', step }); i.value = p[key]; i.onchange = () => { p[key] = parseFloat(i.value); }; return field(label, i); };
  const t = el('input', { type: 'text' }); t.value = p.group; t.onchange = () => { p.group = t.value || 'Street'; };
  const s = el('select'); for (const v of ['both', 'left', 'right']) s.append(el('option', { value: v }, v)); s.onchange = () => { p.sides = s.value; };
  const b = el('input', { type: 'checkbox' }); b.checked = true; b.onchange = () => { p.backRow = b.checked; };
  body.append(el('div', { class: 'hint' }, 'Fills both sides of a street running along +z with buildings, starting at the point the view is looking at.'),
    field('Group name', t), field('Sides', s), f('Street centre x', 'centerX'), f('Start z', 'z0'), f('Length', 'length', 10), f('Half width', 'inner'),
    f('Depth min', 'depthMin'), f('Depth max', 'depthMax'), f('Gap min', 'gapMin'), f('Gap max', 'gapMax'), f('Height min', 'heightMin'), f('Height max', 'heightMax'),
    f('Lit windows', 'windows', 0.05), field('Taller back row', b), f('Random seed', 'seed'));
  dialog('Street generator', body, [closeBtn(), btn('Generate', () => {
    const boxes = generateStreet(p, newId);
    edit((sc) => sc.objects.push(...boxes));
    dlg.close();
    toast(`Added ${boxes.length} buildings`);
  }, 'primary')]);
};

// Image -> billboard (new, add frame, or replace)
function openImageDialog(existing, replace) {
  const st = { img: null, w: existing ? existing.tex.w : 40, h: existing ? existing.tex.h : 40, method: 'atkinson', brightness: 0, contrast: 1, invert: false, bits: null };
  const prev = el('canvas', { class: 'preview', width: st.w, height: st.h });
  const file = el('input', { type: 'file', accept: 'image/*' });
  const info = el('div', { class: 'hint' }, 'Choose an image. It is shrunk and turned into OLED dots.');
  const redraw = () => {
    if (!st.img) return;
    prev.width = st.w; prev.height = st.h;
    st.bits = ditherGray(imageToGray(st.img, st.w, st.h), st.w, st.h, st);
    const x = prev.getContext('2d'), im = x.createImageData(st.w, st.h);
    st.bits.forEach((b, k) => im.data.set(b ? [159, 227, 255, 255] : [0, 0, 0, 255], k * 4));
    x.putImageData(im, 0, 0);
  };
  file.onchange = async () => { st.img = await loadImage(file.files[0]); if (!existing) { const a = st.img.height / st.img.width; st.w = 40; st.h = Math.max(8, Math.min(64, Math.round(40 * a))); wIn.value = st.w; hIn.value = st.h; } redraw(); };
  const n = (key, step, min, max) => { const i = el('input', { type: 'number', step, min, max }); i.value = st[key]; i.onchange = () => { st[key] = parseFloat(i.value); redraw(); }; return i; };
  const wIn = n('w', 1, 8, 64), hIn = n('h', 1, 8, 64);
  if (existing) { wIn.disabled = hIn.disabled = !replace; }
  const m = el('select'); for (const [v, l] of [['atkinson', 'Atkinson (crisp)'], ['floyd', 'Floyd–Steinberg'], ['bayer', 'Ordered'], ['threshold', 'Threshold']]) m.append(el('option', { value: v }, l));
  m.onchange = () => { st.method = m.value; redraw(); };
  const inv = el('input', { type: 'checkbox' }); inv.onchange = () => { st.invert = inv.checked; redraw(); };
  const body = el('div', {}, el('div', { class: 'row' }, el('label', { class: 'btn' }, 'Choose image…', file)), info, prev,
    field('Texture w × h', el('div', { class: 'vec', style: 'grid-template-columns:1fr 1fr' }, wIn, hIn)), field('Dither', m),
    field('Brightness', n('brightness', 5, -100, 100)), field('Contrast', n('contrast', 0.1, 0.2, 3)), field('Invert', inv));
  const ok = btn(existing ? (replace ? 'Replace frames' : 'Add frame') : 'Add billboard', () => {
    if (!st.bits) return;
    const frame = { bits: encodeBits(st.bits, st.w, st.h), dur: 1 };
    if (existing && !replace) edit(() => existing.tex.frames.push(frame));
    else if (existing) edit(() => { existing.tex = { w: st.w, h: st.h, frames: [frame] }; });
    else {
      const [x, y, z] = target();
      addObject({ type: 'billboard', name: 'Billboard', pos: [x, Math.max(y, 10), z], yaw: 180, w: 16, h: 16 * st.h / st.w, tex: { w: st.w, h: st.h, frames: [frame] }, scanline: true, glitch: false, border: true });
    }
    dlg.close();
  }, 'primary');
  dialog(existing ? 'Billboard image' : 'New billboard', body, [closeBtn(), ok]);
}
$('addBillboard').onclick = () => openImageDialog(null);

$('addText').onclick = () => {
  const st = { text: 'ネオン', w: 16, h: 48, vertical: true };
  const prev = el('canvas', { class: 'preview', width: st.w, height: st.h });
  const redraw = () => {
    prev.width = st.w; prev.height = st.h;
    st.bits = textToBits(st.text, st.w, st.h, { vertical: st.vertical });
    const x = prev.getContext('2d'), im = x.createImageData(st.w, st.h);
    st.bits.forEach((b, k) => im.data.set(b ? [159, 227, 255, 255] : [0, 0, 0, 255], k * 4));
    x.putImageData(im, 0, 0);
  };
  const t = el('input', { type: 'text' }); t.value = st.text; t.oninput = () => { st.text = t.value; redraw(); };
  const v = el('input', { type: 'checkbox' }); v.checked = true; v.onchange = () => { st.vertical = v.checked; [st.w, st.h] = st.vertical ? [16, 48] : [48, 16]; wI.value = st.w; hI.value = st.h; redraw(); };
  const wI = el('input', { type: 'number', min: 8, max: 64 }); wI.value = st.w; wI.onchange = () => { st.w = +wI.value; redraw(); };
  const hI = el('input', { type: 'number', min: 8, max: 64 }); hI.value = st.h; hI.onchange = () => { st.h = +hI.value; redraw(); };
  dialog('Text sign', el('div', {}, field('Text', t), field('Vertical', v), field('Texture w × h', el('div', { class: 'vec', style: 'grid-template-columns:1fr 1fr' }, wI, hI)), prev,
    el('div', { class: 'hint' }, 'Tip: add a second frame with the text missing a character for a failing-neon flicker.')), [closeBtn(), btn('Add sign', () => {
    const [x, y, z] = target();
    addObject({ type: 'billboard', name: 'Sign: ' + st.text, pos: [x, Math.max(y, 10), z], yaw: 180, w: st.w / 4, h: st.h / 4, tex: { w: st.w, h: st.h, frames: [{ bits: encodeBits(st.bits, st.w, st.h), dur: 1 }] }, scanline: false, glitch: false, border: false });
    dlg.close();
  }, 'primary')]);
  redraw();
};

// ---------- files: open / new / save / export / flash ----------
async function loadSceneList(selectName) {
  const names = await fetch('/api/scenes').then((r) => r.json());
  const s = $('sceneSelect');
  s.innerHTML = '';
  for (const n of names) s.append(el('option', { value: n }, n));
  if (selectName && !names.includes(selectName)) s.append(el('option', { value: selectName }, selectName + ' (unsaved)'));
  s.value = selectName || '';
}
$('sceneSelect').onchange = async (e) => {
  if (dirty && !confirm('Discard unsaved changes?')) { e.target.value = scene.name; return; }
  const s = await fetch('/api/scene?name=' + encodeURIComponent(e.target.value)).then((r) => r.json());
  setScene(s); dirty = false; $('saveBtn').textContent = 'Save';
};
$('newBtn').onclick = () => {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  const name = prompt('Name for the new scene', 'my-scene');
  if (!name) return;
  setScene(emptyScene(name.replace(/[^\w\- ]/g, '').slice(0, 60) || 'untitled'));
  loadSceneList(scene.name); markDirty();
};
async function save() {
  const r = await fetch('/api/scene?name=' + encodeURIComponent(scene.name), { method: 'PUT', body: JSON.stringify(scene, null, 1) });
  if (!r.ok) return toast('Save failed');
  dirty = false; $('saveBtn').textContent = 'Save';
  loadSceneList(scene.name);
  toast(`Saved ${scene.name}`);
}
$('saveBtn').onclick = save;

async function exportScene() {
  const r = await fetch('/api/export', { method: 'PUT', body: exportSceneH(scene) });
  if (!r.ok) { toast('Export failed'); return false; }
  toast('Exported to firmware/include/scene.h');
  return true;
}
$('exportBtn').onclick = exportScene;

$('flashBtn').onclick = async () => {
  if (!(await exportScene())) return;
  const log = el('pre', { class: 'log' }, 'Building and uploading… (the first build takes a minute)\n');
  const close = closeBtn('Close');
  close.disabled = true;
  dialog('Flash to board', log, [close]);
  const wasConnected = !!port;
  if (wasConnected) await disconnect(true);   // the upload tool needs the port
  try {
    const res = await fetch('/api/flash', { method: 'POST' });
    const reader = res.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      log.textContent += dec.decode(value, { stream: true });
      log.scrollTop = log.scrollHeight;
    }
  } catch (e) { log.textContent += '\n' + e.message; }
  close.disabled = false;
  const ok = /\[exit 0\]/.test(log.textContent);
  log.textContent += ok ? '\nDone. The board is playing the new scene.' : '\nSomething went wrong; see above.';
  if (ok && wasConnected) setTimeout(() => reconnect(), 1500);
};

// ---------- Web Serial: live preview + board fps ----------
let port = null, writer = null, reader = null, live = false, sending = false, lastPort = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  try { lastPort = await navigator.serial.requestPort(); await openPort(lastPort, true); }
  catch (e) { if (e.name !== 'NotFoundError') setSerial(false, 'Could not open: ' + e.message); }
}
async function openPort(p, reset) {
  port = p;
  await port.open({ baudRate: 115200 });
  if (reset) {
    // Opening the port can leave the ESP32-C3 in its bootloader; pulse a normal reset.
    setSerial(false, 'Restarting board…');
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(150);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(1200);
    if (!port?.writable) return;
  }
  writer = port.writable.getWriter();
  setSerial(true);
  readLoop();
}
async function reconnect() {
  const ports = await navigator.serial.getPorts();
  const p = ports.find((x) => x === lastPort) || ports[0];
  if (p) { lastPort = p; try { await openPort(p, false); } catch (e) { setSerial(false, 'Reconnect failed; click Connect'); } }
}
async function disconnect(keepPortChoice) {
  live = false; $('liveBtn').classList.remove('on');
  try { await reader?.cancel(); } catch {}
  try { writer?.releaseLock(); await port?.close(); } catch {}
  port = writer = reader = null;
  if (!keepPortChoice) lastPort = null;
  setSerial(false);
}
async function readLoop() {
  const dec = new TextDecoder();
  let text = '';
  try {
    reader = port.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      let nl;
      while ((nl = text.indexOf('\n')) >= 0) {
        const m = /^fps (\d+)/.exec(text.slice(0, nl));
        text = text.slice(nl + 1);
        if (m) { boardFps = +m[1]; $('boardFps').textContent = `board: ${boardFps} fps`; }
      }
    }
  } catch {}
  finally { try { reader?.releaseLock(); } catch {} }
}
function sendFrame(p) {
  if (!writer || sending) return;
  sending = true;
  writer.write(p).catch(() => disconnect()).finally(() => { sending = false; });
}
function setSerial(on, msg) {
  $('serialDot').className = 'dot' + (on ? ' on' : msg ? ' warn' : '');
  $('serialText').textContent = on ? 'Board connected' : msg || 'Board not connected';
  $('connectBtn').textContent = on ? 'Disconnect' : 'Connect board';
  $('liveBtn').disabled = !on;
  if (!on) $('boardFps').textContent = '';
}
$('connectBtn').onclick = () => (port ? disconnect() : connect());
$('liveBtn').onclick = () => {
  live = !live;
  $('liveBtn').classList.toggle('on', live);
  if (!live) toast('Live off: the board goes back to its own copy of the scene in 1.5 s');
};
if (!('serial' in navigator)) { $('unsupported').style.display = 'block'; $('connectBtn').disabled = true; }
navigator.serial?.addEventListener('disconnect', (e) => { if (e.target === port) { port = writer = null; setSerial(false, 'Board unplugged'); } });

// ---------- toolbar, playback, keyboard ----------
function setPlaying(v) { playing = v; $('playBtn').textContent = v ? '❚❚' : '▶'; }
$('playBtn').onclick = () => setPlaying(!playing);
$('startBtn').onclick = () => setTime(0);
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
$('keyBtn').onclick = () => {
  if (selection.kind === 'camera') keyCameraFromView();
  else if (selectedObject()?.type === 'model') addKey(selection.id, round2(time));
  else toast('Select the camera or a model to key it');
};
const modeBtns = { translate: 'modeT', rotate: 'modeR', scale: 'modeS' };
function setMode(m) { for (const [k, id] of Object.entries(modeBtns)) $(id).classList.toggle('on', k === m); view.setGizmoMode(m); }
$('modeT').onclick = () => setMode('translate');
$('modeR').onclick = () => setMode('rotate');
$('modeS').onclick = () => setMode('scale');
let looking = false;
$('quadBtn').onclick = () => view.setQuad(!view.viewState().quad);
$('blockBtn').onclick = () => view.setBlockTool(!view.viewState().blockTool);
$('camToolBtn').onclick = () => view.setCamTool(!view.viewState().camTool);
$('pathToolBtn').onclick = () => view.setPathTool(!view.viewState().pathTool);
$('lookBtn').onclick = () => { looking = !looking; $('lookBtn').classList.toggle('on', looking); view.setLookThrough(looking); };

addEventListener('keydown', (e) => {
  // Only text boxes swallow shortcuts; dropdowns, checkboxes and buttons don't
  const a = document.activeElement;
  const typing = dlg.open || a?.tagName === 'TEXTAREA' || (a?.tagName === 'INPUT' && ['text', 'number', ''].includes(a.type));
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
  else if (e.key === 'w') setMode('translate');
  else if (e.key === 'e') setMode('rotate');
  else if (e.key === 'r') setMode('scale');
  else if (e.key === 'f') view.frameSelection();
  else if (e.key === 'c') $('lookBtn').click();
  else if (e.key === 'k') $('keyBtn').click();
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selection.kind === 'object' && selection.key != null) { const o = selectedObject(); edit(() => o.keys.splice(selection.key, 1)); select({ kind: 'object', id: o.id, key: null }); }
    else if (selection.kind === 'camera' && selection.key != null && scene.camera.keys.length > 1) { edit((s) => s.camera.keys.splice(selection.key, 1)); select({ kind: 'camera', key: null }); }
    else if (selection.kind === 'object') deleteObjects([selection.id]);
  }
  else if (e.key === 'ArrowLeft') setTime(time - (e.shiftKey ? 1 : 0.05));
  else if (e.key === 'ArrowRight') setTime(time + (e.shiftKey ? 1 : 0.05));
});
addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200); }

// ---------- start ----------
(async () => {
  let s = null;
  try { const d = localStorage.getItem('oled3d-draft'); if (d) s = JSON.parse(d); } catch {}
  if (!s) {
    const r = await fetch('/api/scene?name=spinner-landing');
    s = r.ok ? await r.json() : emptyScene();
  }
  setScene(s);
  await loadSceneList(scene.name);
  requestAnimationFrame(tick);
})();
