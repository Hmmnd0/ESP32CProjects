// Editor tools: image/text -> 1-bit textures, OBJ import, street generator.

// ---------- images ----------
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// Convert grey values (0..255, length w*h) to 1-bit with the chosen dither.
export function ditherGray(gray, w, h, { method = 'atkinson', brightness = 0, contrast = 1, invert = false } = {}) {
  const g = Float32Array.from(gray, (v) => {
    let x = (v - 128) * contrast + 128 + brightness * 1.28;
    if (invert) x = 255 - x;
    return Math.max(0, Math.min(255, x));
  });
  const out = new Uint8Array(w * h);
  if (method === 'threshold' || method === 'bayer') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = method === 'bayer' ? (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) * 16 : 128;
      out[y * w + x] = g[y * w + x] > t ? 1 : 0;
    }
    return out;
  }
  const spread = method === 'floyd'
    ? [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
    : [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, on = g[i] >= 128 ? 1 : 0, err = g[i] - (on ? 255 : 0);
    out[i] = on;
    for (const [dx, dy, wt] of spread) { const nx = x + dx, ny = y + dy; if (nx >= 0 && nx < w && ny < h) g[ny * w + nx] += err * wt; }
  }
  return out;
}

export function imageToGray(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  // cover-fit the image into w x h
  const s = Math.max(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
  x.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const d = x.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
}

export function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not read that image'));
    img.src = url;
  });
}

// Text sign: crisp pixel text, optionally vertical (one character per line)
export function textToBits(text, w, h, { vertical = false, bold = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  const chars = [...text];
  const lines = vertical ? chars : [text];
  let size = Math.floor(h / lines.length);
  const fit = () => { x.font = `${bold ? 'bold ' : ''}${size}px "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`; return Math.max(...lines.map((l) => x.measureText(l).width)); };
  while (size > 5 && fit() > w - 1) size--;
  lines.forEach((l, i) => x.fillText(l, w / 2, (i + 0.5) * (h / lines.length) + 0.5));
  const d = x.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i * 4] > 110 ? 1 : 0;
  return out;
}

// ---------- OBJ import ----------
// Faces with more than 4 corners are split into a fan. Materials whose name
// suggests glass/dark become solid-black faces.
export function parseOBJ(text, { size = 4 } = {}) {
  const verts = [], faces = [];
  let dark = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) { const [, x, y, z] = line.split(/\s+/); verts.push([+x, +y, +z]); }
    else if (line.startsWith('usemtl')) dark = /glass|dark|window|black|tint/i.test(line);
    else if (line.startsWith('f ')) {
      const idx = line.split(/\s+/).slice(1).map((p) => { const i = parseInt(p.split('/')[0], 10); return i < 0 ? verts.length + i : i - 1; });
      const style = dark ? 'dark' : 'shaded';
      if (idx.length <= 4) faces.push({ v: idx, style });
      else for (let k = 1; k < idx.length - 1; k++) faces.push({ v: [idx[0], idx[k], idx[k + 1]], style });
    }
  }
  if (!verts.length || !faces.length) throw new Error('No geometry found in that file');
  if (verts.length > 255) throw new Error(`That model has ${verts.length} vertices; the engine allows 255. Decimate it in Blender (Modifiers → Decimate) and export again.`);
  // centre it and scale so the largest side is `size`
  const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const v of verts) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], v[i]); max[i] = Math.max(max[i], v[i]); }
  const c = min.map((m, i) => (m + max[i]) / 2), s = size / Math.max(1e-6, ...max.map((m, i) => m - min[i]));
  // Blender's OBJ export (Forward -Z, Up Y) is right-handed with the front at -Z.
  // The engine is left-handed with the nose at +Z, so flipping z converts both at once.
  const out = verts.map((v) => [(v[0] - c[0]) * s, (v[1] - c[1]) * s, -(v[2] - c[2]) * s].map((n) => Math.round(n * 1000) / 1000));
  return { verts: out, faces: faces.slice(0, 160), truncated: faces.length > 160, faceCount: faces.length };
}

// ---------- street generator ----------
export function generateStreet(p, nextId) {
  let seed = p.seed | 0 || 1;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rr = (a, b) => a + rnd() * (b - a);
  const boxes = [];
  const sides = p.sides === 'both' ? [-1, 1] : p.sides === 'left' ? [-1] : [1];
  const make = (side, inner, width, z, d, h, group) => {
    const x0 = side < 0 ? p.centerX - inner - width : p.centerX + inner, x1 = x0 + width;
    boxes.push({ id: nextId(), type: 'box', name: group, group, x0: r1(x0), x1: r1(x1), y0: 0, y1: r1(h), z0: r1(z), z1: r1(z + d),
      windows: p.windows, winStyle: 'grid', edges: true, bright: false, seed: Math.floor(rnd() * 256) });
  };
  for (const side of sides) {
    for (let z = p.z0; z < p.z0 + p.length;) {
      const d = rr(p.depthMin, p.depthMax), h = rr(p.heightMin, p.heightMax) * (rnd() < 0.2 ? 1.6 : 1);
      make(side, p.inner + rr(0, 2), rr(8, 14), z, d, h, p.group);
      z += d + rr(p.gapMin, p.gapMax);
    }
    if (p.backRow) for (let z = p.z0 + 10; z < p.z0 + p.length;) {
      const d = rr(10, 20), h = rr(p.heightMax * 0.8, p.heightMax * 1.7);
      make(side, p.inner + 18 + rr(0, 6), rr(10, 18), z, d, h, p.group + ' (back)');
      z += d + rr(3, 9);
    }
  }
  return boxes;
}
const r1 = (v) => Math.round(v * 10) / 10;
