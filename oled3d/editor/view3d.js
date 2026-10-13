// The editor's 3D scene view (three.js). Engine coordinates have x pointing
// the other way from three.js, so x is mirrored on the way in and out.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { modelPose, modelToWorld, cameraAt, billboardCorners, stripPoints, decodeBits } from './engine.js';

const T = (v) => new THREE.Vector3(-v[0], v[1], v[2]);
const F = (v) => [-v.x, v.y, v.z];
const DEG = Math.PI / 180;

export function createView3D(el, api) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  el.appendChild(renderer.domElement);
  const scene3 = new THREE.Scene();
  scene3.background = new THREE.Color(0x0d0f13);
  scene3.fog = new THREE.Fog(0x0d0f13, 250, 900);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
  camera.position.set(-90, 120, -80);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 20, 120);
  orbit.enableDamping = true;
  // Right button is for flying (see below); pan with the middle button
  orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: -1 };
  orbit.update();
  camera.layers.enable(1);   // layer 1 = solid surfaces, shown only in the 3D view
  const solid = (o) => { o.layers.set(1); return o; };

  scene3.add(new THREE.HemisphereLight(0xbfd4ff, 0x202530, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(80, 160, -60);
  scene3.add(sun);
  const grid = new THREE.GridHelper(1000, 100, 0x2c3340, 0x1b2029);
  grid.position.z = 200;
  solid(grid);
  scene3.add(grid);

  // ---------- axis indicator (top-right corner) ----------
  // Shows the ENGINE's axes (x is mirrored in this view), turning with the camera.
  // Click a ball to look along that axis.
  const AXIS_PX = 96, AXIS_PAD = 8;
  const axisScene = new THREE.Scene();
  const axisCam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);
  const axisBalls = [];
  function labelSprite(text, color, r) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = color;
    x.beginPath(); x.arc(32, 32, 30, 0, Math.PI * 2); x.fill();
    if (text) { x.fillStyle = '#111317'; x.font = 'bold 34px system-ui'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 32, 34); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.scale.set(r, r, r);
    return sp;
  }
  for (const [name, engineDir, color] of [['X', [1, 0, 0], '#e5604f'], ['Y', [0, 1, 0], '#8bd450'], ['Z', [0, 0, 1], '#4a90d9']]) {
    const dir = T(engineDir);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(0.95)]), new THREE.LineBasicMaterial({ color, depthTest: false }));
    axisScene.add(line);
    const pos = labelSprite(name, color, 0.62);
    pos.position.copy(dir.clone().multiplyScalar(1.15));
    pos.userData = { engineDir, viewDir: dir };
    const neg = labelSprite('', color + '77', 0.36);
    neg.position.copy(dir.clone().multiplyScalar(-1.15));
    neg.userData = { engineDir: engineDir.map((v) => -v), viewDir: dir.clone().negate() };
    axisScene.add(pos, neg);
    axisBalls.push(pos, neg);
  }
  const axisBg = new THREE.Mesh(new THREE.CircleGeometry(1.62, 40), new THREE.MeshBasicMaterial({ color: 0x1b1f26, transparent: true, opacity: 0.75, depthTest: false }));
  axisBg.renderOrder = -1;
  axisScene.add(axisBg);

  function axisRect() {
    const r = rects().v3d, size = Math.min(AXIS_PX, r.w / 3, r.h / 3);
    return { x: r.x + r.w - size - AXIS_PAD, y: r.y + AXIS_PAD, size };
  }
  function renderAxes() {
    axisCam.position.set(0, 0, 5).applyQuaternion(camera.quaternion);
    axisCam.quaternion.copy(camera.quaternion);
    axisBg.quaternion.copy(camera.quaternion);
    // nearer balls drawn on top
    for (const b of axisBalls) b.renderOrder = Math.round(b.position.clone().applyQuaternion(camera.quaternion.clone().invert()).z * 10) + 10;
    const r = axisRect(), h = el.clientHeight;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setScissor(r.x, h - r.y - r.size, r.size, r.size);
    renderer.setViewport(r.x, h - r.y - r.size, r.size, r.size);
    renderer.render(axisScene, axisCam);
    renderer.setScissorTest(false);
    renderer.autoClear = true;
  }
  // Returns true if the click was on the indicator (and handles it)
  function axisClick(e) {
    const b = renderer.domElement.getBoundingClientRect(), r = axisRect();
    const lx = e.clientX - b.left - r.x, ly = e.clientY - b.top - r.y;
    if (lx < 0 || ly < 0 || lx > r.size || ly > r.size) return false;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((lx / r.size) * 2 - 1, -(ly / r.size) * 2 + 1), axisCam);
    const hit = rc.intersectObjects(axisBalls)[0];
    if (hit && !lookThrough) {
      const dist = camera.position.distanceTo(orbit.target);
      const d = hit.object.userData.viewDir.clone();
      if (Math.abs(d.y) > 0.99) d.z += 0.001;   // avoid looking exactly straight up/down
      camera.position.copy(orbit.target.clone().add(d.normalize().multiplyScalar(dist)));
      orbit.update();
    }
    return true;
  }

  // ---------- fly mode (Hammer / Unreal style) ----------
  // Hold the right mouse button: mouse looks, WASD flies, Q/E down/up, Shift fast,
  // scroll changes speed. Or press Z to toggle it with the pointer captured.
  const fly = { active: false, locked: false, yaw: 0, pitch: 0, keys: new Set(), speed: 30, last: 0 };
  const flyHud = document.createElement('div');
  flyHud.style.cssText = 'position:absolute;left:50%;bottom:34px;transform:translateX(-50%);max-width:calc(100% - 20px);text-align:center;background:rgba(20,23,28,.85);border:1px solid #3a414c;border-radius:6px;padding:5px 10px;font-size:12px;color:#e6e8eb;z-index:3;display:none;pointer-events:none;';
  el.appendChild(flyHud);
  const flyFwd = () => new THREE.Vector3(Math.sin(fly.yaw) * Math.cos(fly.pitch), Math.sin(fly.pitch), Math.cos(fly.yaw) * Math.cos(fly.pitch));
  function showFlyHud() {
    flyHud.textContent = `✈ WASD · Q/E · Shift · speed ${Math.round(fly.speed)} · ${fly.locked ? 'Z/Esc: stop' : 'release to stop'}`;
    flyHud.style.display = fly.active ? 'block' : 'none';
  }
  function startFly(locked) {
    if (lookThrough || fly.active) return;
    const d = orbit.target.clone().sub(camera.position).normalize();
    fly.yaw = Math.atan2(d.x, d.z);
    fly.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    fly.active = true; fly.locked = locked; fly.last = performance.now();
    orbit.enabled = false;
    gizmo.enabled = false;
    fly.hasLock = false;
    if (locked) {
      // Some browsers/embeds refuse pointer lock; then plain mouse movement steers instead
      try { renderer.domElement.requestPointerLock()?.catch?.(() => {}); } catch {}
    }
    showFlyHud();
  }
  function stopFly() {
    if (!fly.active) return;
    fly.active = false; fly.keys.clear();
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
    // leave the orbit pivot a little way in front, so orbiting carries on naturally
    orbit.target.copy(camera.position.clone().add(flyFwd().multiplyScalar(20)));
    orbit.enabled = !lookThrough;
    gizmo.enabled = true;
    orbit.update();
    showFlyHud();
  }
  function flyLook(dx, dy) {
    fly.yaw -= dx * 0.0035;
    fly.pitch = Math.max(-1.5, Math.min(1.5, fly.pitch - dy * 0.0035));
  }
  function flyStep() {
    const now = performance.now(), dt = Math.min(0.1, (now - fly.last) / 1000);
    fly.last = now;
    const fwd = flyFwd(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();
    if (fly.keys.has('w')) move.add(fwd);
    if (fly.keys.has('s')) move.sub(fwd);
    if (fly.keys.has('d')) move.add(right);
    if (fly.keys.has('a')) move.sub(right);
    if (fly.keys.has('e')) move.y += 1;
    if (fly.keys.has('q')) move.y -= 1;
    if (move.lengthSq() > 0) camera.position.add(move.normalize().multiplyScalar(fly.speed * (fly.keys.has('shift') ? 3 : 1) * dt));
    camera.lookAt(camera.position.clone().add(fwd));
  }
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 2) return;
    if (quad && viewAt(e)?.name !== 'v3d') return;
    renderer.domElement.setPointerCapture(e.pointerId);
    startFly(false);
  });
  renderer.domElement.addEventListener('pointerup', (e) => { if (e.button === 2 && fly.active && !fly.locked) stopFly(); });
  addEventListener('mousemove', (e) => {
    if (!fly.active) return;
    if (fly.locked || (e.buttons & 2)) flyLook(e.movementX, e.movementY);
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === renderer.domElement) fly.hasLock = true;
    else if (fly.active && fly.hasLock) stopFly();   // Esc released the lock
  });
  renderer.domElement.addEventListener('wheel', (e) => {
    if (!fly.active) return;
    e.preventDefault(); e.stopImmediatePropagation();
    fly.speed = Math.max(2, Math.min(300, fly.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    showFlyHud();
  }, { capture: true, passive: false });
  // Capture phase on window, so flying keys never reach the editor's shortcuts (W/E/R, Delete...)
  const typingNow = () => { const a = document.activeElement; return a?.tagName === 'TEXTAREA' || (a?.tagName === 'INPUT' && ['text', 'number', ''].includes(a.type)) || document.querySelector('dialog[open]'); };
  addEventListener('keydown', (e) => {
    if (typingNow() || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); fly.active ? stopFly() : startFly(true); return; }
    if (!fly.active) return;
    if (k === 'escape') { stopFly(); return; }
    if (['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k)) { fly.keys.add(k); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  addEventListener('keyup', (e) => { fly.keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') fly.keys.delete('shift'); }, true);
  addEventListener('blur', () => fly.keys.clear());

  const world = new THREE.Group();
  scene3.add(world);
  const overlay = new THREE.Group();   // camera frustum, paths, key markers
  scene3.add(overlay);

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.8);
  scene3.add(gizmo);
  const proxy = new THREE.Object3D();
  scene3.add(proxy);
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (e.value) api.beginEdit(); else api.commitEdit();
  });

  const mats = {
    box: new THREE.MeshLambertMaterial({ color: 0x2a313c }),
    boxSel: new THREE.MeshLambertMaterial({ color: 0x3f6b2e }),
    edge: new THREE.LineBasicMaterial({ color: 0x5d6b80 }),
    edgeSel: new THREE.LineBasicMaterial({ color: 0x8bd450 }),
    model: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }),
    path: new THREE.LineBasicMaterial({ color: 0x4a90d9 }),
    camPath: new THREE.LineBasicMaterial({ color: 0xe8b04a }),
    frustum: new THREE.LineBasicMaterial({ color: 0xffd479 }),
    key: new THREE.MeshBasicMaterial({ color: 0x4a90d9 }),
    keySel: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    camKey: new THREE.MeshBasicMaterial({ color: 0xe8b04a }),
    camLook: new THREE.MeshBasicMaterial({ color: 0xe8b04a, transparent: true, opacity: 0.6 }),
    lookLine: new THREE.LineDashedMaterial({ color: 0xe8b04a, dashSize: 2, gapSize: 1.5, transparent: true, opacity: 0.7 }),
    lookPath: new THREE.LineBasicMaterial({ color: 0x8a6a2c }),
    light: new THREE.PointsMaterial({ color: 0xffe08a, size: 3, sizeAttenuation: false }),
  };
  const nodes = new Map();   // object id -> THREE.Object3D

  function boxNode(o, sel) {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const m = solid(new THREE.Mesh(geo, sel ? mats.boxSel : mats.box));
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), sel ? mats.edgeSel : mats.edge);
    g.add(m, e);
    placeBox(g, o);
    m.userData.id = o.id;
    return g;
  }
  function placeBox(g, o) {
    const x0 = Math.min(o.x0, o.x1), x1 = Math.max(o.x0, o.x1), y0 = Math.min(o.y0, o.y1), y1 = Math.max(o.y0, o.y1), z0 = Math.min(o.z0, o.z1), z1 = Math.max(o.z0, o.z1);
    g.position.copy(T([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
    g.scale.set(Math.max(0.05, x1 - x0), Math.max(0.05, y1 - y0), Math.max(0.05, z1 - z0));
  }

  function billboardNode(o, sel) {
    const f0 = o.tex.frames[0];
    const bits = decodeBits(f0.bits, o.tex.w, o.tex.h);
    const cv = document.createElement('canvas');
    cv.width = o.tex.w; cv.height = o.tex.h;
    const cx = cv.getContext('2d'), img = cx.createImageData(o.tex.w, o.tex.h);
    bits.forEach((b, i) => { const v = b ? 225 : 10; img.data.set([v * 0.75, v * 0.95, v, 255], i * 4); });
    cx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
    const m = solid(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })));
    m.userData.id = o.id;
    const g = new THREE.Group();
    g.add(m);
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), sel ? mats.edgeSel : mats.edge);
    g.add(frame);
    placeBillboard(g, o);
    return g;
  }
  function placeBillboard(g, o) {
    g.position.copy(T(o.pos));
    g.rotation.set(0, -o.yaw * DEG, 0);
    g.scale.set(o.w, o.h, 1);
  }

  function modelNode(o, sel) {
    const g = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    const m = solid(new THREE.Mesh(geo, mats.model));
    m.userData.id = o.id;
    const edges = new THREE.LineSegments(new THREE.BufferGeometry(), sel ? mats.edgeSel : mats.edge);
    g.add(m, edges);
    g.userData = { mesh: m, edges };
    return g;
  }
  // Rebuild a model's triangles at its pose for time t
  function poseModel(g, o, t) {
    const c = api.getCompiled(), mi = c.modelIndex[o.id];
    if (mi === undefined) { g.visible = false; return; }
    const m = c.models[mi], pose = modelPose(m, t);
    if (!pose) { g.visible = false; return; }
    g.visible = true;
    const wv = m.verts.map((v) => T(modelToWorld(m, pose, v)));
    const pos = [], col = [], ed = [];
    for (const f of m.faces) {
      const tri = f.v.length === 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
      const shade = f.dark ? [0.05, 0.06, 0.08] : [0.62, 0.66, 0.72];
      for (const tr of tri) for (const k of tr) { const p = wv[f.v[k]]; pos.push(p.x, p.y, p.z); col.push(...shade); }
      for (let k = 0; k < f.v.length; k++) { const a = wv[f.v[k]], b = wv[f.v[(k + 1) % f.v.length]]; ed.push(a.x, a.y, a.z, b.x, b.y, b.z); }
    }
    const geo = g.userData.mesh.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    g.userData.edges.geometry.dispose();
    g.userData.edges.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(ed, 3));
    g.userData.pos = pose.pos;
    g.userData.pose = pose;
  }

  function lightsNode(o, sel) {
    const c = api.getCompiled();
    const s = c.strips.find((x) => x.src === o) || { a: o.a, b: o.b, spacing: o.spacing, shape: o.shape === 'rect' ? 1 : 0 };
    const pts = stripPoints(s);
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(T));
    const p = new THREE.Points(geo, sel ? new THREE.PointsMaterial({ color: 0x8bd450, size: 5, sizeAttenuation: false }) : mats.light);
    p.userData.id = o.id;
    const g = new THREE.Group();
    g.add(p);
    // a small invisible pick box around the strip
    const bb = new THREE.Box3().setFromPoints(pts.map(T));
    const size = bb.getSize(new THREE.Vector3()).max(new THREE.Vector3(1.5, 1.5, 1.5));
    const pick = solid(new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshBasicMaterial({ visible: false })));
    pick.position.copy(bb.getCenter(new THREE.Vector3()));
    pick.userData.id = o.id;
    g.add(pick);
    return g;
  }

  function rebuild() {
    world.clear();
    nodes.clear();
    const sel = api.getSelection();
    for (const o of api.getScene().objects) {
      if (o.hidden) continue;
      const isSel = sel.kind === 'object' && sel.id === o.id;
      let n;
      if (o.type === 'box') n = boxNode(o, isSel);
      else if (o.type === 'billboard') n = billboardNode(o, isSel);
      else if (o.type === 'model') n = modelNode(o, isSel);
      else if (o.type === 'lights') n = lightsNode(o, isSel);
      if (!n) continue;
      n.userData.objId = o.id;
      world.add(n);
      nodes.set(o.id, n);
    }
    rebuildOverlay();
    attachGizmo();
  }

  // Paths, keys and the camera's path
  function rebuildOverlay() {
    overlay.clear();
    const scene = api.getScene(), c = api.getCompiled(), sel = api.getSelection(), dur = scene.duration;
    const sphere = new THREE.SphereGeometry(0.9, 8, 6);
    c.models.forEach((m) => {
      const pts = [];
      for (let t = 0; t <= dur; t += 0.1) { const p = modelPose(m, t); if (p) pts.push(T(p.pos)); }
      if (pts.length > 1) overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mats.path));
      m.src.keys.forEach((k, i) => {
        const s = new THREE.Mesh(sphere, sel.kind === 'object' && sel.id === m.src.id && sel.key === i ? mats.keySel : mats.key);
        s.position.copy(T(k.p));
        s.userData = { keyOf: m.src.id, key: i };
        overlay.add(s);
      });
    });
    // camera eye path, and (fainter) the path of what it looks at
    const cp = [], lp = [];
    for (let t = 0; t <= dur; t += 0.1) { const cam = cameraAt(c, t, c.models.map((m) => modelPose(m, t))); cp.push(T(cam.eye)); lp.push(T(cam.look)); }
    if (cp.length > 1) overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(cp), mats.camPath));
    if (lp.length > 1) overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(lp), mats.lookPath));
    const small = new THREE.SphereGeometry(0.6, 8, 6);
    scene.camera.keys.forEach((k, i) => {
      if (k.mode !== 'fixed') return;
      const isSel = sel.kind === 'camera' && sel.key === i;
      const s = new THREE.Mesh(sphere, isSel ? mats.keySel : mats.camKey);
      s.position.copy(T(k.eye));
      s.userData = { camKey: i };
      const l = new THREE.Mesh(small, isSel ? mats.keySel : mats.camLook);
      l.position.copy(T(k.look));
      l.userData = { camKey: i };
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([T(k.eye), T(k.look)]), mats.lookLine);
      line.computeLineDistances();
      overlay.add(s, l, line);
    });
    frustum = new THREE.LineSegments(new THREE.BufferGeometry(), mats.frustum);
    overlay.add(frustum);
  }
  let frustum = null;

  function updateFrustum(t) {
    const c = api.getCompiled();
    const cam = cameraAt(c, t, c.models.map((m) => modelPose(m, t)));
    const eye = T(cam.eye), look = T(cam.look);
    const f = look.clone().sub(eye).normalize();
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    const u = new THREE.Vector3().crossVectors(r, f).normalize();
    const d = 8, hw = d * 36 / c.focal, hh = d * 20 / c.focal;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => eye.clone().add(f.clone().multiplyScalar(d)).add(r.clone().multiplyScalar(a * hw)).add(u.clone().multiplyScalar(b * hh)));
    const segs = [];
    for (let i = 0; i < 4; i++) { segs.push(eye, corners[i], corners[i], corners[(i + 1) % 4]); }
    segs.push(eye, eye.clone().add(f.clone().multiplyScalar(d * 1.6)));
    frustum.geometry.dispose();
    frustum.geometry = new THREE.BufferGeometry().setFromPoints(segs);
    return cam;
  }

  // ---------- selection + gizmo ----------
  let gizmoMode = 'translate';
  let attached = null;   // { kind, id, key }

  function attachGizmo() {
    gizmo.detach();
    attached = null;
    if (quad) return;   // in the four views, editing happens in the 2D views
    const sel = api.getSelection(), scene = api.getScene();
    if (sel.kind === 'camera' && sel.key != null) {
      const k = scene.camera.keys[sel.key];
      if (k && k.mode === 'fixed') { proxy.position.copy(T(k.eye)); proxy.rotation.set(0, 0, 0); proxy.scale.set(1, 1, 1); gizmo.setMode('translate'); gizmo.attach(proxy); attached = { kind: 'camKey', key: sel.key }; }
      return;
    }
    if (sel.kind !== 'object') return;
    const o = scene.objects.find((x) => x.id === sel.id);
    if (!o || o.hidden) return;
    let mode = gizmoMode;
    proxy.rotation.set(0, 0, 0); proxy.scale.set(1, 1, 1);
    if (o.type === 'box') {
      placeBox(proxy, o);
      if (mode === 'rotate') mode = 'translate';
    } else if (o.type === 'billboard') {
      placeBillboard(proxy, o);
      if (mode === 'scale') mode = 'translate';
      proxy.scale.set(1, 1, 1);
    } else if (o.type === 'model') {
      const k = sel.key != null ? o.keys[sel.key] : null;
      const n = nodes.get(o.id);
      proxy.position.copy(k ? T(k.p) : (n?.userData.pos ? T(n.userData.pos) : T(o.keys[0]?.p || [0, 0, 0])));
      if (mode === 'scale') mode = 'translate';
      if (mode === 'rotate' && (o.autoOrient || !k)) mode = 'translate';
      if (mode === 'rotate') proxy.rotation.set(0, -(k.r?.[0] || 0) * DEG, 0);
    } else if (o.type === 'lights') {
      proxy.position.copy(T([(o.a[0] + o.b[0]) / 2, (o.a[1] + o.b[1]) / 2, (o.a[2] + o.b[2]) / 2]));
      mode = 'translate';
    }
    gizmo.setMode(mode);
    gizmo.showX = gizmo.showZ = mode !== 'rotate';
    gizmo.showY = true;
    gizmo.attach(proxy);
    attached = { kind: o.type, id: o.id, key: sel.key, startPos: proxy.position.clone() };
  }

  gizmo.addEventListener('objectChange', () => {
    if (!attached) return;
    const scene = api.getScene();
    if (attached.kind === 'camKey') {
      api.liveEdit((s) => { s.camera.keys[attached.key].eye = F(proxy.position).map(round2); }, 'view');
      rebuildOverlay();
      return;
    }
    const o = scene.objects.find((x) => x.id === attached.id);
    if (!o) return;
    const n = nodes.get(o.id);
    if (o.type === 'box') {
      api.liveEdit(() => {
        const c = F(proxy.position), w = Math.abs(proxy.scale.x), h = Math.abs(proxy.scale.y), d = Math.abs(proxy.scale.z);
        o.x0 = round2(c[0] - w / 2); o.x1 = round2(c[0] + w / 2);
        o.y0 = round2(Math.max(0, c[1] - h / 2)); o.y1 = round2(o.y0 + h);
        o.z0 = round2(c[2] - d / 2); o.z1 = round2(c[2] + d / 2);
      }, 'view');
      if (n) placeBox(n, o);
    } else if (o.type === 'billboard') {
      api.liveEdit(() => { o.pos = F(proxy.position).map(round2); o.yaw = round2(-proxy.rotation.y / DEG); }, 'view');
      if (n) placeBillboard(n, o);
    } else if (o.type === 'model') {
      api.liveEdit(() => {
        let ki = attached.key;
        if (ki == null) ki = api.keyAtTime(o);    // auto-key at the playhead
        attached.key = ki;
        const k = o.keys[ki];
        k.p = F(proxy.position).map(round2);
        if (gizmo.mode === 'rotate') k.r = [round2(-proxy.rotation.y / DEG), k.r?.[1] || 0, k.r?.[2] || 0];
      }, 'view');
      rebuildOverlay();
    } else if (o.type === 'lights') {
      const d = F(proxy.position.clone().sub(attached.startPos));
      attached.startPos.copy(proxy.position);
      api.liveEdit(() => { for (let i = 0; i < 3; i++) { o.a[i] = round2(o.a[i] + d[i]); o.b[i] = round2(o.b[i] + d[i]); } }, 'view');
      const old = nodes.get(o.id);
      if (old) { world.remove(old); const nn = lightsNode(o, true); nn.userData.objId = o.id; world.add(nn); nodes.set(o.id, nn); }
    }
  });

  // Click to select
  const ray = new THREE.Raycaster();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || fly.active) return;   // right button is for flying
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || gizmo.dragging) return;
    const at = viewAt(e);
    if (!at || at.name !== 'v3d') return;
    if (axisClick(e)) return;
    ray.layers.enableAll();
    ray.setFromCamera(new THREE.Vector2((at.x / at.r.w) * 2 - 1, -(at.y / at.r.h) * 2 + 1), camera);
    ray.params.Points.threshold = 1.5;
    const hits = ray.intersectObjects([...overlay.children, ...world.children], true);
    for (const h of hits) {
      const ud = h.object.userData;
      if (ud.keyOf) { api.select({ kind: 'object', id: ud.keyOf, key: ud.key }); return; }
      if (ud.camKey != null) { api.select({ kind: 'camera', key: ud.camKey }); return; }
      let o = h.object;
      while (o && !o.userData.id && !o.userData.objId) o = o.parent;
      if (o) { api.select({ kind: 'object', id: o.userData.id || o.userData.objId, key: null }); return; }
    }
    api.select({ kind: 'scene' });
  });


  // ---------- Hammer-style four views ----------
  // 3D top-left, Top (x/z) top-right, Front (x/y) bottom-left, Side (z/y) bottom-right.
  // In the 2D views: click selects, drag moves, handles resize boxes, right/middle-drag
  // pans, scroll zooms. Everything snaps to the grid ([ and ] change its size).
  let quad = false, blockTool = false, camTool = false, pathTool = false, gridSize = 4;
  let hover2d = null, spaceHeld = false;   // Hammer: hold Space + left-drag to pan a 2D view
  const GRIDS = [1, 2, 4, 8, 16, 32, 64];
  // u/v = the view's horizontal/vertical axes, as engine axis indices (0 x, 1 y, 2 z)
  const views2d = {
    top:   { label: 'Top (x/z)',   u: 0, v: 2, cu: 0, cv: 150, scale: 1.1, cam: new THREE.OrthographicCamera() },
    front: { label: 'Front (x/y)', u: 0, v: 1, cu: 0, cv: 40,  scale: 1.1, cam: new THREE.OrthographicCamera() },
    side:  { label: 'Side (z/y)',  u: 2, v: 1, cu: 150, cv: 40, scale: 1.1, cam: new THREE.OrthographicCamera() },
  };
  for (const v of Object.values(views2d)) { v.cam.near = 1; v.cam.far = 6000; }

  function rects() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!quad) return { v3d: { x: 0, y: 0, w, h } };
    const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    return {
      v3d: { x: 0, y: 0, w: hw - 1, h: hh - 1 },
      top: { x: hw + 1, y: 0, w: w - hw - 1, h: hh - 1 },
      front: { x: 0, y: hh + 1, w: hw - 1, h: h - hh - 1 },
      side: { x: hw + 1, y: hh + 1, w: w - hw - 1, h: h - hh - 1 },
    };
  }
  function viewAt(e) {
    const b = renderer.domElement.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    for (const [name, r] of Object.entries(rects())) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return { name, r, x: x - r.x, y: y - r.y };
    return null;
  }
  function placeOrtho(v, r) {
    const hw = r.w / 2 / v.scale, hh = r.h / 2 / v.scale;
    Object.assign(v.cam, { left: -hw, right: hw, top: hh, bottom: -hh });
    v.cam.updateProjectionMatrix();
    // engine-space camera position: far out along the view's depth axis
    const p = [0, 0, 0];
    p[v.u] = v.cu; p[v.v] = v.cv;
    if (v === views2d.top) { p[1] = 3000; v.cam.up.set(0, 0, 1); }
    else if (v === views2d.front) { p[2] = -3000; v.cam.up.set(0, 1, 0); }
    else { p[0] = 3000; v.cam.up.set(0, 1, 0); }
    const target = [...p];
    if (v === views2d.top) target[1] = 0; else if (v === views2d.front) target[2] = 0; else target[0] = 0;
    v.cam.position.copy(T(p));
    v.cam.lookAt(T(target));
  }
  const toUV = (v, r, px, py) => [v.cu + (px - r.w / 2) / v.scale, v.cv - (py - r.h / 2) / v.scale];
  const toPx = (v, r, u, w) => [r.w / 2 + (u - v.cu) * v.scale, r.h / 2 - (w - v.cv) * v.scale];
  const snap = (x) => Math.round(x / gridSize) * gridSize;

  // The selection's extent in a view's u/v axes (and whether it can be resized)
  function selExtent(v) {
    const sel = api.getSelection(), scene = api.getScene();
    const pt = (p, pad = 2) => ({ u0: p[v.u] - pad, u1: p[v.u] + pad, v0: p[v.v] - pad, v1: p[v.v] + pad });
    if (sel.kind === 'camera' && sel.key != null) { const k = scene.camera.keys[sel.key]; return k?.mode === 'fixed' ? { ...pt(k.eye), kind: 'camKey', look: k.look } : null; }
    if (sel.kind !== 'object') return null;
    const o = scene.objects.find((x) => x.id === sel.id);
    if (!o) return null;
    if (o.type === 'box') {
      const lo = [Math.min(o.x0, o.x1), Math.min(o.y0, o.y1), Math.min(o.z0, o.z1)], hi = [Math.max(o.x0, o.x1), Math.max(o.y0, o.y1), Math.max(o.z0, o.z1)];
      return { u0: lo[v.u], u1: hi[v.u], v0: lo[v.v], v1: hi[v.v], kind: 'box', resizable: true };
    }
    if (o.type === 'billboard') {
      const cs = billboardCorners({ x: o.pos[0], y: o.pos[1], z: o.pos[2], yaw: o.yaw * DEG, w: o.w, h: o.h });
      const us = cs.map((c) => c[v.u]), vs = cs.map((c) => c[v.v]);
      return { u0: Math.min(...us) - 0.5, u1: Math.max(...us) + 0.5, v0: Math.min(...vs) - 0.5, v1: Math.max(...vs) + 0.5, kind: 'billboard' };
    }
    if (o.type === 'lights') return { u0: Math.min(o.a[v.u], o.b[v.u]) - 1.5, u1: Math.max(o.a[v.u], o.b[v.u]) + 1.5, v0: Math.min(o.a[v.v], o.b[v.v]) - 1.5, v1: Math.max(o.a[v.v], o.b[v.v]) + 1.5, kind: 'lights' };
    if (o.type === 'model') {
      const k = sel.key != null ? o.keys[sel.key] : null, n = nodes.get(o.id);
      const p = k ? k.p : n?.userData.pos;
      return p ? { ...pt(p, 3 * (o.scale || 1)), kind: 'model' } : null;
    }
    return null;
  }

  // Handles: corners and edge midpoints of the selection rectangle (boxes only)
  const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  function handleAt(v, r, ext, px, py) {
    if (!ext?.resizable) return null;
    const [ax, ay] = toPx(v, r, ext.u0, ext.v1), [bx, by] = toPx(v, r, ext.u1, ext.v0);
    for (const [hx, hy] of HANDLES) {
      const x = hx < 0 ? ax : hx > 0 ? bx : (ax + bx) / 2, y = hy < 0 ? ay : hy > 0 ? by : (ay + by) / 2;
      if (Math.abs(px - x) <= 6 && Math.abs(py - y) <= 6) return [hx, hy];
    }
    return null;
  }

  // 2D overlay: grid, labels, selection handles, rubber band
  const overlay2d = document.createElement('canvas');
  overlay2d.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1';
  el.appendChild(overlay2d);
  let drag2d = null, lastBlock = { h: 24, d: 16 };

  function drawOverlay2d() {
    const dpr = devicePixelRatio, w = el.clientWidth, h = el.clientHeight;
    if (overlay2d.width !== w * dpr || overlay2d.height !== h * dpr) { overlay2d.width = w * dpr; overlay2d.height = h * dpr; overlay2d.style.width = w + 'px'; overlay2d.style.height = h + 'px'; }
    const g = overlay2d.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!quad) return;
    const R = rects();
    g.fillStyle = '#2b3038';
    g.fillRect(R.top.x - 2, 0, 2, h); g.fillRect(0, R.front.y - 2, w, 2);
    for (const [name, v] of Object.entries(views2d)) {
      const r = R[name];
      g.save();
      g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
      g.translate(r.x, r.y);
      // grid: draw every grid step that is at least 6 px apart, brighter every 8, axes brightest
      let step = gridSize;
      while (step * v.scale < 6) step *= 2;
      const [uA, vB] = toUV(v, r, 0, r.h), [uB, vA] = toUV(v, r, r.w, 0);
      for (let u = Math.ceil(uA / step) * step; u <= uB; u += step) {
        const [x] = toPx(v, r, u, 0);
        g.fillStyle = u === 0 ? 'rgba(229,96,79,.45)' : Math.round(u / step) % 8 === 0 ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.04)';
        g.fillRect(Math.round(x), 0, 1, r.h);
      }
      for (let q = Math.ceil(vB / step) * step; q <= vA; q += step) {
        const [, y] = toPx(v, r, 0, q);
        g.fillStyle = q === 0 ? 'rgba(139,212,80,.45)' : Math.round(q / step) % 8 === 0 ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.04)';
        g.fillRect(0, Math.round(y), r.w, 1);
      }
      // label
      g.font = '11px system-ui'; g.fillStyle = '#8a9099';
      g.fillText(`${v.label} · grid ${gridSize}${blockTool ? ' · BLOCK TOOL' : ''}${camTool ? ' · CAMERA PATH: drag from camera to target' : ''}${pathTool ? ' · MODEL PATH: click points along the route' : ''}`, 8, 15);
      // selection rectangle + handles
      const ext = selExtent(v);
      if (ext) {
        const [ax, ay] = toPx(v, r, ext.u0, ext.v1), [bx, by] = toPx(v, r, ext.u1, ext.v0);
        g.strokeStyle = '#8bd450'; g.setLineDash([4, 3]); g.strokeRect(ax + 0.5, ay + 0.5, bx - ax, by - ay); g.setLineDash([]);
        if (ext.resizable) for (const [hx, hy] of HANDLES) {
          const x = hx < 0 ? ax : hx > 0 ? bx : (ax + bx) / 2, y = hy < 0 ? ay : hy > 0 ? by : (ay + by) / 2;
          g.fillStyle = '#111317'; g.fillRect(x - 3.5, y - 3.5, 7, 7);
          g.strokeStyle = '#8bd450'; g.strokeRect(x - 3.5, y - 3.5, 7, 7);
        }
      }
      // a selected camera key: diamond handle on its look target
      if (ext?.look) {
        const [lx, ly] = toPx(v, r, ext.look[v.u], ext.look[v.v]), [ex, ey] = toPx(v, r, (ext.u0 + ext.u1) / 2, (ext.v0 + ext.v1) / 2);
        g.strokeStyle = 'rgba(232,176,74,.8)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(ex, ey); g.lineTo(lx, ly); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#e8b04a'; g.beginPath(); g.moveTo(lx, ly - 6); g.lineTo(lx + 6, ly); g.lineTo(lx, ly + 6); g.lineTo(lx - 6, ly); g.closePath(); g.fill();
      }
      // camera path tool: eye dot, arrow to the target, and the field of view
      if (drag2d?.mode === 'camplot' && drag2d.view === name) {
        const [ax, ay] = toPx(v, r, drag2d.a[0], drag2d.a[1]), [bx, by] = toPx(v, r, drag2d.b[0], drag2d.b[1]);
        const ang = Math.atan2(by - ay, bx - ax), half = Math.atan(36 / api.getCompiled().focal), len = Math.max(30, Math.hypot(bx - ax, by - ay));
        if (Math.hypot(bx - ax, by - ay) > 3) {
          g.fillStyle = 'rgba(232,176,74,.12)';
          g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + Math.cos(ang - half) * len, ay + Math.sin(ang - half) * len); g.lineTo(ax + Math.cos(ang + half) * len, ay + Math.sin(ang + half) * len); g.closePath(); g.fill();
          g.strokeStyle = '#e8b04a'; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
        }
        g.fillStyle = '#e8b04a'; g.beginPath(); g.arc(ax, ay, 4, 0, Math.PI * 2); g.fill();
      }
      if (drag2d?.mode === 'modelplot' && drag2d.view === name) {
        const [ax, ay] = toPx(v, r, drag2d.a[0], drag2d.a[1]), [bx, by] = toPx(v, r, drag2d.b[0], drag2d.b[1]);
        g.fillStyle = '#4a90d9'; g.beginPath(); g.arc(ax, ay, 4, 0, Math.PI * 2); g.fill();
        if (Math.hypot(bx - ax, by - ay) > 3) { g.strokeStyle = '#4a90d9'; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); }
      }
      // rubber band for the block tool
      if (drag2d?.mode === 'block' && drag2d.view === name) {
        const [ax, ay] = toPx(v, r, Math.min(drag2d.a[0], drag2d.b[0]), Math.max(drag2d.a[1], drag2d.b[1]));
        const [bx, by] = toPx(v, r, Math.max(drag2d.a[0], drag2d.b[0]), Math.min(drag2d.a[1], drag2d.b[1]));
        g.fillStyle = 'rgba(232,176,74,.12)'; g.fillRect(ax, ay, bx - ax, by - ay);
        g.strokeStyle = '#e8b04a'; g.strokeRect(ax + 0.5, ay + 0.5, bx - ax, by - ay);
        g.fillStyle = '#e8b04a';
        g.fillText(`${Math.abs(drag2d.b[0] - drag2d.a[0])} × ${Math.abs(drag2d.b[1] - drag2d.a[1])}`, bx + 4, by + 12);
      }
      g.restore();
    }
  }

  // Apply a u/v move (du, dv) to the selection, starting from its state at drag start
  function moveSelection(v, start, du, dv) {
    api.liveEdit((s) => {
      const sel = api.getSelection();
      if (sel.kind === 'camera') { const k = s.camera.keys[sel.key]; k.eye = [...start.eye]; k.eye[v.u] += du; k.eye[v.v] += dv; return; }
      const o = s.objects.find((x) => x.id === sel.id);
      if (!o) return;
      if (o.type === 'box') {
        const keys = [['x0', 'x1'], ['y0', 'y1'], ['z0', 'z1']];
        for (const [ax, d] of [[v.u, du], [v.v, dv]]) { const [k0, k1] = keys[ax]; o[k0] = start[k0] + d; o[k1] = start[k1] + d; }
        if (Math.min(o.y0, o.y1) < 0) { const lift = -Math.min(o.y0, o.y1); o.y0 += lift; o.y1 += lift; }
      } else if (o.type === 'billboard') { o.pos = [...start.pos]; o.pos[v.u] += du; o.pos[v.v] += dv; }
      else if (o.type === 'lights') { o.a = [...start.a]; o.b = [...start.b]; for (const [ax, d] of [[v.u, du], [v.v, dv]]) { o.a[ax] += d; o.b[ax] += d; } }
      else if (o.type === 'model') {
        const ki = start.key ?? api.keyAtTime(o);
        start.key = ki;
        const k = o.keys[ki];
        k.p = [...start.p]; k.p[v.u] += du; k.p[v.v] += dv;
      }
    });
  }

  function snapshotSelection() {
    const sel = api.getSelection(), scene = api.getScene();
    if (sel.kind === 'camera') return { eye: [...(scene.camera.keys[sel.key]?.eye || [0, 0, 0])] };
    const o = scene.objects.find((x) => x.id === sel.id);
    if (!o) return null;
    if (o.type === 'model') {
      const k = sel.key != null ? o.keys[sel.key] : null;
      const n = nodes.get(o.id);
      return { key: sel.key, p: [...(k ? k.p : (n?.userData.pos || o.keys[0].p))].map((x) => Math.round(x * 100) / 100) };
    }
    return structuredClone(o);
  }

  function pick2d(v, r, px, py) {
    const rc = new THREE.Raycaster();
    rc.layers.enableAll();
    rc.params.Points.threshold = 6 / v.scale;
    rc.params.Line.threshold = 4 / v.scale;
    rc.setFromCamera(new THREE.Vector2((px / r.w) * 2 - 1, -(py / r.h) * 2 + 1), v.cam);
    for (const h of rc.intersectObjects([...overlay.children, ...world.children], true)) {
      const ud = h.object.userData;
      if (ud.keyOf) return { kind: 'object', id: ud.keyOf, key: ud.key };
      if (ud.camKey != null) return { kind: 'camera', key: ud.camKey };
      let o = h.object;
      while (o && !o.userData.id && !o.userData.objId) o = o.parent;
      if (o) return { kind: 'object', id: o.userData.id || o.userData.objId, key: null };
    }
    return null;
  }

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!quad) return;
    const at = viewAt(e);
    if (!at || at.name === 'v3d') return;
    e.stopImmediatePropagation(); e.preventDefault();   // 2D views: keep orbit/fly/gizmo out of it
    const v = views2d[at.name];
    renderer.domElement.setPointerCapture(e.pointerId);
    const uv = toUV(v, at.r, at.x, at.y);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeld)) { drag2d = { mode: 'pan', view: at.name, px: e.clientX, py: e.clientY, cu: v.cu, cv: v.cv }; return; }
    if (e.button !== 0) return;
    if (blockTool) { const a = [snap(uv[0]), snap(uv[1])]; drag2d = { mode: 'block', view: at.name, a, b: [...a] }; return; }
    if (camTool) { const a = [snap(uv[0]), snap(uv[1])]; drag2d = { mode: 'camplot', view: at.name, a, b: [...a] }; return; }
    if (pathTool) {
      const sel = api.getSelection(), o = sel.kind === 'object' && api.getScene().objects.find((x) => x.id === sel.id);
      if (!o || o.type !== 'model') { api.toast?.('Select a model first (click it, or its row in the timeline)'); return; }
      const a = [snap(uv[0]), snap(uv[1])];
      drag2d = { mode: 'modelplot', view: at.name, a, b: [...a], id: o.id };
      return;
    }
    let ext = selExtent(v);
    if (ext?.look) {
      const [lx, ly] = toPx(v, at.r, ext.look[v.u], ext.look[v.v]);
      if (Math.abs(at.x - lx) <= 7 && Math.abs(at.y - ly) <= 7) {
        api.beginEdit();
        drag2d = { mode: 'look', view: at.name, start: [...ext.look], uv };
        return;
      }
    }
    const handle = handleAt(v, at.r, ext, at.x, at.y);
    if (handle) { api.beginEdit(); drag2d = { mode: 'resize', view: at.name, handle, start: snapshotSelection(), uv }; return; }
    const inside = ext && uv[0] >= ext.u0 && uv[0] <= ext.u1 && uv[1] >= ext.v0 && uv[1] <= ext.v1;
    if (!inside) {
      const hit = pick2d(v, at.r, at.x, at.y);
      api.select(hit || { kind: 'scene' });
      if (!hit) return;
    }
    const start = snapshotSelection();
    if (start) { api.beginEdit(); drag2d = { mode: 'move', view: at.name, start, uv, moved: false }; }
  }, true);

  addEventListener('pointermove', (e) => {
    if (quad && e.target === renderer.domElement) { const at = viewAt(e); hover2d = at && at.name !== 'v3d' ? at.name : null; renderer.domElement.style.cursor = hover2d && spaceHeld ? 'grab' : ''; }
    if (!drag2d) return;
    const v = views2d[drag2d.view], r = rects()[drag2d.view];
    if (drag2d.mode === 'pan') {
      v.cu = drag2d.cu - (e.clientX - drag2d.px) / v.scale;
      v.cv = drag2d.cv + (e.clientY - drag2d.py) / v.scale;
      return;
    }
    const b = renderer.domElement.getBoundingClientRect();
    const uv = toUV(v, r, e.clientX - b.left - r.x, e.clientY - b.top - r.y);
    if (drag2d.mode === 'block' || drag2d.mode === 'camplot' || drag2d.mode === 'modelplot') { drag2d.b = [snap(uv[0]), snap(uv[1])]; return; }
    if (drag2d.mode === 'look') {
      const du = snap(uv[0] - drag2d.uv[0]), dv = snap(uv[1] - drag2d.uv[1]);
      api.liveEdit((s) => { const k = s.camera.keys[api.getSelection().key]; k.look = [...drag2d.start]; k.look[v.u] += du; k.look[v.v] += dv; });
      return;
    }
    if (drag2d.mode === 'move') {
      const du = snap(uv[0] - drag2d.uv[0]), dv = snap(uv[1] - drag2d.uv[1]);
      if (!drag2d.moved && !du && !dv) return;
      drag2d.moved = true;
      moveSelection(v, drag2d.start, du, dv);
    } else if (drag2d.mode === 'resize') {
      const sel = api.getSelection();
      api.liveEdit((s) => {
        const o = s.objects.find((x) => x.id === sel.id), st = drag2d.start;
        const keys = [['x0', 'x1'], ['y0', 'y1'], ['z0', 'z1']];
        const [hx, hy] = drag2d.handle;
        for (const [ax, hdir, val] of [[v.u, hx, uv[0]], [v.v, -hy, uv[1]]]) {
          if (!hdir) continue;
          const [k0, k1] = keys[ax];
          const lo = Math.min(st[k0], st[k1]), hi = Math.max(st[k0], st[k1]);
          if (hdir < 0) { o[k0] = Math.min(snap(val), hi - gridSize); o[k1] = hi; }
          else { o[k0] = lo; o[k1] = Math.max(snap(val), lo + gridSize); }
        }
        if (Math.min(o.y0, o.y1) < 0) { o.y0 = Math.max(0, o.y0); o.y1 = Math.max(o.y1, o.y0 + gridSize); }
      });
    }
  });

  addEventListener('pointerup', () => {
    if (!drag2d) return;
    const d = drag2d;
    drag2d = null;
    if (d.mode === 'move' || d.mode === 'resize' || d.mode === 'look') { api.commitEdit(); return; }
    if (d.mode === 'modelplot') {
      // Start from where the model is at the playhead, then replace this view's two axes
      const v = views2d[d.view], c = api.getCompiled(), t = api.getTime();
      const mi = c.modelIndex[d.id], pose = mi !== undefined ? modelPose(c.models[mi], t) : null;
      const p = pose ? [...pose.pos] : [0, 20, 0];
      p[v.u] = d.a[0]; p[v.v] = d.a[1];
      let yaw = null;
      const du = d.b[0] - d.a[0], dv = d.b[1] - d.a[1];
      if (Math.hypot(du, dv) >= gridSize / 2 && v === views2d.top) yaw = Math.atan2(du, dv) / DEG;   // facing, from a drag in the Top view
      api.addModelKey(d.id, p.map(round2), yaw == null ? null : round2(yaw));
      return;
    }
    if (d.mode === 'camplot') {
      // Start from the camera as it is at the playhead, then replace this view's two axes
      const v = views2d[d.view], c = api.getCompiled(), t = api.getTime();
      const cur = cameraAt(c, t, c.models.map((m) => modelPose(m, t)));
      const eye = [...cur.eye], look = [...cur.look];
      eye[v.u] = d.a[0]; eye[v.v] = d.a[1];
      if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) < gridSize / 2) {
        // a click: move the camera, keep its viewing direction
        for (let i = 0; i < 3; i++) look[i] = eye[i] + (cur.look[i] - cur.eye[i]);
      } else { look[v.u] = d.b[0]; look[v.v] = d.b[1]; }
      api.addCameraKey(eye.map(round2), look.map(round2));
      return;
    }
    if (d.mode === 'block') {
      const v = views2d[d.view];
      const u0 = Math.min(d.a[0], d.b[0]), u1 = Math.max(d.a[0], d.b[0]), w0 = Math.min(d.a[1], d.b[1]), w1 = Math.max(d.a[1], d.b[1]);
      if (u1 - u0 < gridSize / 2 || w1 - w0 < gridSize / 2) return;
      // the third axis: height for the top view, otherwise a depth centred on the 3D view's focus point
      const lo = [0, 0, 0], hi = [0, 0, 0], focus = F(orbit.target);
      lo[v.u] = u0; hi[v.u] = u1; lo[v.v] = w0; hi[v.v] = w1;
      const third = 3 - v.u - v.v;
      if (third === 1) { lo[1] = 0; hi[1] = lastBlock.h; }
      else { lo[third] = snap(focus[third] - lastBlock.d / 2); hi[third] = lo[third] + lastBlock.d; }
      if (v.v === 1) lastBlock.h = w1 - w0;
      lastBlock.d = third === 1 ? lastBlock.d : Math.max(u1 - u0, gridSize);
      api.addBox({ x0: lo[0], x1: hi[0], y0: Math.max(0, lo[1]), y1: Math.max(hi[1], lo[1] + gridSize), z0: lo[2], z1: hi[2] });
    }
  });

  renderer.domElement.addEventListener('wheel', (e) => {
    if (!quad || fly.active) return;
    const at = viewAt(e);
    if (!at || at.name === 'v3d') return;
    e.preventDefault(); e.stopImmediatePropagation();
    const v = views2d[at.name];
    const before = toUV(v, at.r, at.x, at.y);
    v.scale = Math.max(0.05, Math.min(40, v.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    const after = toUV(v, at.r, at.x, at.y);
    v.cu += before[0] - after[0]; v.cv += before[1] - after[1];   // zoom toward the cursor
  }, { capture: true, passive: false });

  function center2dOn(p) { for (const v of Object.values(views2d)) { v.cu = p[v.u]; v.cv = p[v.v]; } }

  addEventListener('keydown', (e) => {
    if (typingNow() || e.metaKey || e.ctrlKey || fly.active) return;
    const k = e.key.toLowerCase();
    // Space over a 2D view = pan (Hammer); elsewhere it stays play/pause
    if (e.key === ' ' && quad && hover2d) { spaceHeld = true; renderer.domElement.style.cursor = 'grab'; e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (k === 'v') { setQuad(!quad); e.preventDefault(); }
    else if (k === 'b') { setBlockTool(!blockTool); e.preventDefault(); }
    else if (k === 'p') { setCamTool(!camTool); e.preventDefault(); }
    else if (k === 'm') { setPathTool(!pathTool); e.preventDefault(); }
    else if (k === '[' || k === ']') { const i = GRIDS.indexOf(gridSize); gridSize = GRIDS[Math.max(0, Math.min(GRIDS.length - 1, i + (k === ']' ? 1 : -1)))]; api.onViewState?.(); }
    else if (k === 'escape' && (blockTool || camTool || pathTool)) { setBlockTool(false); setCamTool(false); setPathTool(false); }
  }, true);

  addEventListener('keyup', (e) => { if (e.key === ' ') { spaceHeld = false; renderer.domElement.style.cursor = ''; } });

  function setQuad(v) {
    quad = v;
    if (quad) { center2dOn(F(orbit.target)); attachGizmo(); }
    else { blockTool = camTool = pathTool = false; attachGizmo(); }
    resize();
    api.onViewState?.();
  }
  // One tool at a time
  function setTool(name, on) {
    if (on && !quad) setQuad(true);
    blockTool = name === 'block' ? on : on ? false : blockTool;
    camTool = name === 'cam' ? on : on ? false : camTool;
    pathTool = name === 'path' ? on : on ? false : pathTool;
    api.onViewState?.();
  }
  const setBlockTool = (v) => setTool('block', v), setCamTool = (v) => setTool('cam', v), setPathTool = (v) => setTool('path', v);

  // ---------- frame loop ----------
  let lookThrough = false;
  // In camera view, a frame shows exactly what the OLED sees
  const oledFrame = document.createElement('div');
  oledFrame.style.cssText = 'position:absolute;border:1px solid #ffd479;box-shadow:0 0 0 9999px rgba(0,0,0,.45);pointer-events:none;display:none;z-index:1';
  el.appendChild(oledFrame);
  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
    const r = rects().v3d;
    camera.aspect = r.w / r.h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(el);
  resize();

  function frame(t) {
    const scene = api.getScene();
    for (const o of scene.objects) if (o.type === 'model' && !o.hidden) { const n = nodes.get(o.id); if (n) poseModel(n, o, t); }
    const cam = frustum ? updateFrustum(t) : null;
    if (lookThrough && cam) {
      camera.position.copy(T(cam.eye));
      camera.lookAt(T(cam.look));
      // Widen the view until the OLED's 72x40 frame fits, then outline that frame
      const focal = api.getCompiled().focal, tanH = 36 / focal, tanV = 20 / focal;
      const tanFit = Math.max(tanV, tanH / camera.aspect);
      camera.fov = 2 * Math.atan(tanFit) / DEG;
      camera.updateProjectionMatrix();
      const fw = tanH / (tanFit * camera.aspect), fh = tanV / tanFit, r3 = rects().v3d;
      Object.assign(oledFrame.style, { display: 'block', left: r3.x + (1 - fw) / 2 * r3.w + 'px', top: r3.y + (1 - fh) / 2 * r3.h + 'px', width: fw * r3.w + 'px', height: fh * r3.h + 'px' });
      frustum.visible = false;
      overlay.visible = false;   // key markers sit right at the camera and would fill the view
    } else {
      overlay.visible = true;
      oledFrame.style.display = 'none';
      if (frustum) frustum.visible = true;
      if (fly.active) flyStep(); else orbit.update();
    }
    // keep the gizmo on a model that's moving along its path (when no key is selected)
    if (attached && attached.kind === 'model' && attached.key == null && !gizmo.dragging) {
      const n = nodes.get(attached.id);
      if (n?.userData.pos) proxy.position.copy(T(n.userData.pos));
    }
    const R = rects(), H = el.clientHeight;
    renderer.setScissorTest(true);
    for (const [name, r] of Object.entries(R)) {
      renderer.setViewport(r.x, H - r.y - r.h, r.w, r.h);
      renderer.setScissor(r.x, H - r.y - r.h, r.w, r.h);
      if (name === 'v3d') { gizmo.visible = true; renderer.render(scene3, camera); }
      else {
        const v = views2d[name];
        placeOrtho(v, r);
        gizmo.visible = false;
        const fogWas = scene3.fog; scene3.fog = null;   // no depth fog in plan views
        renderer.render(scene3, v.cam);
        scene3.fog = fogWas;
      }
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, el.clientWidth, H);
    renderAxes();
    drawOverlay2d();
  }

  return {
    rebuild,
    rebuildOverlay,
    frame,
    setGizmoMode(m) { gizmoMode = m; attachGizmo(); },
    setQuad, setBlockTool, setCamTool, setPathTool,
    viewState: () => ({ quad, blockTool, camTool, pathTool, gridSize }),
    debug: { camera, THREE, T },
    setLookThrough(v) {
      if (v) stopFly();
      lookThrough = v;
      orbit.enabled = !v;
      if (!v) { camera.fov = 50; camera.updateProjectionMatrix(); }
    },
    // The editor camera as an engine-space eye/look pair (for "camera key from view")
    viewPose() { return { eye: F(camera.position).map(round2), look: F(orbit.target).map(round2) }; },
    frameSelection() {
      const sel = api.getSelection();
      const n = sel.kind === 'object' ? nodes.get(sel.id) : null;
      if (!n) return;
      const box = new THREE.Box3().setFromObject(n), c = box.getCenter(new THREE.Vector3()), size = Math.max(4, box.getSize(new THREE.Vector3()).length());
      center2dOn(F(c));
      const dir = camera.position.clone().sub(orbit.target).normalize();
      orbit.target.copy(c);
      camera.position.copy(c.clone().add(dir.multiplyScalar(size * 1.6)));
    },
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
