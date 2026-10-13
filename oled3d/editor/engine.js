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
  }
  toCam(p) { const d = sub(p, this.eye); return [dot(d, this.r), dot(d, this.u), dot(d, this.f)]; }
  project(c) { return [W / 2 + this.focal * c[0] / c[2], H / 2 - this.focal * c[1] / c[2]]; }

  line(x0, y0, x1, y1, density = 1) {
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const inside = x0 >= 0 && x0 <= W - 1 && x1 >= 0 && x1 <= W - 1 && y0 >= 0 && y0 <= H - 1 && y1 >= 0 && y1 <= H - 1;
    if (!inside) {
      const p = [-dx, dx, -dy, dy], q = [x0, W - 1 - x0, y0, H - 1 - y0];
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return; if (r > t0) t0 = r; } else { if (r < t0) return; if (r < t1) t1 = r; }
      }
    }
    let ax = Math.round(x0 + dx * t0), ay = Math.round(y0 + dy * t0);
    const bx = Math.round(x0 + dx * t1), by = Math.round(y0 + dy * t1);
    const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1, ex = Math.abs(bx - ax), ey = -Math.abs(by - ay);
    let err = ex + ey;
    for (let guard = 0; guard < 400; guard++) {
      if (density >= 1 || dither(ax, ay, density)) this.px(ax, ay, true);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= ey) { err += ey; ax += sx; }
      if (e2 <= ex) { err += ex; ay += sy; }
    }
  }

  clipProject(poly) {
    const out = [], n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n], ia = a[2] >= this.near, ib = b[2] >= this.near;
      if (ia) out.push(a);
      if (ia !== ib) out.push(lerp3(a, b, (this.near - a[2]) / (b[2] - a[2])));
    }
    return out.map((p) => this.project(p));
  }

  // 16.16 fixed-point scanline fill (same as firmware). shade < 0: black.
  fillPoly(pts, shade) {
    const L = this.spanL, R = this.spanR;
    L.fill(32767); R.fill(-32768);
    let yTop = H, yBot = -1;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      let [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
      ax = clamp(ax, -8000, 8000); ay = clamp(ay, -8000, 8000); bx = clamp(bx, -8000, 8000); by = clamp(by, -8000, 8000);
      if (ay === by) continue;
      if (ay > by) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
      const r0 = Math.max(0, Math.ceil(ay - 0.5)), r1 = Math.min(H - 1, Math.ceil(by - 0.5) - 1);
      if (r0 > r1) continue;
      const slope = (bx - ax) / (by - ay);
      let x = Math.trunc((ax + (r0 + 0.5 - ay) * slope) * 65536) | 0;
      const dx = Math.trunc(slope * 65536) | 0;
      for (let y = r0; y <= r1; y++, x = (x + dx) | 0) {
        const xi = x >> 16;
        if (xi < L[y]) L[y] = xi;
        if (xi > R[y]) R[y] = xi;
      }
      yTop = Math.min(yTop, r0); yBot = Math.max(yBot, r1);
    }
    for (let y = yTop; y <= yBot; y++) {
      const a = Math.max(0, L[y] + 1), b = Math.min(W - 1, R[y]);
      if (a > b) continue;
      this.stats.fillPx += b - a + 1;
      for (let x = a; x <= b; x++) this.buf[y * W + x] = shade < 0 ? 0 : (dither(x, y, shade) ? 1 : 0);
    }
  }
  outline(pts, density) { for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; this.line(a[0], a[1], b[0], b[1], density); } }

  render(c, t) {
    this.buf.fill(0);
    this.focal = c.focal; this.near = c.near;
    const st = this.stats = { boxes: 0, faces: 0, fillPx: 0, windows: 0, bbPx: 0, modelFaces: 0, rain: 0, fade: 0 };

    const poses = c.models.map((m) => modelPose(m, t));
    const cam = cameraAt(c, t, poses);
    this.lookAt(cam.eye, cam.look);
    this.camEye = cam.eye; this.camLook = cam.look;

    // Model vertices in world and camera space
    const mw = c.models.map((m, i) => poses[i] ? m.verts.map((v) => modelToWorld(m, poses[i], v)) : null);
    const mc = mw.map((vs) => vs && vs.map((v) => this.toCam(v)));

    const entries = [];
    const boxCam = [];
    // Boxes
    c.boxes.forEach((b, bi) => {
      const centre = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];
      const cc = this.toCam(centre);
      const radius = Math.max(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0) * 0.8;
      if (cc[2] + radius < c.near || cc[2] - radius > c.far) return;
      if (Math.abs(cc[0]) - radius > cc[2] * 1.3 + 2) return;
      if (Math.abs(cc[1]) - radius > cc[2] * 0.8 + 2) return;
      st.boxes++;
      const corners = [];
      for (let k = 0; k < 8; k++) corners.push(this.toCam([(k & 1) ? b.x1 : b.x0, (k & 2) ? b.y1 : b.y0, (k & 4) ? b.z1 : b.z0]));
      boxCam[bi] = corners;
      const e = this.eye;
      const vis = [e[2] < b.z0, e[0] > b.x1, e[2] > b.z1, e[0] < b.x0, e[1] > b.y1, e[1] < b.y0];
      for (let f = 0; f < 6; f++) {
        if (!vis[f]) continue;
        let d = 0; for (const k of FACE_CORNERS[f]) d += corners[k][2];
        entries.push({ depth: d / 4, type: 0, obj: bi, face: f });
      }
    });
    // Billboards (one-sided)
    c.billboards.forEach((bb, i) => {
      const n = [Math.sin(bb.yaw), 0, Math.cos(bb.yaw)];
      if (dot(n, sub(this.eye, [bb.x, bb.y, bb.z])) <= 0) return;
      const q = billboardCorners(bb).map((p) => this.toCam(p));
      entries.push({ depth: (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4 - 0.3, type: 1, obj: i, q });
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
        entries.push({ depth: d / F.v.length, type: 2, obj: mi, face: fi, nrm });
      });
    });

    entries.sort((a, b) => b.depth - a.depth);
    for (const e of entries) {
      if (e.type === 0) this.drawBoxFace(c, c.boxes[e.obj], boxCam[e.obj], e, t);
      else if (e.type === 1) this.drawBillboard(c.billboards[e.obj], e.q, t);
      else {
        const m = c.models[e.obj], F = m.faces[e.face];
        const pts = this.clipProject(F.v.map((k) => mc[e.obj][k]));
        if (pts.length < 3) continue;
        st.modelFaces++;
        this.fillPoly(pts, F.dark ? -1 : 0.12 + 0.6 * Math.max(0, dot(e.nrm, c.light)));
        this.outline(pts, 1);
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
        if (l.mode === 1 || l.mode === 2) on = (Math.floor(t * l.rate + l.phase) & 1) === 1;
        else if (l.mode === 3) on = ((t * l.rate + l.phase) % 1) < 0.15;
        if (!on) continue;
        const cc = this.toCam(modelToWorld(m, pose, l.p));
        if (cc[2] < c.near) continue;
        const [sx, sy] = this.project(cc), ix = Math.trunc(sx), iy = Math.trunc(sy);
        this.px(ix, iy, true); this.px(ix + 1, iy, true); this.px(ix, iy - 1, true);
      }
      if (!pose.powered) return;
      if (m.flags & 2) {
        for (const s of [-1, 1]) {
          const a = this.toCam(modelToWorld(m, pose, [0.4 * s, 0.25, m.zFront]));
          const b = this.toCam(modelToWorld(m, pose, [1.6 * s, -1.2, m.zFront + 10]));
          if (a[2] < c.near || b[2] < c.near) continue;
          const [ax, ay] = this.project(a), [bx, by] = this.project(b);
          this.line(ax, ay, bx, by, 0.3);
        }
      }
      if (m.flags & 4) {
        for (let k = 0; k < 3; k++) {
          if ((Math.floor(t * 30) + k) % 3 === 0) continue;   // flicker (deterministic)
          const cc = this.toCam(modelToWorld(m, pose, [(k - 1) * 0.6, m.yMin - 0.15, -0.4 - k * 0.3]));
          if (cc[2] < c.near) continue;
          const [sx, sy] = this.project(cc);
          this.px(Math.trunc(sx), Math.trunc(sy), true);
        }
      }
    });

    // Rain: each drop's position is a pure function of time
    for (let i = 0; i < c.rainCount; i++) {
      const h = hash32(i * 7919 + 13);
      const v = c.rainSpeed * (1 + (h % 35) / 60), period = H + 16;
      const y = ((t * v + (h >> 8) % 97) % period) - 10;
      const x = ((h >> 4) % (W + 14)) - (y + 10) * c.rainSlant;
      this.line(x, y, x + 1, y - 3);
      st.rain++;
    }

    // Fade in/out
    let f = 0;
    if (c.fadeIn > 0 && t < c.fadeIn) f = 1 - span(t, 0, c.fadeIn);
    else if (c.fadeOut > 0 && t >= c.duration - c.fadeOut) f = span(t, c.duration - c.fadeOut, c.duration - 0.3);
    if (f > 0) { st.fade = 1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (BAYER[(y & 3) * 4 + (x & 3)] < f * 16) this.buf[y * W + x] = 0; }
    st.faces = entries.length;
    return this.buf;
  }

  drawBoxFace(c, b, corners, e, t) {
    const cc = FACE_CORNERS[e.face].map((k) => corners[k]);
    const pts = this.clipProject(cc);
    if (pts.length < 3) return;
    let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (const [x, y] of pts) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
    if (bx1 < 0 || bx0 >= W || by1 < 0 || by0 >= H) return;
    this.fillPoly(pts, -1);
    let fog = clamp(1.3 - e.depth / c.fogDist, 0, 1);
    if (b.flags & 2) fog = Math.max(fog, 0.6);
    if ((b.flags & 1) && fog > 0.05) this.outline(pts, fog > 0.7 ? 1 : fog);

    const allFront = cc.every((p) => p[2] >= c.near);
    if (e.face < 4 && fog > 0 && allFront && b.style !== 0 && b.win > 0) {
      const P = cc.map((p) => this.project(p));
      const wdth = (e.face === 1 || e.face === 3) ? b.z1 - b.z0 : b.x1 - b.x0;
      const cols = Math.max(1, Math.trunc(wdth / c.winX)), rows = Math.max(1, Math.trunc((b.y1 - b.y0) / c.winY));
      const spanX = Math.max(Math.abs(P[1][0] - P[0][0]), Math.abs(P[2][0] - P[3][0]));
      const spanY = Math.max(Math.abs(P[3][1] - P[0][1]), Math.abs(P[2][1] - P[1][1]));
      const stepI = Math.max(1, Math.ceil(cols / Math.max(1, spanX / 2))), stepJ = Math.max(1, Math.ceil(rows / Math.max(1, spanY / 2)));
      // Strongly foreshortened faces (seen at a steep angle) need perspective-correct
      // placement; otherwise blending the projected corners is cheaper and close enough.
      const zMin = Math.min(cc[0][2], cc[1][2], cc[2][2], cc[3][2]), zMax = Math.max(cc[0][2], cc[1][2], cc[2][2], cc[3][2]);
      const persp = zMax > zMin * 1.6;
      for (let j = 1; j < rows; j += stepJ) {
        if (b.style === 2 && j % 3 !== 1) continue;
        const v = j / rows;
        const lx = P[0][0] + (P[3][0] - P[0][0]) * v, ly = P[0][1] + (P[3][1] - P[0][1]) * v;
        const rx = P[1][0] + (P[2][0] - P[1][0]) * v, ry = P[1][1] + (P[2][1] - P[1][1]) * v;
        if (!persp && ((ly < -1 && ry < -1) || (ly > H && ry > H))) continue;
        for (let i = 1; i < cols; i += stepI) {
          if (!windowLit(b.seed + e.face * 7, i, j, t, b.win)) continue;
          const u = i / cols;
          let sx, sy;
          if (persp) {
            const q = [0, 1, 2].map((k) => cc[0][k] + (cc[1][k] - cc[0][k]) * u + (cc[3][k] - cc[0][k]) * v);
            [sx, sy] = this.project(q); sx = Math.trunc(sx); sy = Math.trunc(sy);
          } else { sx = Math.trunc(lx + (rx - lx) * u); sy = Math.trunc(ly + (ry - ly) * u); }
          if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
          if (fog >= 1 || dither(sx, sy, fog)) { this.px(sx, sy, true); this.stats.windows++; }
        }
      }
    }
  }

  drawBillboard(bb, q, t) {
    if (q.some((p) => p[2] < this.near)) return;
    const P = q.map((p) => this.project(p)), X = P.map((p) => p[0]), Y = P.map((p) => p[1]);
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
    const x0 = Math.max(0, Math.floor(Math.min(...X))), x1 = Math.min(W - 1, Math.ceil(Math.max(...X)));
    const y0 = Math.max(0, Math.floor(Math.min(...Y))), y1 = Math.min(H - 1, Math.ceil(Math.max(...Y)));
    // Which frame?
    let total = 0; for (const du of bb.dur) total += du;
    let ft = total > 0 ? t % total : 0, fi = 0;
    while (fi < bb.frames.length - 1 && ft >= bb.dur[fi]) { ft -= bb.dur[fi]; fi++; }
    const tex = bb.frames[fi];
    const glitch = (bb.flags & 2) && ((t * 1.7) % 4) < 0.12;
    const scan = (bb.flags & 1) ? Math.trunc(t * 20) % (bb.th + 10) : -100;
    for (let y = y0; y <= y1; y++) {
      const fy = y + 0.5, fx = x0 + 0.5;
      let U = A * fx + B * fy + C, V = D * fx + E * fy + F, Wd = G * fx + Hh * fy + I;
      for (let x = x0; x <= x1; x++, U += A, V += D, Wd += G) {
        if (Math.abs(Wd) < 1e-6) continue;
        const inv = 1 / Wd, u = U * inv, v = V * inv;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const ty = Math.trunc(v * bb.th), tx = Math.trunc(u * bb.tw) + (glitch && (Math.trunc(ty / 4) % 3) === 0 ? 3 : 0);
        this.px(x, y, tx < bb.tw && tex[ty * bb.tw + tx] === 1 && ty !== scan && ty !== scan - 1);
        this.stats.bbPx++;
      }
    }
    if (bb.flags & 4) for (let i = 0; i < 4; i++) this.line(X[i], Y[i], X[(i + 1) % 4], Y[(i + 1) % 4]);
  }

  drawStrip(s, t) {
    const pts = stripPoints(s);
    const chase = Math.trunc(t * s.rate) % 4;
    const blinkOn = (Math.floor(t * s.rate) & 1) === 1;
    pts.forEach((p, k) => {
      if (s.mode === 4 && k % 4 !== chase) return;
      if ((s.mode === 1 || s.mode === 2) && !blinkOn) return;
      if (s.mode === 3 && (t * s.rate) % 1 >= 0.15) return;
      const cc = this.toCam(p);
      if (cc[2] < this.near) return;
      const [sx, sy] = this.project(cc);
      this.px(Math.trunc(sx), Math.trunc(sy), true);
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
  if (((h >>> 8) & 255) < 20 && (Math.trunc(t * 6 + (h >>> 16)) % 9) === 0) lit = !lit;
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
