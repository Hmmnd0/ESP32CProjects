// OLED3D player for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
//
// Plays the scene exported by the OLED3D editor (include/scene.h). This is a
// C++ port of editor/engine.js; keep the two in step.
//
// Also a live display: frames streamed from the editor over USB serial
// (0xA5 0x5A + 360 bytes, SSD1306 page format) are shown as they arrive.
// When they stop for 1.5 s, the exported scene resumes.
// Prints "fps N" once a second while playing the scene.
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include "scene.h"

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40;
const uint8_t BAYER[16] = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};
inline bool dither(int x, int y, float level) { return BAYER[(y & 3) * 4 + (x & 3)] < level * 16; }

// ---------- math ----------
struct V3 { float x, y, z; };
inline V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 operator*(V3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline V3 norm(V3 a) { float l = sqrtf(dot(a, a)); return l > 1e-6f ? a * (1 / l) : a; }
inline V3 lerp3(V3 a, V3 b, float t) { return a + (b - a) * t; }
inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
inline float span(float t, float a, float b) { return clampf((t - a) / (b - a), 0, 1); }

float easeFn(int kind, float s) {
  s = clampf(s, 0, 1);
  switch (kind) {
    case 1: return s * s * (3 - 2 * s);
    case 2: return s * s;
    case 3: return 1 - (1 - s) * (1 - s) * (1 - s);
    default: return s;
  }
}

// Catmull-Rom/Hermite over n keys of up to 6 values; valAt(k, out) fills key k's values.
template <typename TimeFn, typename ValFn>
void interpKeys(int n, float t, int dim, TimeFn timeAt, ValFn valAt, int easeAt(int), float *out) {
  if (n <= 0) return;
  if (t <= timeAt(0) || n == 1) { valAt(0, out); return; }
  if (t >= timeAt(n - 1)) { valAt(n - 1, out); return; }
  int i = 0;
  while (t > timeAt(i + 1)) i++;
  float t0 = timeAt(i), t1 = timeAt(i + 1), dt = t1 - t0;
  if (easeAt(i) == 4) { valAt(i, out); return; }   // cut: hold until the next key
  float s = easeFn(easeAt(i), (t - t0) / dt);
  float p0[6], p1[6], m0[6], m1[6], pa[6], pb[6];
  valAt(i, p0); valAt(i + 1, p1);
  for (int side = 0; side < 2; side++) {
    // never smooth across a cut
    int k = i + side;
    int a = (k > 0 && easeAt(k - 1) != 4) ? k - 1 : k;
    int b = (k < n - 1 && easeAt(k) != 4) ? k + 1 : k;
    float *m = side ? m1 : m0;
    if (a == b) { for (int j = 0; j < dim; j++) m[j] = 0; continue; }
    valAt(a, pa); valAt(b, pb);
    for (int j = 0; j < dim; j++) m[j] = (pb[j] - pa[j]) * (dt / (timeAt(b) - timeAt(a)));
  }
  float s2 = s * s, s3 = s2 * s;
  float h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  for (int j = 0; j < dim; j++) out[j] = p0[j] * h00 + m0[j] * h10 + p1[j] * h01 + m1[j] * h11;
}

// ---------- animation ----------
struct Pose { V3 pos; float yaw, pitch, roll; bool powered, valid; };
Pose poses[SC_NMODEL > 0 ? SC_NMODEL : 1];

int curModel;   // for the key callbacks below
float mkTime(int k) { return SC_MKEYS[SC_MODELS[curModel].kOff + k].t; }
int mkEase(int k) { return SC_MKEYS[SC_MODELS[curModel].kOff + k].ease; }
void mkPos(int k, float *o) { const SModelKey &K = SC_MKEYS[SC_MODELS[curModel].kOff + k]; o[0] = K.x; o[1] = K.y; o[2] = K.z; }
void mkRot(int k, float *o) { const SModelKey &K = SC_MKEYS[SC_MODELS[curModel].kOff + k]; o[0] = K.yaw; o[1] = K.pitch; o[2] = K.roll; }

V3 modelPos(int mi, float t) {
  curModel = mi;
  float o[6] = {0};
  interpKeys(SC_MODELS[mi].nK, t, 3, mkTime, mkPos, mkEase, o);
  return {o[0], o[1], o[2]};
}

float headingAt(int mi, float t) {
  V3 p = modelPos(mi, t), a = modelPos(mi, t + 0.15f) - p;
  if (hypotf(a.x, a.z) < 0.05f)
    for (float d = 0.3f; d <= 3; d += 0.3f) { a = p - modelPos(mi, t - d); if (hypotf(a.x, a.z) >= 0.05f) break; }
  if (hypotf(a.x, a.z) >= 0.05f) return atan2f(a.x, a.z);
  return SC_MODELS[mi].nK ? SC_MKEYS[SC_MODELS[mi].kOff].yaw : 0;
}

Pose modelPose(int mi, float t) {
  const SModel &m = SC_MODELS[mi];
  Pose P{};
  if (!m.nK) { P.valid = false; return P; }
  P.valid = true;
  V3 pos = modelPos(mi, t);
  float lastT = SC_MKEYS[m.kOff + m.nK - 1].t;
  P.powered = !(m.flags & 8) || t < lastT;
  if (m.flags & 1) {
    P.yaw = headingAt(mi, t);
    V3 a = modelPos(mi, t + 0.15f) - pos;
    float horiz = hypotf(a.x, a.z);
    P.pitch = clampf(atan2f(a.y, max(horiz, 0.01f)) * 0.5f, -0.3f, 0.3f);
    float dy = headingAt(mi, t + 0.15f) - headingAt(mi, t - 0.15f);
    while (dy > PI) dy -= 2 * PI;
    while (dy < -PI) dy += 2 * PI;
    P.roll = clampf(-(dy / 0.3f) * 0.5f, -0.5f, 0.5f) + sinf(t * 1.7f) * 0.04f;
  } else {
    curModel = mi;
    float o[6] = {0};
    interpKeys(m.nK, t, 3, mkTime, mkRot, mkEase, o);
    P.yaw = o[0]; P.pitch = o[1]; P.roll = o[2];
  }
  if (m.bob != 0 && P.powered) pos.y += sinf(t * 2.3f) * m.bob * (1 - span(t, lastT - 3.5f, lastT));
  P.pos = pos;
  return P;
}

V3 modelToWorld(int mi, const Pose &P, V3 v) {
  float s = SC_MODELS[mi].scale;
  float x = v.x * s, y = v.y * s, z = v.z * s;
  float cr = cosf(P.roll), sr = sinf(P.roll), cp = cosf(P.pitch), sp = sinf(P.pitch), cy = cosf(P.yaw), sy = sinf(P.yaw);
  float ax = x * cr - y * sr, ay = x * sr + y * cr, az = z;
  float bx = ax, by = ay * cp + az * sp, bz = -ay * sp + az * cp;
  return {bx * cy + bz * sy + P.pos.x, by + P.pos.y, -bx * sy + bz * cy + P.pos.z};
}

// Camera keys
float ckTime(int k) { return SC_CAMKEYS[k].t; }
int ckEase(int k) { return SC_CAMKEYS[k].ease; }
void ckVal(int k, float *o) {
  const SCamKey &K = SC_CAMKEYS[k];
  if (K.mode == 0) { for (int j = 0; j < 6; j++) o[j] = K.a[j]; return; }
  const Pose &P = poses[K.model];
  if (!P.valid) { o[0] = 0; o[1] = 10; o[2] = -30; o[3] = 0; o[4] = 10; o[5] = 0; return; }
  V3 fwd = {sinf(P.yaw), 0, cosf(P.yaw)}, right = {cosf(P.yaw), 0, -sinf(P.yaw)};
  V3 eye = P.pos - fwd * K.a[0] + right * K.a[1] + V3{0, K.a[2], 0};
  V3 look = P.pos + fwd * K.a[3] - right * K.a[4] + V3{0, K.a[5], 0};
  o[0] = eye.x; o[1] = eye.y; o[2] = eye.z; o[3] = look.x; o[4] = look.y; o[5] = look.z;
}

// ---------- fixed point ----------
// The ESP32-C3 has no FPU, so the per-frame hot paths (camera transform, projection,
// clipping, filling, lines, window lights) use integers: positions in Q16.16
// (1.0 = 65536) and screen coordinates in Q4 (1 pixel = 16), which the chip's
// hardware multiply/divide handle directly. Animation, aiming the camera and the
// billboard texture mapping still use float: they run only a few times per frame.
typedef int32_t fx;
struct V3i { fx x, y, z; };
struct P2 { int32_t x, y; };   // screen position, 1/16 pixel units
inline fx toFx(float v) { return (fx)lrintf(v * 65536.0f); }
inline V3i toFx3(V3 v) { return {toFx(v.x), toFx(v.y), toFx(v.z)}; }
inline int32_t ceilDiv16(int32_t v) { return -((-v) >> 4); }
inline int32_t clampi(int32_t v, int32_t a, int32_t b) { return v < a ? a : (v > b ? b : v); }
const fx NEAR_FX = (fx)(SC_NEAR * 65536.0f + 0.5f);
const int32_t FOCAL4 = (int32_t)(SC_FOCAL * 16.0f + 0.5f);   // focal length in 1/16 pixels
const int32_t COORD_LIMIT = 8000 * 16;                       // keep projected points within +-8000 px

// Dither level 0..16 from a 0..1 density: Bayer value b is lit when b < level * 16,
// which for whole-number b is the same as b < ceil(level * 16).
inline int ditherLevel(float level) { return level <= 0 ? 0 : level >= 1 ? 16 : (int)ceilf(level * 16); }
inline bool ditherI(int x, int y, int level16) { return BAYER[(y & 3) * 4 + (x & 3)] < level16; }

// ---------- camera + drawing primitives ----------
V3 camEye, camR, camU, camF;   // float copy, for the few float paths
V3i camEyeI, camRI, camUI, camFI;
void lookAt(V3 eye, V3 look) {
  camEye = eye;
  camF = norm(look - eye);
  camR = norm(V3{camF.z, 0, -camF.x});
  camU = cross(camF, camR);
  camEyeI = toFx3(camEye); camRI = toFx3(camR); camUI = toFx3(camU); camFI = toFx3(camF);
}

// World point (Q16) -> camera space (Q16): three dot products in 64-bit, shifted once
inline V3i toCamI(V3i p) {
  int64_t dx = p.x - camEyeI.x, dy = p.y - camEyeI.y, dz = p.z - camEyeI.z;
  return {(fx)((dx * camRI.x + dy * camRI.y + dz * camRI.z) >> 16),
          (fx)((dx * camUI.x + dy * camUI.y + dz * camUI.z) >> 16),
          (fx)((dx * camFI.x + dy * camFI.y + dz * camFI.z) >> 16)};
}
// Camera space (Q16, z >= near) -> screen (Q4). Works at Q8 so it's one 32-bit divide per axis.
inline P2 projectI(const V3i &c) {
  int32_t zq = c.z >> 8; if (zq < 1) zq = 1;
  int32_t xq = clampi(c.x >> 8, -3000000, 3000000), yq = clampi(c.y >> 8, -3000000, 3000000);
  return {(W / 2) * 16 + (int32_t)((int64_t)FOCAL4 * xq / zq), (H / 2) * 16 - (int32_t)((int64_t)FOCAL4 * yq / zq)};
}
inline P2 floatToP2(float x, float y) { return {(int32_t)lrintf(clampf(x, -8000, 8000) * 16), (int32_t)lrintf(clampf(y, -8000, 8000) * 16)}; }

// world point (float) -> camera space (Q16)
inline V3i camI(V3 p) { return toCamI(toFx3(p)); }
// world point -> pixel; false when it's behind the near plane
inline bool screenI(V3 p, int &x, int &y) {
  V3i c = camI(p);
  if (c.z < NEAR_FX) return false;
  P2 s = projectI(c);
  x = s.x >> 4; y = s.y >> 4;
  return true;
}

inline void px(int x, int y, bool on) {
  if ((unsigned)x >= W || (unsigned)y >= H) return;
  u8g2.setDrawColor(on ? 1 : 0);
  u8g2.drawPixel(x, y);
  u8g2.setDrawColor(1);
}

// Line between two Q4 points, clipped to the screen (Liang-Barsky on integers)
void lineI(P2 a, P2 b, int level16 = 16) {
  const int32_t X1 = (W - 1) * 16, Y1 = (H - 1) * 16;
  a.x = clampi(a.x, -COORD_LIMIT, COORD_LIMIT); a.y = clampi(a.y, -COORD_LIMIT, COORD_LIMIT);
  b.x = clampi(b.x, -COORD_LIMIT, COORD_LIMIT); b.y = clampi(b.y, -COORD_LIMIT, COORD_LIMIT);
  bool inside = a.x >= 0 && a.x <= X1 && b.x >= 0 && b.x <= X1 && a.y >= 0 && a.y <= Y1 && b.y >= 0 && b.y <= Y1;
  if (!inside) {
    // parameters t0/t1 as fractions num/den, compared with 64-bit cross-multiplication
    int32_t dx = b.x - a.x, dy = b.y - a.y;
    int64_t t0n = 0, t0d = 1, t1n = 1, t1d = 1;
    int32_t p[4] = {-dx, dx, -dy, dy}, q[4] = {a.x, X1 - a.x, a.y, Y1 - a.y};
    for (int i = 0; i < 4; i++) {
      if (p[i] == 0) { if (q[i] < 0) return; continue; }
      int64_t rn = q[i], rd = p[i];
      if (rd < 0) { rn = -rn; rd = -rd; }   // r = rn/rd with rd > 0
      if (p[i] < 0) { if (rn * t1d > t1n * rd) return; if (rn * t0d > t0n * rd) { t0n = rn; t0d = rd; } }
      else { if (rn * t0d < t0n * rd) return; if (rn * t1d < t1n * rd) { t1n = rn; t1d = rd; } }
    }
    P2 na = {a.x + (int32_t)(dx * t0n / t0d), a.y + (int32_t)(dy * t0n / t0d)};
    P2 nb = {a.x + (int32_t)(dx * t1n / t1d), a.y + (int32_t)(dy * t1n / t1d)};
    a = na; b = nb;
  }
  int ax = (a.x + 8) >> 4, ay = (a.y + 8) >> 4, bx = (b.x + 8) >> 4, by = (b.y + 8) >> 4;
  int sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1, ex = abs(bx - ax), ey = -abs(by - ay), err = ex + ey;
  for (int guard = 0; guard < 400; guard++) {
    if (level16 >= 16 || ditherI(ax, ay, level16)) px(ax, ay, true);
    if (ax == bx && ay == by) break;
    int e2 = 2 * err;
    if (e2 >= ey) { err += ey; ax += sx; }
    if (e2 <= ex) { err += ex; ay += sy; }
  }
}
void line(float x0, float y0, float x1, float y1, float density = 1) { lineI(floatToP2(x0, y0), floatToP2(x1, y1), ditherLevel(density)); }

const int MAXV = 10;
// Clip a camera-space polygon at the near plane and project it (all integer)
int clipProjectI(const V3i *in, int n, P2 *out) {
  V3i v[MAXV]; int m = 0;
  for (int i = 0; i < n && m < MAXV - 1; i++) {
    const V3i &a = in[i], &b = in[(i + 1) % n];
    bool ia = a.z >= NEAR_FX, ib = b.z >= NEAR_FX;
    if (ia) v[m++] = a;
    if (ia != ib) {
      int64_t num = NEAR_FX - a.z, den = b.z - a.z;   // rare (only edges crossing the near plane), so a 64-bit divide is fine
      v[m++] = {a.x + (fx)((b.x - a.x) * num / den), a.y + (fx)((b.y - a.y) * num / den), NEAR_FX};
    }
  }
  for (int i = 0; i < m; i++) out[i] = projectI(v[i]);
  return m;
}

// Scanline fill of a Q4 polygon. level16 < 0: solid black; otherwise a dither level 0..16.
int16_t spanL[H], spanR[H];
void fillPolyI(const P2 *p, int n, int level16) {
  int yTop = H, yBot = -1;
  for (int y = 0; y < H; y++) { spanL[y] = 32767; spanR[y] = -32768; }
  for (int i = 0; i < n; i++) {
    int32_t ax = clampi(p[i].x, -COORD_LIMIT, COORD_LIMIT), ay = clampi(p[i].y, -COORD_LIMIT, COORD_LIMIT);
    int32_t bx = clampi(p[(i + 1) % n].x, -COORD_LIMIT, COORD_LIMIT), by = clampi(p[(i + 1) % n].y, -COORD_LIMIT, COORD_LIMIT);
    if (ay == by) continue;
    if (ay > by) { int32_t t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; }
    int r0 = max(0, (int)ceilDiv16(ay - 8)), r1 = min(H - 1, (int)ceilDiv16(by - 8) - 1);
    if (r0 > r1) continue;
    int32_t slope = (int32_t)(((int64_t)(bx - ax) << 12) / (by - ay));         // x per row, Q12
    int32_t x = (ax << 8) + (int32_t)(((int64_t)(r0 * 16 + 8 - ay) * slope) >> 4);   // Q12
    for (int y = r0; y <= r1; y++, x += slope) {
      int xi = x >> 12;
      if (xi < spanL[y]) spanL[y] = xi;
      if (xi > spanR[y]) spanR[y] = xi;
    }
    yTop = min(yTop, r0); yBot = max(yBot, r1);
  }
  for (int y = yTop; y <= yBot; y++) {
    int a = max(0, (int)spanL[y] + 1), b = min(W - 1, (int)spanR[y]);
    if (a > b) continue;
    if (level16 < 0) { u8g2.setDrawColor(0); u8g2.drawHLine(a, y, b - a + 1); u8g2.setDrawColor(1); }
    else for (int x = a; x <= b; x++) px(x, y, ditherI(x, y, level16));
  }
}
void outlinePolyI(const P2 *p, int n, int level16) {
  for (int i = 0; i < n; i++) lineI(p[i], p[(i + 1) % n], level16);
}

uint32_t hash32(uint32_t n) { uint32_t h = n * 2654435761u; h ^= h >> 13; h *= 0x5bd1e995u; h ^= h >> 15; return h; }
bool windowLit(uint32_t id, int i, int j, float t, int density) {
  uint32_t h = ((id & 0xffff) * 2654435761u) ^ (uint32_t)(i * 97 + j * 131);
  h ^= h >> 13; h *= 0x5bd1e995u; h ^= h >> 15;
  bool lit = (int)(h & 255) < density;
  if (((h >> 8) & 255) < 20 && ((int)(t * 6 + (h >> 16)) % 9) == 0) lit = !lit;
  return lit;
}

// ---------- scene drawing ----------
// faces: -z, +x, +z, -x, top, bottom (bottom only shows when the camera is below the box)
const uint8_t FACE_CORNERS[6][4] = {{0, 1, 3, 2}, {1, 5, 7, 3}, {5, 4, 6, 7}, {4, 0, 2, 6}, {2, 3, 7, 6}, {4, 5, 1, 0}};
// Box geometry in Q16, converted once at startup: x0 x1 y0 y1 z0 z1, centre, radius
struct BoxI { fx lo[3], hi[3]; V3i centre; fx radius; };
BoxI boxI[SC_NBOX > 0 ? SC_NBOX : 1];
V3i boxCam[SC_NBOX > 0 ? SC_NBOX : 1][8];
V3 mWorld[SC_NVERT > 0 ? SC_NVERT : 1];
V3i mCam[SC_NVERT > 0 ? SC_NVERT : 1];

void prepareBoxes() {
  for (int bi = 0; bi < SC_NBOX; bi++) {
    const SBox &b = SC_BOXES[bi];
    BoxI &B = boxI[bi];
    B.lo[0] = toFx(b.x0); B.hi[0] = toFx(b.x1); B.lo[1] = toFx(b.y0); B.hi[1] = toFx(b.y1); B.lo[2] = toFx(b.z0); B.hi[2] = toFx(b.z1);
    B.centre = toFx3({(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2});
    B.radius = toFx(max(max(b.x1 - b.x0, b.z1 - b.z0), b.y1 - b.y0) * 0.8f);
  }
}

struct Entry { fx depth; uint8_t type; uint16_t obj, face; };
const int MAX_ENTRIES = 420;
Entry entries[MAX_ENTRIES];
int nEntries;

void drawBoxFace(const Entry &E, float t) {
  const SBox &b = SC_BOXES[E.obj];
  V3i cc[4];
  for (int i = 0; i < 4; i++) cc[i] = boxCam[E.obj][FACE_CORNERS[E.face][i]];
  P2 pts[MAXV];
  int m = clipProjectI(cc, 4, pts);
  if (m < 3) return;
  int32_t bx0 = INT32_MAX, bx1 = INT32_MIN, by0 = INT32_MAX, by1 = INT32_MIN;
  for (int i = 0; i < m; i++) { bx0 = min(bx0, pts[i].x); bx1 = max(bx1, pts[i].x); by0 = min(by0, pts[i].y); by1 = max(by1, pts[i].y); }
  if (bx1 < 0 || bx0 >= W * 16 || by1 < 0 || by0 >= H * 16) return;
  fillPolyI(pts, m, -1);
  float fog = clampf(1.3f - (E.depth / 65536.0f) / SC_FOGDIST, 0, 1);
  if (b.flags & 2) fog = max(fog, 0.6f);
  const int fog16 = ditherLevel(fog);
  if ((b.flags & 1) && fog > 0.05f) outlinePolyI(pts, m, fog > 0.7f ? 16 : fog16);

  bool allFront = cc[0].z >= NEAR_FX && cc[1].z >= NEAR_FX && cc[2].z >= NEAR_FX && cc[3].z >= NEAR_FX;
  if (E.face < 4 && fog16 > 0 && allFront && b.style != 0 && b.win > 0) {
    P2 P[4];
    for (int i = 0; i < 4; i++) P[i] = projectI(cc[i]);
    float wdth = (E.face == 1 || E.face == 3) ? b.z1 - b.z0 : b.x1 - b.x0;
    int cols = max(1, (int)(wdth / SC_WINX)), rows = max(1, (int)((b.y1 - b.y0) / SC_WINY));
    int32_t spanX = max(abs(P[1].x - P[0].x), abs(P[2].x - P[3].x)), spanY = max(abs(P[3].y - P[0].y), abs(P[2].y - P[1].y));
    // windows closer together than ~2 px are thinned out
    int stepI = max<int32_t>(1, (cols * 32 + max<int32_t>(32, spanX) - 1) / max<int32_t>(32, spanX));
    int stepJ = max<int32_t>(1, (rows * 32 + max<int32_t>(32, spanY) - 1) / max<int32_t>(32, spanY));
    // Strongly foreshortened faces (seen at a steep angle) need perspective-correct
    // placement; otherwise stepping across the projected corners is cheaper and close enough.
    fx zMin = min(min(cc[0].z, cc[1].z), min(cc[2].z, cc[3].z)), zMax = max(max(cc[0].z, cc[1].z), max(cc[2].z, cc[3].z));
    bool persp = (int64_t)zMax * 5 > (int64_t)zMin * 8;   // zMax > 1.6 zMin
    const uint32_t id = b.seed + E.face * 7;
    for (int j = 1; j < rows; j += stepJ) {
      if (b.style == 2 && j % 3 != 1) continue;
      if (persp) {
        // left and right edge points of this row in camera space, then step across
        V3i L = {cc[0].x + (cc[3].x - cc[0].x) / rows * j, cc[0].y + (cc[3].y - cc[0].y) / rows * j, cc[0].z + (cc[3].z - cc[0].z) / rows * j};
        V3i R = {cc[1].x + (cc[2].x - cc[1].x) / rows * j, cc[1].y + (cc[2].y - cc[1].y) / rows * j, cc[1].z + (cc[2].z - cc[1].z) / rows * j};
        V3i d = {(R.x - L.x) / cols, (R.y - L.y) / cols, (R.z - L.z) / cols};
        for (int i = 1; i < cols; i += stepI) {
          if (!windowLit(id, i, j, t, b.win)) continue;
          P2 s = projectI({L.x + d.x * i, L.y + d.y * i, L.z + d.z * i});
          int sx = s.x >> 4, sy = s.y >> 4;
          if ((unsigned)sx >= W || (unsigned)sy >= H) continue;
          if (fog16 >= 16 || ditherI(sx, sy, fog16)) px(sx, sy, true);
        }
      } else {
        int32_t lx = P[0].x + (P[3].x - P[0].x) * j / rows, ly = P[0].y + (P[3].y - P[0].y) * j / rows;
        int32_t rx = P[1].x + (P[2].x - P[1].x) * j / rows, ry = P[1].y + (P[2].y - P[1].y) * j / rows;
        if ((ly < -16 && ry < -16) || (ly > H * 16 && ry > H * 16)) continue;
        for (int i = 1; i < cols; i += stepI) {
          if (!windowLit(id, i, j, t, b.win)) continue;
          int sx = (lx + (rx - lx) * i / cols) >> 4, sy = (ly + (ry - ly) * i / cols) >> 4;
          if ((unsigned)sx >= W || (unsigned)sy >= H) continue;
          if (fog16 >= 16 || ditherI(sx, sy, fog16)) px(sx, sy, true);
        }
      }
    }
  }
}

void billboardCorners(const SBillboard &bb, V3 *q) {
  V3 r = {-cosf(bb.yaw), 0, sinf(bb.yaw)}, c = {bb.x, bb.y, bb.z};
  float hw = bb.w / 2, hh = bb.h / 2;
  q[0] = c - r * hw + V3{0, hh, 0}; q[1] = c + r * hw + V3{0, hh, 0};
  q[2] = c + r * hw - V3{0, hh, 0}; q[3] = c - r * hw - V3{0, hh, 0};
}

// Billboards stay in float: the per-pixel texture lookup needs a divide either way,
// and only a few hundred pixels are covered when one is on screen.
void drawBillboard(int bi, float t) {
  const SBillboard &bb = SC_BBS[bi];
  V3 w[4];
  billboardCorners(bb, w);
  P2 Q[4];
  for (int i = 0; i < 4; i++) { V3i c = camI(w[i]); if (c.z < NEAR_FX) return; Q[i] = projectI(c); }
  // Screen -> texture is a projective map. It's set up once per billboard in double (the
  // editor gets the identical result), then each pixel is 32-bit integer adds and a divide.
  double X[4], Y[4];
  for (int i = 0; i < 4; i++) { X[i] = Q[i].x / 16.0; Y[i] = Q[i].y / 16.0; }
  double dx1 = X[1] - X[2], dx2 = X[3] - X[2], dx3 = X[0] - X[1] + X[2] - X[3];
  double dy1 = Y[1] - Y[2], dy2 = Y[3] - Y[2], dy3 = Y[0] - Y[1] + Y[2] - Y[3];
  double den = dx1 * dy2 - dx2 * dy1;
  if (fabs(den) < 1e-4) return;
  double g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  double a = X[1] - X[0] + g * X[1], b = X[3] - X[0] + h * X[3], cc = X[0];
  double d = Y[1] - Y[0] + g * Y[1], e = Y[3] - Y[0] + h * Y[3], f = Y[0];
  double A = e - f * h, B = cc * h - b, C = b * f - cc * e;
  double D = f * g - d, E = a - cc * g, F = cc * d - a * f;
  double G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  int32_t qx0 = min(min(Q[0].x, Q[1].x), min(Q[2].x, Q[3].x)), qx1 = max(max(Q[0].x, Q[1].x), max(Q[2].x, Q[3].x));
  int32_t qy0 = min(min(Q[0].y, Q[1].y), min(Q[2].y, Q[3].y)), qy1 = max(max(Q[0].y, Q[1].y), max(Q[2].y, Q[3].y));
  int x0 = max<int32_t>(0, qx0 >> 4), x1 = min<int32_t>(W - 1, ceilDiv16(qx1));
  int y0 = max<int32_t>(0, qy0 >> 4), y1 = min<int32_t>(H - 1, ceilDiv16(qy1));
  if (x0 > x1 || y0 > y1) return;
  // Scale so U, V and W stay under 2^23 across the box (they're linear, so its corners
  // bound them), with W positive inside the billboard
  double m = 0;
  for (int k = 0; k < 4; k++) {
    double px_ = ((k & 1) ? x1 : x0) + 0.5, py_ = ((k & 2) ? y1 : y0) + 0.5;
    m = fmax(m, fabs(A * px_ + B * py_ + C)); m = fmax(m, fabs(D * px_ + E * py_ + F)); m = fmax(m, fabs(G * px_ + Hh * py_ + I));
  }
  if (!(m > 0)) return;
  double sc = 1;
  while (m * sc >= 8388608.0) sc *= 0.5;
  while (m * sc < 4194304.0) sc *= 2;
  double mx = (X[0] + X[1] + X[2] + X[3]) / 4, my = (Y[0] + Y[1] + Y[2] + Y[3]) / 4;
  if (G * mx + Hh * my + I < 0) sc = -sc;
  auto toI = [&](double v) { v = floor(v * sc + 0.5); return (int32_t)(v > 1e9 ? 1e9 : v < -1e9 ? -1e9 : v); };
  const double fx0 = x0 + 0.5, fy0 = y0 + 0.5;
  int32_t U0 = toI(A * fx0 + B * fy0 + C), V0 = toI(D * fx0 + E * fy0 + F), W0 = toI(G * fx0 + Hh * fy0 + I);
  int32_t Ax = toI(A), Dx = toI(D), Gx = toI(G), By = toI(B), Ey = toI(E), Hy = toI(Hh);

  float total = 0;
  for (int i = 0; i < bb.nframes; i++) total += bb.dur[i];
  float ft = total > 0 ? fmodf(t, total) : 0;
  int fi = 0;
  while (fi < bb.nframes - 1 && ft >= bb.dur[fi]) { ft -= bb.dur[fi]; fi++; }
  int rowBytes = (bb.tw + 7) / 8;
  const uint8_t *tex = SC_TEX + bb.texOff + fi * rowBytes * bb.th;
  bool glitch = (bb.flags & 2) && fmodf(t * 1.7f, 4.0f) < 0.12f;
  int scan = (bb.flags & 1) ? (int)(t * 20) % (bb.th + 10) : -100;
  for (int y = y0; y <= y1; y++) {
    int32_t U = U0 + By * (y - y0), V = V0 + Ey * (y - y0), Wd = W0 + Hy * (y - y0);
    for (int x = x0; x <= x1; x++, U += Ax, V += Dx, Wd += Gx) {
      if (Wd <= 0 || U < 0 || U >= Wd || V < 0 || V >= Wd) continue;
      int ty = V * bb.th / Wd, tx = U * bb.tw / Wd + (glitch && ((ty / 4) % 3) == 0 ? 3 : 0);
      bool on = tx < bb.tw && ((tex[ty * rowBytes + (tx >> 3)] >> (tx & 7)) & 1) && ty != scan && ty != scan - 1;
      px(x, y, on);
    }
  }
  if (bb.flags & 4) for (int i = 0; i < 4; i++) lineI(Q[i], Q[(i + 1) % 4]);
}

const V3 LIGHT = {SC_LIGHT_X, SC_LIGHT_Y, SC_LIGHT_Z};

V3 faceNormal(int mi, int fi, V3 &fcOut) {
  const uint8_t *F = SC_MFACES + (SC_MODELS[mi].fOff + fi) * 6;
  uint16_t vo = SC_MODELS[mi].vOff;
  V3 nrm = norm(cross(mWorld[vo + F[2]] - mWorld[vo + F[1]], mWorld[vo + F[3]] - mWorld[vo + F[1]]));
  V3 fc = {0, 0, 0};
  for (int k = 0; k < F[0]; k++) fc = fc + mWorld[vo + F[1 + k]];
  fcOut = fc * (1.0f / F[0]);
  V3 centre = modelToWorld(mi, poses[mi], {0, 0.4f, -0.2f});
  if (dot(nrm, fcOut - centre) < 0) nrm = nrm * -1;
  return nrm;
}

void drawModelFace(const Entry &E) {
  int mi = E.obj;
  const uint8_t *F = SC_MFACES + (SC_MODELS[mi].fOff + E.face) * 6;
  uint16_t vo = SC_MODELS[mi].vOff;
  V3i poly[4];
  for (int k = 0; k < F[0]; k++) poly[k] = mCam[vo + F[1 + k]];
  P2 pts[MAXV];
  int m = clipProjectI(poly, F[0], pts);
  if (m < 3) return;
  int level16 = -1;
  if (!F[5]) { V3 fc; V3 nrm = faceNormal(mi, E.face, fc); level16 = ditherLevel(0.12f + 0.6f * max(0.0f, dot(nrm, LIGHT))); }
  fillPolyI(pts, m, level16);
  outlinePolyI(pts, m, 16);
}

void drawStrip(const SStrip &s, float t) {
  int chase = (int)(t * s.rate) % 4;
  bool blinkOn = ((int)floorf(t * s.rate) & 1) == 1;
  int k = 0;
  auto point = [&](V3 p) {
    bool show = true;
    if (s.mode == 4 && (k % 4) != chase) show = false;
    if ((s.mode == 1 || s.mode == 2) && !blinkOn) show = false;
    if (s.mode == 3 && fmodf(t * s.rate, 1) >= 0.15f) show = false;
    k++;
    if (!show) return;
    int sx, sy;
    if (screenI(p, sx, sy)) px(sx, sy, true);
  };
  auto along = [&](V3 a, V3 b) {
    float len = sqrtf(dot(b - a, b - a));
    int n = max(1, (int)floorf(len / s.spacing));
    for (int i = 0; i < n; i++) point(lerp3(a, b, (float)i / n));
  };
  if (s.shape == 1) {
    float y = s.ay;
    along({s.ax, y, s.az}, {s.bx, y, s.az}); along({s.bx, y, s.az}, {s.bx, y, s.bz});
    along({s.bx, y, s.bz}, {s.ax, y, s.bz}); along({s.ax, y, s.bz}, {s.ax, y, s.az});
  } else { along({s.ax, s.ay, s.az}, {s.bx, s.by, s.bz}); point({s.bx, s.by, s.bz}); }
}

// Draw one frame into the buffer (renderScene also sends it to the screen)
void drawScene(float t) {
  u8g2.clearBuffer();
  for (int i = 0; i < SC_NMODEL; i++) poses[i] = modelPose(i, t);
  float cv[6] = {0, 10, -30, 0, 10, 0};
  if (SC_NCAM > 0) interpKeys(SC_NCAM, t, 6, ckTime, ckVal, ckEase, cv);
  lookAt({cv[0], cv[1], cv[2]}, {cv[3], cv[4], cv[5]});

  for (int mi = 0; mi < SC_NMODEL; mi++) {
    if (!poses[mi].valid) continue;
    const SModel &m = SC_MODELS[mi];
    for (int k = 0; k < m.nV; k++) {
      const float *v = SC_MVERTS + (m.vOff + k) * 3;
      mWorld[m.vOff + k] = modelToWorld(mi, poses[mi], {v[0], v[1], v[2]});
      mCam[m.vOff + k] = toCamI(toFx3(mWorld[m.vOff + k]));
    }
  }

  nEntries = 0;
  const fx FAR_FX = toFx(SC_FAR), K13 = toFx(1.3f), K08 = toFx(0.8f), TWO = 2 * 65536;
  for (int bi = 0; bi < SC_NBOX; bi++) {
    const BoxI &B = boxI[bi];
    V3i cc = toCamI(B.centre);
    if (cc.z + B.radius < NEAR_FX || cc.z - B.radius > FAR_FX) continue;
    if (abs(cc.x) - B.radius > (fx)(((int64_t)cc.z * K13) >> 16) + TWO) continue;
    if (abs(cc.y) - B.radius > (fx)(((int64_t)cc.z * K08) >> 16) + TWO) continue;
    for (int k = 0; k < 8; k++) boxCam[bi][k] = toCamI({(k & 1) ? B.hi[0] : B.lo[0], (k & 2) ? B.hi[1] : B.lo[1], (k & 4) ? B.hi[2] : B.lo[2]});
    const V3i &e = camEyeI;
    bool vis[6] = {e.z < B.lo[2], e.x > B.hi[0], e.z > B.hi[2], e.x < B.lo[0], e.y > B.hi[1], e.y < B.lo[1]};
    for (int f = 0; f < 6 && nEntries < MAX_ENTRIES; f++) {
      if (!vis[f]) continue;
      fx d = 0;
      for (int i = 0; i < 4; i++) d += boxCam[bi][FACE_CORNERS[f][i]].z >> 2;
      entries[nEntries++] = {d, 0, (uint16_t)bi, (uint16_t)f};
    }
  }
  for (int i = 0; i < SC_NBB && nEntries < MAX_ENTRIES; i++) {
    const SBillboard &bb = SC_BBS[i];
    V3 n = {sinf(bb.yaw), 0, cosf(bb.yaw)};
    if (dot(n, camEye - V3{bb.x, bb.y, bb.z}) <= 0) continue;
    V3 w[4]; billboardCorners(bb, w);
    fx d = 0;
    for (int k = 0; k < 4; k++) d += camI(w[k]).z >> 2;
    entries[nEntries++] = {d - toFx(0.3f), 1, (uint16_t)i, 0};
  }
  for (int mi = 0; mi < SC_NMODEL; mi++) {
    if (!poses[mi].valid) continue;
    const SModel &m = SC_MODELS[mi];
    for (int fi = 0; fi < m.nF && nEntries < MAX_ENTRIES; fi++) {
      const uint8_t *F = SC_MFACES + (m.fOff + fi) * 6;
      if (F[0] < 3) continue;
      V3 fc; V3 nrm = faceNormal(mi, fi, fc);
      if (dot(nrm, camEye - fc) <= 0) continue;
      int64_t d = 0;
      for (int k = 0; k < F[0]; k++) d += mCam[m.vOff + F[1 + k]].z;
      entries[nEntries++] = {(fx)(d / F[0]), 2, (uint16_t)mi, (uint16_t)fi};
    }
  }
  // Painter's algorithm: far to near
  for (int i = 1; i < nEntries; i++) {
    Entry k = entries[i]; int j = i - 1;
    while (j >= 0 && entries[j].depth < k.depth) { entries[j + 1] = entries[j]; j--; }
    entries[j + 1] = k;
  }
  for (int i = 0; i < nEntries; i++) {
    const Entry &E = entries[i];
    if (E.type == 0) drawBoxFace(E, t);
    else if (E.type == 1) drawBillboard(E.obj, t);
    else drawModelFace(E);
  }

  for (int i = 0; i < SC_NSTRIP; i++) drawStrip(SC_STRIPS[i], t);

  for (int mi = 0; mi < SC_NMODEL; mi++) {
    const Pose &P = poses[mi];
    if (!P.valid) continue;
    const SModel &m = SC_MODELS[mi];
    for (int li = 0; li < m.nL; li++) {
      const SModelLight &l = SC_MLIGHTS[m.lOff + li];
      bool on = true;
      if (l.mode == 1 || l.mode == 2) on = ((int)floorf(t * l.rate + l.phase) & 1) == 1;
      else if (l.mode == 3) on = fmodf(t * l.rate + l.phase, 1) < 0.15f;
      if (!on) continue;
      int ix, iy;
      if (!screenI(modelToWorld(mi, P, {l.x, l.y, l.z}), ix, iy)) continue;
      px(ix, iy, true); px(ix + 1, iy, true); px(ix, iy - 1, true);
    }
    if (!P.powered) continue;
    if (m.flags & 2)
      for (int s = -1; s <= 1; s += 2) {
        V3i a = camI(modelToWorld(mi, P, {0.4f * s, 0.25f, m.zFront})), b = camI(modelToWorld(mi, P, {1.6f * s, -1.2f, m.zFront + 10}));
        if (a.z < NEAR_FX || b.z < NEAR_FX) continue;
        lineI(projectI(a), projectI(b), ditherLevel(0.3f));
      }
    if (m.flags & 4)
      for (int k = 0; k < 3; k++) {
        if (((int)floorf(t * 30) + k) % 3 == 0) continue;
        int sx, sy;
        if (screenI(modelToWorld(mi, P, {(k - 1) * 0.6f, m.yMin - 0.15f, -0.4f - k * 0.3f}), sx, sy)) px(sx, sy, true);
      }
  }

  // Rain: each drop's position is a function of time
  for (int i = 0; i < SC_RAIN_COUNT; i++) {
    uint32_t h = hash32(i * 7919 + 13);
    float v = SC_RAIN_SPEED * (1 + (h % 35) / 60.0f), period = H + 16;
    float y = fmodf(t * v + (h >> 8) % 97, period) - 10;
    float x = (float)((h >> 4) % (W + 14)) - (y + 10) * SC_RAIN_SLANT;
    line(x, y, x + 1, y - 3);
  }

  float f = 0;
  if (SC_FADEIN > 0 && t < SC_FADEIN) f = 1 - span(t, 0, SC_FADEIN);
  else if (SC_FADEOUT > 0 && t >= SC_DURATION - SC_FADEOUT) f = span(t, SC_DURATION - SC_FADEOUT, SC_DURATION - 0.3f);
  if (f > 0) {
    u8g2.setDrawColor(0);
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (BAYER[(y & 3) * 4 + (x & 3)] < f * 16) u8g2.drawPixel(x, y);
    u8g2.setDrawColor(1);
  }
}
void renderScene(float t) { drawScene(t); u8g2.sendBuffer(); }

// "bench" over serial: time every 0.1 s of the loop, drawing and sending separately.
// Prints "bench <t> <draw us> <send us>" per frame, then a summary line.
void runBench() {
  uint32_t drawSum = 0, drawMax = 0, sendSum = 0, n = 0;
  float worstT = 0;
  for (int i = 0; i * 0.1f < SC_DURATION; i++, n++) {
    float t = i * 0.1f;
    uint32_t a = micros();
    drawScene(t);
    uint32_t b = micros();
    u8g2.sendBuffer();
    uint32_t c = micros();
    drawSum += b - a; sendSum += c - b;
    if (b - a > drawMax) { drawMax = b - a; worstT = t; }
    Serial.printf("bench %.1f %u %u\n", t, (unsigned)(b - a), (unsigned)(c - b));
  }
  Serial.printf("bench done frames=%u draw_avg_us=%u draw_max_us=%u (t=%.1f) send_avg_us=%u\n",
                (unsigned)n, (unsigned)(drawSum / n), (unsigned)drawMax, worstT, (unsigned)(sendSum / n));
}

// ---------- live frames from the editor ----------
uint8_t rxFrame[360];
int rxFill = 0;
enum { WAIT_A5, WAIT_TYPE, READ_BODY } rxState = WAIT_A5;
uint32_t lastLiveFrame = 0;
bool live = false;

void readSerial() {
  while (Serial.available()) {
    if (rxState == READ_BODY) {
      int n = Serial.read(rxFrame + rxFill, 360 - rxFill);
      if (n <= 0) break;
      rxFill += n;
      if (rxFill == 360) {
        memcpy(u8g2.getBufferPtr(), rxFrame, 360);
        u8g2.sendBuffer();
        lastLiveFrame = millis();
        live = true;
        rxState = WAIT_A5;
      }
      continue;
    }
    int b = Serial.read();
    // text commands (one per line) arrive between frames
    static char cmd[16];
    static int cmdLen = 0;
    if (rxState == WAIT_A5 && b != 0xA5) {
      if (b == '\n' || b == '\r') {
        cmd[cmdLen] = 0;
        if (!strcmp(cmd, "bench")) runBench();
        cmdLen = 0;
      } else if (b >= 32 && b < 127 && cmdLen < (int)sizeof(cmd) - 1) cmd[cmdLen++] = b;
      continue;
    }
    if (rxState == WAIT_A5) rxState = (b == 0xA5) ? WAIT_TYPE : WAIT_A5;
    else if (b == 0x5A) { rxState = READ_BODY; rxFill = 0; }
    else rxState = (b == 0xA5) ? WAIT_TYPE : WAIT_A5;
  }
}

// ---------- main ----------
uint32_t sceneStart;

void setup() {
  Serial.setRxBufferSize(4096);
  Serial.begin(115200);
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.setBusClock(800000);
  u8g2.begin();
  u8g2.setContrast(255);
  prepareBoxes();
  sceneStart = millis();
}

void loop() {
  static uint32_t fpsAt = 0;
  static int frames = 0;
  readSerial();
  uint32_t now = millis();
  if (live && now - lastLiveFrame > 1500) { live = false; sceneStart = now; }
  if (live) return;

  float t = fmodf((now - sceneStart) / 1000.0f, SC_DURATION);
  renderScene(t);
  frames++;
  if (now - fpsAt >= 1000) { Serial.printf("fps %d\n", frames); frames = 0; fpsAt = now; }
}
