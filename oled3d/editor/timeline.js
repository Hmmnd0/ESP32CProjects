// Timeline: ruler, playhead, keyframe rows (camera + each model), and a cost
// graph of the estimated board frame time along the loop.
const LABEL_W = 120, RULER_H = 22, ROW_H = 24;

export function createTimeline(canvas, api) {
  const ctx = canvas.getContext('2d');
  let drag = null;   // { kind: 'scrub' } | { kind: 'key', row, key, t0, x0 }
  let hover = null;

  function rows() {
    const scene = api.getScene();
    const r = [{ id: 'camera', name: 'Camera', keys: scene.camera.keys }];
    for (const o of scene.objects) if (o.type === 'model') r.push({ id: o.id, name: o.name, keys: o.keys });
    return r;
  }
  const tToX = (t) => LABEL_W + (t / api.getScene().duration) * (canvas.clientWidth - LABEL_W - 12);
  const xToT = (x) => Math.max(0, Math.min(api.getScene().duration, ((x - LABEL_W) / (canvas.clientWidth - LABEL_W - 12)) * api.getScene().duration));

  function draw() {
    if (!api.getScene()) return;   // not loaded yet
    const dpr = devicePixelRatio, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#15181d'; ctx.fillRect(0, 0, w, h);
    const scene = api.getScene(), dur = scene.duration, sel = api.getSelection();

    // Cost graph behind everything: estimated board fps along the timeline
    const cost = api.getCostGraph();
    if (cost?.length) {
      const top = RULER_H, bottom = h;
      for (let i = 0; i < cost.length; i++) {
        const { t, fps } = cost[i];
        const x0 = tToX(t), x1 = tToX(Math.min(dur, t + (cost[1]?.t - cost[0]?.t || 0.25)));
        const frac = Math.min(1, fps / 40);
        ctx.fillStyle = fps < 12 ? 'rgba(229,96,79,0.22)' : fps < 20 ? 'rgba(232,176,74,0.18)' : 'rgba(139,212,80,0.10)';
        ctx.fillRect(x0, bottom - (bottom - top) * frac, Math.max(1, x1 - x0), (bottom - top) * frac);
      }
    }

    // Ruler
    ctx.fillStyle = '#1d2026'; ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = '#8a9099'; ctx.font = '11px system-ui'; ctx.textBaseline = 'middle';
    const step = dur > 40 ? 5 : dur > 15 ? 2 : 1;
    for (let s = 0; s <= dur + 1e-6; s += step / 2) {
      const x = tToX(s), major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
      ctx.fillRect(x, major ? 12 : 16, 1, RULER_H - (major ? 12 : 16));
      if (major) ctx.fillText(s + 's', x + 3, 8);
    }

    // Rows
    rows().forEach((row, ri) => {
      const y = RULER_H + ri * ROW_H;
      ctx.fillStyle = ri % 2 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, y, w, ROW_H);
      const rowSelected = (row.id === 'camera' && sel.kind === 'camera') || (sel.kind === 'object' && sel.id === row.id);
      ctx.fillStyle = rowSelected ? '#e6e8eb' : '#8a9099';
      ctx.fillText(row.name.slice(0, 16), 10, y + ROW_H / 2);
      // span line between first and last key
      if (row.keys.length > 1) {
        const ts = row.keys.map((k) => k.t);
        ctx.fillStyle = row.id === 'camera' ? 'rgba(232,176,74,0.35)' : 'rgba(74,144,217,0.35)';
        ctx.fillRect(tToX(Math.min(...ts)), y + ROW_H / 2 - 1, tToX(Math.max(...ts)) - tToX(Math.min(...ts)), 2);
      }
      row.keys.forEach((k, ki) => {
        const x = tToX(k.t), cy = y + ROW_H / 2;
        const isSel = rowSelected && sel.key === ki;
        ctx.fillStyle = isSel ? '#ffffff' : row.id === 'camera' ? (k.mode === 'follow' ? '#b88a2e' : '#e8b04a') : '#4a90d9';
        ctx.beginPath(); ctx.moveTo(x, cy - 6); ctx.lineTo(x + 6, cy); ctx.lineTo(x, cy + 6); ctx.lineTo(x - 6, cy); ctx.closePath(); ctx.fill();
        if (hover && hover.row === ri && hover.key === ki) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
      });
    });

    // Playhead
    const px = tToX(api.getTime());
    ctx.fillStyle = '#e5604f'; ctx.fillRect(px - 0.5, 0, 1.5, h);
    ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7); ctx.fill();
  }

  function hit(x, y) {
    if (y < RULER_H) return { kind: 'ruler' };
    const ri = Math.floor((y - RULER_H) / ROW_H), rs = rows();
    if (ri < 0 || ri >= rs.length) return { kind: 'empty' };
    const row = rs[ri];
    for (let ki = row.keys.length - 1; ki >= 0; ki--) if (Math.abs(tToX(row.keys[ki].t) - x) <= 7) return { kind: 'key', row: ri, key: ki, rowId: row.id };
    return { kind: 'row', row: ri, rowId: row.id };
  }

  function selectRowKey(rowId, key) {
    if (rowId === 'camera') api.select({ kind: 'camera', key });
    else api.select({ kind: 'object', id: rowId, key });
  }

  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const hi = hit(x, y);
    canvas.setPointerCapture(e.pointerId);
    if (hi.kind === 'key') {
      selectRowKey(hi.rowId, hi.key);
      const keys = rows()[hi.row].keys;
      drag = { kind: 'key', rowId: hi.rowId, key: keys[hi.key], x0: x, t0: keys[hi.key].t, started: false };
      api.setTime(keys[hi.key].t);
    } else {
      if (hi.kind === 'row' && x < LABEL_W) selectRowKey(hi.rowId, null);
      drag = { kind: 'scrub' };
      if (x >= LABEL_W) api.setTime(xToT(x));
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (!drag) { const hi = hit(x, y); hover = hi.kind === 'key' ? hi : null; canvas.style.cursor = hi.kind === 'key' ? 'ew-resize' : 'default'; draw(); return; }
    if (drag.kind === 'scrub') { api.setTime(xToT(x)); return; }
    if (drag.kind === 'key') {
      if (!drag.started && Math.abs(x - drag.x0) < 3) return;
      if (!drag.started) { drag.started = true; api.beginEdit(); }
      const t = Math.round(xToT(x) * 20) / 20;
      api.liveEdit(() => { drag.key.t = t; });
      api.setTime(t);
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (drag?.kind === 'key' && drag.started) {
      // keep keys sorted, and keep the moved key selected
      api.liveEdit((s) => {
        const list = drag.rowId === 'camera' ? s.camera.keys : s.objects.find((o) => o.id === drag.rowId).keys;
        list.sort((a, b) => a.t - b.t);
        selectRowKey(drag.rowId, list.indexOf(drag.key));
      });
      api.commitEdit();
    }
    drag = null;
  });
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const hi = hit(x, y);
    if (hi.kind === 'row' && x >= LABEL_W) api.addKey(hi.rowId, Math.round(xToT(x) * 20) / 20);
  });
  new ResizeObserver(draw).observe(canvas);

  return { draw, height: (n) => RULER_H + n * ROW_H + 8, rowCount: () => rows().length };
}
