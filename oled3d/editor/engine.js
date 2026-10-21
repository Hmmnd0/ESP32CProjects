// OLED3D engine (JavaScript). Mirrors firmware/src/main.cpp step for step so the
// editor preview matches the board pixel for pixel (rain and flicker included,
// since everything is a pure function of time).
//
// Coordinates: x right, y up, z forward (the camera looks along +z by default).

export const W = 72, H = 40;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const dither = (x, y, level) => BAYER[(y & 3) * 4 + (x & 3)] < level * 16;

// ---------- math ----------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-6 ? mul(a, 1 / l) : a; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const span = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const fround = Math.fround;

// ---------- fixed point (mirrors the firmware) ----------
// Positions in Q16.16, screen coordinates in Q4 (1 pixel = 16). The firmware does this
// with 32/64-bit integers; here doubles hold the same integers exactly (all < 2^53).
const f32 = Math.fround;
const roundEven = (v) => { const r = Math.round(v); return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; };
const toFx = (v) => roundEven(f32(v) * 65536);                 // lrintf(v * 65536.0f)
const round3 = (v) => Math.round(v * 1000) / 1000;              // scene.h stores 3 decimals
const idiv = (a, b) => Math.trunc(a / b);                       // C integer division
const shr = (v, n) => Math.floor(v / 2 ** n);                   // arithmetic shift on (64-bit) integers
const clampi = (v, a, b) => (v < a ? a : v > b ? b : v);
const ceilDiv16 = (v) => -Math.floor(-v / 16);
const COORD_LIMIT = 8000 * 16;
const ditherLevel = (level) => (level <= 0 ? 0 : level >= 1 ? 16 : Math.ceil(f32(level) * 16));
const ditherI = (x, y, level16) => BAYER[(y & 3) * 4 + (x & 3)] < level16;

export const EASES = ['linear', 'smooth', 'in', 'out', 'cut'];   // 'cut' holds, then jumps at the next key
export function ease(kind, s) {
  s = clamp(s, 0, 1);
  switch (kind) {
    case 1: return s * s * (3 - 2 * s);
    case 2: return s * s;
    case 3: return 1 - (1 - s) * (1 - s) * (1 - s);
    default: return s;
  }
}

// Interpolate keyed values (arrays of numbers) with Catmull-Rom tangents and a
// per-segment ease (the ease stored on the key that starts the segment).
export function interpKeys(keys, t, val) {
  const n = keys.length;
  if (!n) return null;
  if (t <= keys[0].t || n === 1) return val(keys[0]);
  if (t >= keys[n - 1].t) return val(keys[n - 1]);
  let i = 0;
  while (t > keys[i + 1].t) i++;
  const t0 = keys[i].t, t1 = keys[i + 1].t, dt = t1 - t0;
  if (keys[i].ease === 4) return val(keys[i]);   // cut: hold until the next key
  const s = ease(keys[i].ease ?? 1, (t - t0) / dt);
  const p0 = val(keys[i]), p1 = val(keys[i + 1]);
  const tan = (k) => {
    // never smooth across a cut
    const a = (k > 0 && keys[k - 1].ease !== 4) ? k - 1 : k;
    const b = (k < n - 1 && keys[k].ease !== 4) ? k + 1 : k;
    if (a === b) return p0.map(() => 0);
    const pa = val(keys[a]), pb = val(keys[b]);
    return pa.map((_, j) => (pb[j] - pa[j]) * (dt / (keys[b].t - keys[a].t)));
  };
  const m0 = tan(i), m1 = tan(i + 1);
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  return p0.map((_, j) => p0[j] * h00 + m0[j] * h10 + p1[j] * h01 + m1[j] * h11);
}

// ---------- compile: scene JSON -> flat structures (same layout as the export) ----------
const WIN_STYLE = { none: 0, grid: 1, bands: 2 };
const LIGHT_MODE = { steady: 0, blink: 1, alt: 2, strobe: 3, chase: 4 };

export function compile(scene) {
  const S = scene.settings;
  const c = {
    duration: scene.duration,
    focal: S.focal, near: S.near, far: S.far, fogDist: S.fogDist, winX: S.winSpacingX, winY: S.winSpacingY,
    rainCount: S.rain.count, rainSlant: S.rain.slant, rainSpeed: S.rain.speed,
    fadeIn: S.fadeIn, fadeOut: S.fadeOut, light: norm(S.lightDir),
    boxes: [], billboards: [], models: [], strips: [], camKeys: [], modelIndex: {},
  };
  for (const o of scene.objects) {
    if (o.hidden) continue;
    if (o.type === 'box') {
      c.boxes.push({ x0: Math.min(o.x0, o.x1), x1: Math.max(o.x0, o.x1), y0: Math.min(o.y0, o.y1), y1: Math.max(o.y0, o.y1),
        z0: Math.min(o.z0, o.z1), z1: Math.max(o.z0, o.z1), win: Math.round(clamp(o.windows, 0, 1) * 255),
        style: WIN_STYLE[o.winStyle] ?? 1, flags: (o.edges ? 1 : 0) | (o.bright ? 2 : 0), seed: o.seed & 255, src: o });
      const b = c.boxes[c.boxes.length - 1], q = (v) => f32(round3(v));
      const x0 = q(b.x0), x1 = q(b.x1), y0 = q(b.y0), y1 = q(b.y1), z0 = q(b.z0), z1 = q(b.z1);
      b.fx = { lo: [toFx(x0), toFx(y0), toFx(z0)], hi: [toFx(x1), toFx(y1), toFx(z1)],
        centre: [toFx(f32(x0 + x1) / 2), toFx(f32(y0 + y1) / 2), toFx(f32(z0 + z1) / 2)],
        radius: toFx(f32(Math.max(f32(x1 - x0), f32(z1 - z0), f32(y1 - y0)) * f32(0.8))) };
    } else if (o.type === 'billboard') {
      const frames = o.tex.frames.slice(0, 4);
      c.billboards.push({ x: o.pos[0], y: o.pos[1], z: o.pos[2], yaw: o.yaw * Math.PI / 180, w: o.w, h: o.h,
        tw: o.tex.w, th: o.tex.h, frames: frames.map((f) => decodeBits(f.bits, o.tex.w, o.tex.h)), dur: frames.map((f) => f.dur),
        flags: (o.scanline ? 1 : 0) | (o.glitch ? 2 : 0) | (o.border ? 4 : 0), src: o });
    } else if (o.type === 'model') {
      const verts = o.mesh.verts, faces = o.mesh.faces.slice(0, 160);
      let zFront = -1e9, yMin = 1e9;
      for (const v of verts) { zFront = Math.max(zFront, v[2]); yMin = Math.min(yMin, v[1]); }
      c.modelIndex[o.id] = c.models.length;
      c.models.push({ verts, faces: faces.map((f) => ({ v: f.v.slice(0, 4), dark: f.style === 'dark' })), scale: o.scale,
        flags: (o.autoOrient ? 1 : 0) | (o.headlights ? 2 : 0) | (o.thrusters ? 4 : 0) | (o.powerDown ? 8 : 0),
        bob: o.bob, keys: [...o.keys].sort((a, b) => a.t - b.t).map((k) => ({ t: k.t, p: k.p, r: (k.r || [0, 0, 0]).map((d) => d * Math.PI / 180), ease: EASES.indexOf(k.ease ?? 'smooth') })),
        lights: (o.lights || []).map((l) => ({ p: l.p, mode: LIGHT_MODE[l.mode] ?? 0, rate: l.rate, phase: l.phase })),
        zFront, yMin, src: o });
    } else if (o.type === 'lights') {
      c.strips.push({ a: o.a, b: o.b, spacing: Math.max(0.5, o.spacing), shape: o.shape === 'rect' ? 1 : 0, mode: LIGHT_MODE[o.mode] ?? 0, rate: o.rate, src: o });
    }
  }
  c.camKeys = [...scene.camera.keys].sort((a, b) => a.t - b.t).map((k) => ({
    t: k.t, mode: k.mode === 'follow' ? 1 : 0, model: c.modelIndex[k.target] ?? 0, ease: EASES.indexOf(k.ease ?? 'smooth'),
    a: k.mode === 'follow' ? [k.back, k.side, k.up, k.ahead, k.lookSide, k.lookUp] : [...k.eye, ...k.look],
    valid: k.mode !== 'follow' || c.modelIndex[k.target] !== undefined,
  })).filter((k) => k.valid);
  return c;
}

export function decodeBits(b64, w, h) {
  const bin = atob(b64), rowBytes = Math.ceil(w / 8), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = (bin.charCodeAt(y * rowBytes + (x >> 3)) >> (x & 7)) & 1;
  return out;
}
export function encodeBits(bits, w, h) {
  const rowBytes = Math.ceil(w / 8), bytes = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bits[y * w + x]) bytes[y * rowBytes + (x >> 3)] |= 1 << (x & 7);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// ---------- animation ----------
function modelPos(m, t) { return interpKeys(m.keys, t, (k) => k.p); }

function headingAt(m, t) {
  let p = modelPos(m, t), a = sub(modelPos(m, t + 0.15), p);
  if (Math.hypot(a[0], a[2]) < 0.05) {
    for (let d = 0.3; d <= 3; d += 0.3) { a = sub(p, modelPos(m, t - d)); if (Math.hypot(a[0], a[2]) >= 0.05) break; }
  }
  return Math.hypot(a[0], a[2]) >= 0.05 ? Math.atan2(a[0], a[2]) : (m.keys[0]?.r[0] ?? 0);
}

export function modelPose(m, t) {
  const pos = modelPos(m, t);
  if (!pos) return null;
  const lastT = m.keys[m.keys.length - 1].t;
  const powered = !(m.flags & 8) || t < lastT;
  let yaw, pitch, roll;
  if (m.flags & 1) {
    yaw = headingAt(m, t);
    const a = sub(modelPos(m, t + 0.15), pos), horiz = Math.hypot(a[0], a[2]);
    pitch = clamp(Math.atan2(a[1], Math.max(horiz, 0.01)) * 0.5, -0.3, 0.3);
    let dy = headingAt(m, t + 0.15) - headingAt(m, t - 0.15);
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    roll = clamp(-(dy / 0.3) * 0.5, -0.5, 0.5) + Math.sin(t * 1.7) * 0.04;
  } else {
    [yaw, pitch, roll] = interpKeys(m.keys, t, (k) => k.r);
  }
  const p = [...pos];
  if (m.bob && powered) p[1] += Math.sin(t * 2.3) * m.bob * (1 - span(t, lastT - 3.5, lastT));
  return { pos: p, yaw, pitch, roll, powered };
}

export function modelToWorld(m, pose, v) {
  const x = v[0] * m.scale, y = v[1] * m.scale, z = v[2] * m.scale;
  const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll), cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
  const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
  const ax = x * cr - y * sr, ay = x * sr + y * cr, az = z;
  const bx = ax, by = ay * cp + az * sp, bz = -ay * sp + az * cp;
  return [bx * cy + bz * sy + pose.pos[0], by + pose.pos[1], -bx * sy + bz * cy + pose.pos[2]];
}

// Camera eye/target at time t
export function cameraAt(c, t, poses) {
  const keys = c.camKeys;
  if (!keys.length) return { eye: [0, 10, -30], look: [0, 10, 0] };
  const val = (k) => {
    if (k.mode === 0) return k.a;
    const pose = poses[k.model];
    if (!pose) return [0, 10, -30, 0, 10, 0];
    const fwd = [Math.sin(pose.yaw), 0, Math.cos(pose.yaw)], right = [Math.cos(pose.yaw), 0, -Math.sin(pose.yaw)];
    const [back, side, up, ahead, lookSide, lookUp] = k.a;
    const eye = add(add(sub(pose.pos, mul(fwd, back)), mul(right, side)), [0, up, 0]);
    const look = add(sub(add(pose.pos, mul(fwd, ahead)), mul(right, lookSide)), [0, lookUp, 0]);
    return [...eye, ...look];
  };
  const v = interpKeys(keys, t, val);
  return { eye: v.slice(0, 3), look: v.slice(3, 6) };
}

// ---------- renderer ----------
export class Renderer {
  constructor() {
    this.buf = new Uint8Array(W * H);
    this.spanL = new Int32Array(H); this.spanR = new Int32Array(H);
    this.stats = {};
  }
  px(x, y, on) { if (x >= 0 && x < W && y >= 0 && y < H) this.buf[y * W + x] = on ? 1 : 0; }

  lookAt(eye, look) {
    this.eye = eye;
    this.f = norm(sub(look, eye));
    this.r = norm([this.f[2], 0, -this.f[0]]);
    this.u = cross(this.f, this.r);
    this.eyeI = eye.map(toFx); this.rI = this.r.map(toFx); this.uI = this.u.map(toFx); this.fI = this.f.map(toFx);
  }
  // world (Q16) -> camera space (Q16)
  toCamI(p) {
    const dx = p[0] - this.eyeI[0], dy = p[1] - this.eyeI[1], dz = p[2] - this.eyeI[2], r = this.rI, u = this.uI, f = this.fI;
    return [shr(dx * r[0] + dy * r[1] + dz * r[2], 16), shr(dx * u[0] + dy * u[1] + dz * u[2], 16), shr(dx * f[0] + dy * f[1] + dz * f[2], 16)];
  }
  // camera space (Q16) -> screen (Q4)
  projectI(c) {
    let zq = shr(c[2], 8); if (zq < 1) zq = 1;
    const xq = clampi(shr(c[0], 8), -3000000, 3000000), yq = clampi(shr(c[1], 8), -3000000, 3000000);
    return [(W / 2) * 16 + idiv(this.focal4 * xq, zq), (H / 2) * 16 - idiv(this.focal4 * yq, zq)];
  }
  camI(p) { return this.toCamI(p.map(toFx)); }
  // world point -> pixel, or null when it's behind the near plane
  screenI(p) {
    const c = this.camI(p);
    if (c[2] < this.nearI) return null;
    const s = this.projectI(c);
    return [s[0] >> 4, s[1] >> 4];
  }
  clipProjectI(poly) {
    const out = [], n = poly.length, N = this.nearI;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n], ia = a[2] >= N, ib = b[2] >= N;
      if (ia) out.push(a);
      if (ia !== ib) { const num = N - a[2], den = b[2] - a[2]; out.push([a[0] + idiv((b[0] - a[0]) * num, den), a[1] + idiv((b[1] - a[1]) * num, den), N]); }
    }
    return out.map((p) => this.projectI(p));
  }
  // Q4 line, clipped with integer Liang-Barsky (same as the firmware)
  lineI(a, b, level16 = 16) {
    const X1 = (W - 1) * 16, Y1 = (H - 1) * 16, L = COORD_LIMIT;
    let ax = clampi(a[0], -L, L), ay = clampi(a[1], -L, L), bx = clampi(b[0], -L, L), by = clampi(b[1], -L, L);
    const inside = ax >= 0 && ax <= X1 && bx >= 0 && bx <= X1 && ay >= 0 && ay <= Y1 && by >= 0 && by <= Y1;
    if (!inside) {
      const dx = bx - ax, dy = by - ay;
      let t0n = 0, t0d = 1, t1n = 1, t1d = 1;
      const p = [-dx, dx, -dy, dy], q = [ax, X1 - ax, ay, Y1 - ay];
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return; continue; }
        let rn = q[i], rd = p[i];
        if (rd < 0) { rn = -rn; rd = -rd; }
        if (p[i] < 0) { if (rn * t1d > t1n * rd) return; if (rn * t0d > t0n * rd) { t0n = rn; t0d = rd; } }
        else { if (rn * t0d < t0n * rd) return; if (rn * t1d < t1n * rd) { t1n = rn; t1d = rd; } }
      }
      const nax = ax + idiv(dx * t0n, t0d), nay = ay + idiv(dy * t0n, t0d), nbx = ax + idiv(dx * t1n, t1d), nby = ay + idiv(dy * t1n, t1d);
      ax = nax; ay = nay; bx = nbx; by = nby;
    }
    let x = (ax + 8) >> 4, y = (ay + 8) >> 4;
    const ex2 = (bx + 8) >> 4, ey2 = (by + 8) >> 4;
    const sx = x < ex2 ? 1 : -1, sy = y < ey2 ? 1 : -1, ex = Math.abs(ex2 - x), ey = -Math.abs(ey2 - y);
    let err = ex + ey;
    for (let guard = 0; guard < 400; guard++) {
      if (level16 >= 16 || ditherI(x, y, level16)) this.px(x, y, true);
      if (x === ex2 && y === ey2) break;
      const e2 = 2 * err;
      if (e2 >= ey) { err += ey; x += sx; }
      if (e2 <= ex) { err += ex; y += sy; }
    }
  }
  // Q4 polygon fill. level16 < 0: black; otherwise dither level 0..16
  fillPolyI(pts, level16) {
    const L = this.spanL, R = this.spanR, n = pts.length;
    L.fill(32767); R.fill(-32768);
    let yTop = H, yBot = -1;
    for (let i = 0; i < n; i++) {
      let ax = clampi(pts[i][0], -COORD_LIMIT, COORD_LIMIT), ay = clampi(pts[i][1], -COORD_LIMIT, COORD_LIMIT);
      let bx = clampi(pts[(i + 1) % n][0], -COORD_LIMIT, COORD_LIMIT), by = clampi(pts[(i + 1) % n][1], -COORD_LIMIT, COORD_LIMIT);
      if (ay === by) continue;
      if (ay > by) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
      const r0 = Math.max(0, ceilDiv16(ay - 8)), r1 = Math.min(H - 1, ceilDiv16(by - 8) - 1);
      if (r0 > r1) continue;
      const slope = idiv((bx - ax) * 4096, by - ay);
      let x = ax * 256 + shr((r0 * 16 + 8 - ay) * slope, 4);
      for (let y = r0; y <= r1; y++, x += slope) {
        const xi = Math.floor(x / 4096);
        if (xi < L[y]) L[y] = xi;
        if (xi > R[y]) R[y] = xi;
      }
      yTop = Math.min(yTop, r0); yBot = Math.max(yBot, r1);
    }
    for (let y = yTop; y <= yBot; y++) {
      const a = Math.max(0, L[y] + 1), b = Math.min(W - 1, R[y]);
      if (a > b) continue;
      this.stats.fillPx += b - a + 1;
      for (let x = a; x <= b; x++) this.buf[y * W + x] = level16 < 0 ? 0 : (ditherI(x, y, level16) ? 1 : 0);
    }
  }
  outlineI(pts, level16) { for (let i = 0; i < pts.length; i++) this.lineI(pts[i], pts[(i + 1) % pts.length], level16); }
  line(x0, y0, x1, y1, density = 1) {
    const q = (v) => roundEven(f32(clamp(v, -8000, 8000)) * 16);
    this.lineI([q(x0), q(y0)], [q(x1), q(y1)], ditherLevel(density));
  }

  render(c, t) {
    this.buf.fill(0);
    this.focal = c.focal; this.near = c.near;
    this.focal4 = Math.round(f32(round3(c.focal)) * 16); this.nearI = Math.floor(f32(round3(c.near)) * 65536 + 0.5);
    const st = this.stats = { boxes: 0, faces: 0, fillPx: 0, windows: 0, bbPx: 0, modelFaces: 0, rain: 0, fade: 0 };

    const poses = c.models.map((m) => modelPose(m, t));
    const cam = cameraAt(c, t, poses);
    this.lookAt(cam.eye, cam.look);
    this.camEye = cam.eye; this.camLook = cam.look;

    // Model vertices in world and camera space
    const mw = c.models.map((m, i) => poses[i] ? m.verts.map((v) => modelToWorld(m, poses[i], v)) : null);
    const mc = mw.map((vs) => vs && vs.map((v) => this.toCamI(v.map(toFx))));

    const entries = [];
    const boxCam = [];
    // Boxes
    const FAR = toFx(round3(c.far)), K13 = toFx(1.3), K08 = toFx(0.8), TWO = 2 * 65536;
    c.boxes.forEach((b, bi) => {
      const B = b.fx, cc = this.toCamI(B.centre);
      if (cc[2] + B.radius < this.nearI || cc[2] - B.radius > FAR) return;
      if (Math.abs(cc[0]) - B.radius > shr(cc[2] * K13, 16) + TWO) return;
      if (Math.abs(cc[1]) - B.radius > shr(cc[2] * K08, 16) + TWO) return;
      st.boxes++;
      const corners = [];
      for (let k = 0; k < 8; k++) corners.push(this.toCamI([(k & 1) ? B.hi[0] : B.lo[0], (k & 2) ? B.hi[1] : B.lo[1], (k & 4) ? B.hi[2] : B.lo[2]]));
      boxCam[bi] = corners;
      const e = this.eyeI;
      const vis = [e[2] < B.lo[2], e[0] > B.hi[0], e[2] > B.hi[2], e[0] < B.lo[0], e[1] > B.hi[1], e[1] < B.lo[1]];
      for (let f = 0; f < 6; f++) {
        if (!vis[f]) continue;
        let d = 0; for (const k of FACE_CORNERS[f]) d += corners[k][2] >> 2;
        entries.push({ depth: d, type: 0, obj: bi, face: f });
      }
    });
    // Billboards (one-sided)
    c.billboards.forEach((bb, i) => {
      const n = [Math.sin(bb.yaw), 0, Math.cos(bb.yaw)];
      if (dot(n, sub(this.eye, [bb.x, bb.y, bb.z])) <= 0) return;
      const q = billboardCorners(bb).map((p) => this.camI(p));
      entries.push({ depth: (q[0][2] >> 2) + (q[1][2] >> 2) + (q[2][2] >> 2) + (q[3][2] >> 2) - toFx(0.3), type: 1, obj: i, q });
    });
    // Model faces
    c.models.forEach((m, mi) => {
      if (!mw[mi]) return;
      const centre = modelToWorld(m, poses[mi], [0, 0.4, -0.2]);
      m.faces.forEach((F, fi) => {
        const wv = mw[mi];
        if (F.v.length < 3) return;
        let nrm = norm(cross(sub(wv[F.v[1]], wv[F.v[0]]), sub(wv[F.v[2]], wv[F.v[0]])));
        let fc = [0, 0, 0];
        for (const k of F.v) fc = add(fc, wv[k]);
        fc = mul(fc, 1 / F.v.length);
        if (dot(nrm, sub(fc, centre)) < 0) nrm = mul(nrm, -1);
        if (dot(nrm, sub(this.eye, fc)) <= 0) return;
        let d = 0; for (const k of F.v) d += mc[mi][k][2];
        entries.push({ depth: idiv(d, F.v.length), type: 2, obj: mi, face: fi, nrm });
      });
    });

    entries.sort((a, b) => b.depth - a.depth);   // stable, like the firmware's insertion sort
    for (const e of entries) {
      if (e.type === 0) this.drawBoxFace(c, c.boxes[e.obj], boxCam[e.obj], e, t);
      else if (e.type === 1) this.drawBillboard(c.billboards[e.obj], e.q, t);
      else {
        const m = c.models[e.obj], F = m.faces[e.face];
        const pts = this.clipProjectI(F.v.map((k) => mc[e.obj][k]));
        if (pts.length < 3) continue;
        st.modelFaces++;
        this.fillPolyI(pts, F.dark ? -1 : ditherLevel(0.12 + 0.6 * Math.max(0, dot(e.nrm, c.light))));
        this.outlineI(pts, 16);
      }
    }

    // Light strips
    for (const s of c.strips) this.drawStrip(s, t);
    // Model lights, headlights, thrusters
    c.models.forEach((m, mi) => {
      const pose = poses[mi];
      if (!pose) return;
      for (const l of m.lights) {
        let on = true;
        if (l.mode === 1 || l.mode === 2) on = (Math.floor(f32(f32(t * f32(round3(l.rate))) + f32(round3(l.phase)))) & 1) === 1;
        else if (l.mode === 3) on = (f32(f32(t * f32(round3(l.rate))) + f32(round3(l.phase))) % 1) < f32(0.15);
        if (!on) continue;
        const sp = this.screenI(modelToWorld(m, pose, l.p));
        if (!sp) continue;
        const [ix, iy] = sp;
        this.px(ix, iy, true); this.px(ix + 1, iy, true); this.px(ix, iy - 1, true);
      }
      if (!pose.powered) return;
      if (m.flags & 2) {
        for (const s of [-1, 1]) {
          const a = this.camI(modelToWorld(m, pose, [0.4 * s, 0.25, m.zFront]));
          const b = this.camI(modelToWorld(m, pose, [1.6 * s, -1.2, m.zFront + 10]));
          if (a[2] < this.nearI || b[2] < this.nearI) continue;
          this.lineI(this.projectI(a), this.projectI(b), ditherLevel(0.3));
        }
      }
      if (m.flags & 4) {
        for (let k = 0; k < 3; k++) {
          if ((Math.floor(f32(t * 30)) + k) % 3 === 0) continue;   // flicker (deterministic)
          const sp = this.screenI(modelToWorld(m, pose, [(k - 1) * 0.6, m.yMin - 0.15, -0.4 - k * 0.3]));
          if (sp) this.px(sp[0], sp[1], true);
        }
      }
    });

    // Rain: each drop's position is a pure function of time
    for (let i = 0; i < c.rainCount; i++) {
      const h = hash32(i * 7919 + 13);
      // float maths and unsigned shifts, exactly like the firmware
      const v = f32(f32(round3(c.rainSpeed)) * f32(1 + f32((h % 35) / 60))), period = H + 16;
      const y = f32(f32(f32(f32(t * v) + (h >>> 8) % 97) % period) - 10);
      const x = f32(((h >>> 4) % (W + 14)) - f32(f32(y + 10) * f32(round3(c.rainSlant))));
      this.line(x, y, f32(x + 1), f32(y - 3));
      st.rain++;
    }

    // Fade in/out
    // float maths, like the firmware
    const spanF = (v, a, b) => clamp(f32(f32(v - a) / f32(b - a)), 0, 1);
    const fin = f32(round3(c.fadeIn)), fout = f32(round3(c.fadeOut)), dur = f32(round3(c.duration));
    let f = 0;
    if (fin > 0 && t < fin) f = f32(1 - spanF(t, 0, fin));
    else if (fout > 0 && t >= f32(dur - fout)) f = spanF(t, f32(dur - fout), f32(dur - f32(0.3)));
    if (f > 0) { st.fade = 1; const f16 = f32(f * 16); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (BAYER[(y & 3) * 4 + (x & 3)] < f16) this.buf[y * W + x] = 0; }
    st.faces = entries.length;
    return this.buf;
  }

  drawBoxFace(c, b, corners, e, t) {
    const cc = FACE_CORNERS[e.face].map((k) => corners[k]);
    const pts = this.clipProjectI(cc);
    if (pts.length < 3) return;
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const [x, y] of pts) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
    if (bx1 < 0 || bx0 >= W * 16 || by1 < 0 || by0 >= H * 16) return;
    this.fillPolyI(pts, -1);
    let fog = clamp(f32(1.3 - f32(f32(e.depth / 65536) / f32(round3(c.fogDist)))), 0, 1);
    if (b.flags & 2) fog = Math.max(fog, f32(0.6));
    const fog16 = ditherLevel(fog);
    if ((b.flags & 1) && fog > 0.05) this.outlineI(pts, fog > 0.7 ? 16 : fog16);

    const N = this.nearI, allFront = cc.every((p) => p[2] >= N);
    if (e.face < 4 && fog16 > 0 && allFront && b.style !== 0 && b.win > 0) {
      const P = cc.map((p) => this.projectI(p));
      const q = (v) => f32(round3(v));
      const wdth = (e.face === 1 || e.face === 3) ? f32(q(b.z1) - q(b.z0)) : f32(q(b.x1) - q(b.x0));
      const cols = Math.max(1, Math.trunc(f32(wdth / f32(round3(c.winX))))), rows = Math.max(1, Math.trunc(f32(f32(q(b.y1) - q(b.y0)) / f32(round3(c.winY)))));
      const spanX = Math.max(Math.abs(P[1][0] - P[0][0]), Math.abs(P[2][0] - P[3][0])), spanY = Math.max(Math.abs(P[3][1] - P[0][1]), Math.abs(P[2][1] - P[1][1]));
      const sX = Math.max(32, spanX), sY = Math.max(32, spanY);
      const stepI = Math.max(1, idiv(cols * 32 + sX - 1, sX)), stepJ = Math.max(1, idiv(rows * 32 + sY - 1, sY));
      const zMin = Math.min(cc[0][2], cc[1][2], cc[2][2], cc[3][2]), zMax = Math.max(cc[0][2], cc[1][2], cc[2][2], cc[3][2]);
      const persp = zMax * 5 > zMin * 8;   // zMax > 1.6 zMin
      const id = b.seed + e.face * 7;
      for (let j = 1; j < rows; j += stepJ) {
        if (b.style === 2 && j % 3 !== 1) continue;
        if (persp) {
          const Lp = [0, 1, 2].map((k) => cc[0][k] + idiv(cc[3][k] - cc[0][k], rows) * j);
          const Rp = [0, 1, 2].map((k) => cc[1][k] + idiv(cc[2][k] - cc[1][k], rows) * j);
          const d = [0, 1, 2].map((k) => idiv(Rp[k] - Lp[k], cols));
          for (let i = 1; i < cols; i += stepI) {
            if (!windowLit(id, i, j, t, b.win)) continue;
            const sp = this.projectI([Lp[0] + d[0] * i, Lp[1] + d[1] * i, Lp[2] + d[2] * i]);
            const sx = sp[0] >> 4, sy = sp[1] >> 4;
            if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
            if (fog16 >= 16 || ditherI(sx, sy, fog16)) { this.px(sx, sy, true); this.stats.windows++; }
          }
        } else {
          const lx = P[0][0] + idiv((P[3][0] - P[0][0]) * j, rows), ly = P[0][1] + idiv((P[3][1] - P[0][1]) * j, rows);
          const rx = P[1][0] + idiv((P[2][0] - P[1][0]) * j, rows), ry = P[1][1] + idiv((P[2][1] - P[1][1]) * j, rows);
          if ((ly < -16 && ry < -16) || (ly > H * 16 && ry > H * 16)) continue;
          for (let i = 1; i < cols; i += stepI) {
            if (!windowLit(id, i, j, t, b.win)) continue;
            const sx = (lx + idiv((rx - lx) * i, cols)) >> 4, sy = (ly + idiv((ry - ly) * i, cols)) >> 4;
            if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
            if (fog16 >= 16 || ditherI(sx, sy, fog16)) { this.px(sx, sy, true); this.stats.windows++; }
          }
        }
      }
    }
  }

  drawBillboard(bb, q, t) {
    if (q.some((p) => p[2] < this.nearI)) return;
    // Screen -> texture projective map, set up in double exactly as the firmware does,
    // then integer stepping per pixel
    const Q = q.map((p) => this.projectI(p)), X = Q.map((p) => p[0] / 16), Y = Q.map((p) => p[1] / 16);
    const dx1 = X[1] - X[2], dx2 = X[3] - X[2], dx3 = X[0] - X[1] + X[2] - X[3];
    const dy1 = Y[1] - Y[2], dy2 = Y[3] - Y[2], dy3 = Y[0] - Y[1] + Y[2] - Y[3];
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-4) return;
    const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
    const a = X[1] - X[0] + g * X[1], b = X[3] - X[0] + h * X[3], cc = X[0];
    const d = Y[1] - Y[0] + g * Y[1], e = Y[3] - Y[0] + h * Y[3], f = Y[0];
    const A = e - f * h, B = cc * h - b, C = b * f - cc * e;
    const D = f * g - d, E = a - cc * g, F = cc * d - a * f;
    const G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
    const qx = Q.map((p) => p[0]), qy = Q.map((p) => p[1]);
    const x0 = Math.max(0, Math.min(...qx) >> 4), x1 = Math.min(W - 1, ceilDiv16(Math.max(...qx)));
    const y0 = Math.max(0, Math.min(...qy) >> 4), y1 = Math.min(H - 1, ceilDiv16(Math.max(...qy)));
    if (x0 > x1 || y0 > y1) return;
    let m = 0;
    for (let k = 0; k < 4; k++) {
      const px = ((k & 1) ? x1 : x0) + 0.5, py = ((k & 2) ? y1 : y0) + 0.5;
      m = Math.max(m, Math.abs(A * px + B * py + C), Math.abs(D * px + E * py + F), Math.abs(G * px + Hh * py + I));
    }
    if (!(m > 0)) return;
    let sc = 1;
    while (m * sc >= 8388608) sc *= 0.5;
    while (m * sc < 4194304) sc *= 2;
    const mx = (X[0] + X[1] + X[2] + X[3]) / 4, my = (Y[0] + Y[1] + Y[2] + Y[3]) / 4;
    if (G * mx + Hh * my + I < 0) sc = -sc;
    const toI = (v) => clamp(Math.floor(v * sc + 0.5), -1e9, 1e9);
    const fx0 = x0 + 0.5, fy0 = y0 + 0.5;
    const U0 = toI(A * fx0 + B * fy0 + C), V0 = toI(D * fx0 + E * fy0 + F), W0 = toI(G * fx0 + Hh * fy0 + I);
    const Ax = toI(A), Dx = toI(D), Gx = toI(G), By = toI(B), Ey = toI(E), Hy = toI(Hh);
    // Which frame? (float maths, like the firmware)
    let total = 0; for (const du of bb.dur) total = f32(total + f32(round3(du)));
    let ft = total > 0 ? f32(t % total) : 0, fi = 0;
    while (fi < bb.frames.length - 1 && ft >= f32(round3(bb.dur[fi]))) { ft = f32(ft - f32(round3(bb.dur[fi]))); fi++; }
    const tex = bb.frames[fi];
    const glitch = (bb.flags & 2) && (f32(t * f32(1.7)) % 4) < f32(0.12);
    const scan = (bb.flags & 1) ? Math.trunc(f32(t * 20)) % (bb.th + 10) : -100;
    for (let y = y0; y <= y1; y++) {
      let U = U0 + By * (y - y0), V = V0 + Ey * (y - y0), Wd = W0 + Hy * (y - y0);
      for (let x = x0; x <= x1; x++, U += Ax, V += Dx, Wd += Gx) {
        if (Wd <= 0 || U < 0 || U >= Wd || V < 0 || V >= Wd) continue;
        const ty = Math.trunc(V * bb.th / Wd), tx = Math.trunc(U * bb.tw / Wd) + (glitch && (Math.trunc(ty / 4) % 3) === 0 ? 3 : 0);
        this.px(x, y, tx < bb.tw && tex[ty * bb.tw + tx] === 1 && ty !== scan && ty !== scan - 1);
        this.stats.bbPx++;
      }
    }
    if (bb.flags & 4) for (let i = 0; i < 4; i++) this.lineI(Q[i], Q[(i + 1) % 4]);
  }
  drawStrip(s, t) {
    const pts = stripPoints(s);
    const chase = Math.trunc(t * s.rate) % 4;
    const blinkOn = (Math.floor(t * s.rate) & 1) === 1;
    pts.forEach((p, k) => {
      if (s.mode === 4 && k % 4 !== chase) return;
      if ((s.mode === 1 || s.mode === 2) && !blinkOn) return;
      if (s.mode === 3 && (t * s.rate) % 1 >= 0.15) return;
      const sp = this.screenI(p);
      if (sp) this.px(sp[0], sp[1], true);
    });
  }
}

// faces: -z, +x, +z, -x, top, bottom (bottom only shows when the camera is below the box)
export const FACE_CORNERS = [[0, 1, 3, 2], [1, 5, 7, 3], [5, 4, 6, 7], [4, 0, 2, 6], [2, 3, 7, 6], [4, 5, 1, 0]];

export function billboardCorners(bb) {
  const r = [-Math.cos(bb.yaw), 0, Math.sin(bb.yaw)], c = [bb.x, bb.y, bb.z];
  const hw = bb.w / 2, hh = bb.h / 2;
  return [add(add(c, mul(r, -hw)), [0, hh, 0]), add(add(c, mul(r, hw)), [0, hh, 0]), add(add(c, mul(r, hw)), [0, -hh, 0]), add(add(c, mul(r, -hw)), [0, -hh, 0])];
}

export function stripPoints(s) {
  const pts = [];
  const along = (a, b) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(1, Math.floor(len / s.spacing));
    for (let i = 0; i < n; i++) pts.push(lerp3(a, b, i / n));
  };
  if (s.shape === 1) {
    const y = s.a[1], [x0, z0, x1, z1] = [s.a[0], s.a[2], s.b[0], s.b[2]];
    along([x0, y, z0], [x1, y, z0]); along([x1, y, z0], [x1, y, z1]); along([x1, y, z1], [x0, y, z1]); along([x0, y, z1], [x0, y, z0]);
  } else { along(s.a, s.b); pts.push(s.b); }
  return pts;
}

export function hash32(n) {
  let h = Math.imul(n | 0, 2654435761) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return h >>> 0;
}

function windowLit(id, i, j, t, density) {
  let h = (Math.imul(id & 0xffff, 2654435761) ^ (i * 97 + j * 131)) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  let lit = (h & 255) < density;
  if (((h >>> 8) & 255) < 20 && (Math.trunc(f32(f32(t * 6) + (h >>> 16))) % 9) === 0) lit = !lit;   // float maths, like the firmware
  return lit;
}

// ---------- performance estimate (calibrated against the board's timing reports) ----------
export function estimateMs(st) {
  return 7 + 0.08 * st.boxes + 0.16 * st.faces + 0.0012 * st.fillPx + 0.012 * st.windows + 0.02 * st.bbPx + 0.35 * st.modelFaces + 0.03 * st.rain + (st.fade ? 1.5 : 0);
}

// ---------- pack a frame for live streaming (SSD1306 page format) ----------
export function packFrame(buf) {
  const p = new Uint8Array(2 + 360);
  p[0] = 0xA5; p[1] = 0x5A;
  for (let page = 0; page < 5; page++) for (let x = 0; x < W; x++) {
    let b = 0;
    for (let bit = 0; bit < 8; bit++) if (buf[(page * 8 + bit) * W + x]) b |= 1 << bit;
    p[2 + page * W + x] = b;
  }
  return p;
}
