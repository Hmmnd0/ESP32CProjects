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

// ---------- camera + drawing primitives ----------
V3 camEye, camR, camU, camF;
void lookAt(V3 eye, V3 look) {
  camEye = eye;
  camF = norm(look - eye);
  camR = norm(V3{camF.z, 0, -camF.x});
  camU = cross(camF, camR);
}
inline V3 toCam(V3 p) { V3 d = p - camEye; return {dot(d, camR), dot(d, camU), dot(d, camF)}; }
inline void project(V3 c, float &sx, float &sy) { sx = W / 2 + SC_FOCAL * c.x / c.z; sy = H / 2 - SC_FOCAL * c.y / c.z; }

inline void px(int x, int y, bool on) {
  if ((unsigned)x >= W || (unsigned)y >= H) return;
  u8g2.setDrawColor(on ? 1 : 0);
  u8g2.drawPixel(x, y);
  u8g2.setDrawColor(1);
}

void line(float x0, float y0, float x1, float y1, float density = 1) {
  float t0 = 0, t1 = 1, dx = x1 - x0, dy = y1 - y0;
  bool inside = x0 >= 0 && x0 <= W - 1 && x1 >= 0 && x1 <= W - 1 && y0 >= 0 && y0 <= H - 1 && y1 >= 0 && y1 <= H - 1;
  if (!inside) {
    float p[4] = {-dx, dx, -dy, dy}, q[4] = {x0, W - 1 - x0, y0, H - 1 - y0};
    for (int i = 0; i < 4; i++) {
      if (p[i] == 0) { if (q[i] < 0) return; continue; }
      float r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return; if (r > t0) t0 = r; }
      else { if (r < t0) return; if (r < t1) t1 = r; }
    }
  }
  int ax = (int)roundf(x0 + dx * t0), ay = (int)roundf(y0 + dy * t0);
  int bx = (int)roundf(x0 + dx * t1), by = (int)roundf(y0 + dy * t1);
  int sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1, ex = abs(bx - ax), ey = -abs(by - ay), err = ex + ey;
  for (int guard = 0; guard < 400; guard++) {
    if (density >= 1 || dither(ax, ay, density)) px(ax, ay, true);
    if (ax == bx && ay == by) break;
    int e2 = 2 * err;
    if (e2 >= ey) { err += ey; ax += sx; }
    if (e2 <= ex) { err += ex; ay += sy; }
  }
}

const int MAXV = 10;
int clipProject(const V3 *in, int n, float *xs, float *ys) {
  V3 out[MAXV]; int m = 0;
  for (int i = 0; i < n && m < MAXV - 1; i++) {
    V3 a = in[i], b = in[(i + 1) % n];
    bool ia = a.z >= SC_NEAR, ib = b.z >= SC_NEAR;
    if (ia) out[m++] = a;
    if (ia != ib) out[m++] = lerp3(a, b, (SC_NEAR - a.z) / (b.z - a.z));
  }
  for (int i = 0; i < m; i++) project(out[i], xs[i], ys[i]);
  return m;
}

int16_t spanL[H], spanR[H];
void fillPoly(const float *xs, const float *ys, int n, float shade) {
  int yTop = H, yBot = -1;
  for (int y = 0; y < H; y++) { spanL[y] = 32767; spanR[y] = -32768; }
  for (int i = 0; i < n; i++) {
    float ax = clampf(xs[i], -8000, 8000), ay = clampf(ys[i], -8000, 8000);
    float bx = clampf(xs[(i + 1) % n], -8000, 8000), by = clampf(ys[(i + 1) % n], -8000, 8000);
    if (ay == by) continue;
    if (ay > by) { float t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; }
    int r0 = max(0, (int)ceilf(ay - 0.5f)), r1 = min(H - 1, (int)ceilf(by - 0.5f) - 1);
    if (r0 > r1) continue;
    float slope = (bx - ax) / (by - ay);
    int32_t x = (int32_t)((ax + (r0 + 0.5f - ay) * slope) * 65536.0f), dx = (int32_t)(slope * 65536.0f);
    for (int y = r0; y <= r1; y++, x += dx) {
      int xi = x >> 16;
      if (xi < spanL[y]) spanL[y] = xi;
      if (xi > spanR[y]) spanR[y] = xi;
    }
    yTop = min(yTop, r0); yBot = max(yBot, r1);
  }
  for (int y = yTop; y <= yBot; y++) {
    int a = max(0, (int)spanL[y] + 1), b = min(W - 1, (int)spanR[y]);
    if (a > b) continue;
    if (shade < 0) { u8g2.setDrawColor(0); u8g2.drawHLine(a, y, b - a + 1); u8g2.setDrawColor(1); }
    else for (int x = a; x <= b; x++) px(x, y, dither(x, y, shade));
  }
}
void outlinePoly(const float *xs, const float *ys, int n, float density) {
  for (int i = 0; i < n; i++) line(xs[i], ys[i], xs[(i + 1) % n], ys[(i + 1) % n], density);
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
V3 boxCam[SC_NBOX > 0 ? SC_NBOX : 1][8];
V3 mWorld[SC_NVERT > 0 ? SC_NVERT : 1], mCam[SC_NVERT > 0 ? SC_NVERT : 1];

struct Entry { float depth; uint8_t type; uint16_t obj, face; };
const int MAX_ENTRIES = 420;
Entry entries[MAX_ENTRIES];
int nEntries;

void drawBoxFace(const Entry &E, float t) {
  const SBox &b = SC_BOXES[E.obj];
  V3 cc[4];
  for (int i = 0; i < 4; i++) cc[i] = boxCam[E.obj][FACE_CORNERS[E.face][i]];
  float xs[MAXV], ys[MAXV];
  int m = clipProject(cc, 4, xs, ys);
  if (m < 3) return;
  float bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
  for (int i = 0; i < m; i++) { bx0 = min(bx0, xs[i]); bx1 = max(bx1, xs[i]); by0 = min(by0, ys[i]); by1 = max(by1, ys[i]); }
  if (bx1 < 0 || bx0 >= W || by1 < 0 || by0 >= H) return;
  fillPoly(xs, ys, m, -1);
  float fog = clampf(1.3f - E.depth / SC_FOGDIST, 0, 1);
  if (b.flags & 2) fog = max(fog, 0.6f);
  if ((b.flags & 1) && fog > 0.05f) outlinePoly(xs, ys, m, fog > 0.7f ? 1 : fog);

  bool allFront = cc[0].z >= SC_NEAR && cc[1].z >= SC_NEAR && cc[2].z >= SC_NEAR && cc[3].z >= SC_NEAR;
  if (E.face < 4 && fog > 0 && allFront && b.style != 0 && b.win > 0) {
    float X[4], Y[4];
    for (int i = 0; i < 4; i++) project(cc[i], X[i], Y[i]);
    float wdth = (E.face == 1 || E.face == 3) ? b.z1 - b.z0 : b.x1 - b.x0;
    int cols = max(1, (int)(wdth / SC_WINX)), rows = max(1, (int)((b.y1 - b.y0) / SC_WINY));
    float spanX = max(fabsf(X[1] - X[0]), fabsf(X[2] - X[3])), spanY = max(fabsf(Y[3] - Y[0]), fabsf(Y[2] - Y[1]));
    int stepI = max(1, (int)ceilf(cols / max(1.0f, spanX / 2))), stepJ = max(1, (int)ceilf(rows / max(1.0f, spanY / 2)));
    // Strongly foreshortened faces (seen at a steep angle) need perspective-correct
    // placement; otherwise blending the projected corners is cheaper and close enough.
    float zMin = min(min(cc[0].z, cc[1].z), min(cc[2].z, cc[3].z)), zMax = max(max(cc[0].z, cc[1].z), max(cc[2].z, cc[3].z));
    bool persp = zMax > zMin * 1.6f;
    for (int j = 1; j < rows; j += stepJ) {
      if (b.style == 2 && j % 3 != 1) continue;
      float v = (float)j / rows;
      float lx = X[0] + (X[3] - X[0]) * v, ly = Y[0] + (Y[3] - Y[0]) * v;
      float rx = X[1] + (X[2] - X[1]) * v, ry = Y[1] + (Y[2] - Y[1]) * v;
      if (!persp && ((ly < -1 && ry < -1) || (ly > H && ry > H))) continue;
      for (int i = 1; i < cols; i += stepI) {
        if (!windowLit(b.seed + E.face * 7, i, j, t, b.win)) continue;
        float u = (float)i / cols;
        int sx, sy;
        if (persp) {
          V3 q = cc[0] + (cc[1] - cc[0]) * u + (cc[3] - cc[0]) * v;
          float fx, fy; project(q, fx, fy); sx = (int)fx; sy = (int)fy;
        } else { sx = (int)(lx + (rx - lx) * u); sy = (int)(ly + (ry - ly) * u); }
        if ((unsigned)sx >= W || (unsigned)sy >= H) continue;
        if (fog >= 1 || dither(sx, sy, fog)) px(sx, sy, true);
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

void drawBillboard(int bi, float t) {
  const SBillboard &bb = SC_BBS[bi];
  V3 w[4], q[4];
  billboardCorners(bb, w);
  float X[4], Y[4];
  for (int i = 0; i < 4; i++) { q[i] = toCam(w[i]); if (q[i].z < SC_NEAR) return; project(q[i], X[i], Y[i]); }
  float dx1 = X[1] - X[2], dx2 = X[3] - X[2], dx3 = X[0] - X[1] + X[2] - X[3];
  float dy1 = Y[1] - Y[2], dy2 = Y[3] - Y[2], dy3 = Y[0] - Y[1] + Y[2] - Y[3];
  float den = dx1 * dy2 - dx2 * dy1;
  if (fabsf(den) < 1e-4f) return;
  float g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  float a = X[1] - X[0] + g * X[1], b = X[3] - X[0] + h * X[3], cc = X[0];
  float d = Y[1] - Y[0] + g * Y[1], e = Y[3] - Y[0] + h * Y[3], f = Y[0];
  float A = e - f * h, B = cc * h - b, C = b * f - cc * e;
  float D = f * g - d, E = a - cc * g, F = cc * d - a * f;
  float G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  int x0 = max(0, (int)floorf(min(min(X[0], X[1]), min(X[2], X[3])))), x1 = min(W - 1, (int)ceilf(max(max(X[0], X[1]), max(X[2], X[3]))));
  int y0 = max(0, (int)floorf(min(min(Y[0], Y[1]), min(Y[2], Y[3])))), y1 = min(H - 1, (int)ceilf(max(max(Y[0], Y[1]), max(Y[2], Y[3]))));
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
    float fy = y + 0.5f, fx = x0 + 0.5f;
    float U = A * fx + B * fy + C, V = D * fx + E * fy + F, Wd = G * fx + Hh * fy + I;
    for (int x = x0; x <= x1; x++, U += A, V += D, Wd += G) {
      if (fabsf(Wd) < 1e-6f) continue;
      float inv = 1.0f / Wd, u = U * inv, v = V * inv;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      int ty = (int)(v * bb.th), tx = (int)(u * bb.tw) + (glitch && ((ty / 4) % 3) == 0 ? 3 : 0);
      bool on = tx < bb.tw && ((tex[ty * rowBytes + (tx >> 3)] >> (tx & 7)) & 1) && ty != scan && ty != scan - 1;
      px(x, y, on);
    }
  }
  if (bb.flags & 4) for (int i = 0; i < 4; i++) line(X[i], Y[i], X[(i + 1) % 4], Y[(i + 1) % 4]);
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
  V3 poly[4];
  for (int k = 0; k < F[0]; k++) poly[k] = mCam[vo + F[1 + k]];
  float xs[MAXV], ys[MAXV];
  int m = clipProject(poly, F[0], xs, ys);
  if (m < 3) return;
  float shade = -1;
  if (!F[5]) { V3 fc; V3 nrm = faceNormal(mi, E.face, fc); shade = 0.12f + 0.6f * max(0.0f, dot(nrm, LIGHT)); }
  fillPoly(xs, ys, m, shade);
  outlinePoly(xs, ys, m, 1);
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
    V3 c = toCam(p);
    if (c.z < SC_NEAR) return;
    float sx, sy; project(c, sx, sy);
    px((int)sx, (int)sy, true);
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

void renderScene(float t) {
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
      mCam[m.vOff + k] = toCam(mWorld[m.vOff + k]);
    }
  }

  nEntries = 0;
  for (int bi = 0; bi < SC_NBOX; bi++) {
    const SBox &b = SC_BOXES[bi];
    V3 cc = toCam({(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2});
    float radius = max(max(b.x1 - b.x0, b.z1 - b.z0), b.y1 - b.y0) * 0.8f;
    if (cc.z + radius < SC_NEAR || cc.z - radius > SC_FAR) continue;
    if (fabsf(cc.x) - radius > cc.z * 1.3f + 2) continue;
    if (fabsf(cc.y) - radius > cc.z * 0.8f + 2) continue;
    for (int k = 0; k < 8; k++) boxCam[bi][k] = toCam({(k & 1) ? b.x1 : b.x0, (k & 2) ? b.y1 : b.y0, (k & 4) ? b.z1 : b.z0});
    const V3 &e = camEye;
    bool vis[6] = {e.z < b.z0, e.x > b.x1, e.z > b.z1, e.x < b.x0, e.y > b.y1, e.y < b.y0};
    for (int f = 0; f < 6 && nEntries < MAX_ENTRIES; f++) {
      if (!vis[f]) continue;
      float d = 0;
      for (int i = 0; i < 4; i++) d += boxCam[bi][FACE_CORNERS[f][i]].z;
      entries[nEntries++] = {d / 4, 0, (uint16_t)bi, (uint16_t)f};
    }
  }
  for (int i = 0; i < SC_NBB && nEntries < MAX_ENTRIES; i++) {
    const SBillboard &bb = SC_BBS[i];
    V3 n = {sinf(bb.yaw), 0, cosf(bb.yaw)};
    if (dot(n, camEye - V3{bb.x, bb.y, bb.z}) <= 0) continue;
    V3 w[4]; billboardCorners(bb, w);
    float d = 0;
    for (int k = 0; k < 4; k++) d += toCam(w[k]).z;
    entries[nEntries++] = {d / 4 - 0.3f, 1, (uint16_t)i, 0};
  }
  for (int mi = 0; mi < SC_NMODEL; mi++) {
    if (!poses[mi].valid) continue;
    const SModel &m = SC_MODELS[mi];
    for (int fi = 0; fi < m.nF && nEntries < MAX_ENTRIES; fi++) {
      const uint8_t *F = SC_MFACES + (m.fOff + fi) * 6;
      if (F[0] < 3) continue;
      V3 fc; V3 nrm = faceNormal(mi, fi, fc);
      if (dot(nrm, camEye - fc) <= 0) continue;
      float d = 0;
      for (int k = 0; k < F[0]; k++) d += mCam[m.vOff + F[1 + k]].z;
      entries[nEntries++] = {d / F[0], 2, (uint16_t)mi, (uint16_t)fi};
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
      V3 c = toCam(modelToWorld(mi, P, {l.x, l.y, l.z}));
      if (c.z < SC_NEAR) continue;
      float sx, sy; project(c, sx, sy);
      int ix = (int)sx, iy = (int)sy;
      px(ix, iy, true); px(ix + 1, iy, true); px(ix, iy - 1, true);
    }
    if (!P.powered) continue;
    if (m.flags & 2)
      for (int s = -1; s <= 1; s += 2) {
        V3 a = toCam(modelToWorld(mi, P, {0.4f * s, 0.25f, m.zFront})), b = toCam(modelToWorld(mi, P, {1.6f * s, -1.2f, m.zFront + 10}));
        if (a.z < SC_NEAR || b.z < SC_NEAR) continue;
        float ax, ay, bx, by; project(a, ax, ay); project(b, bx, by);
        line(ax, ay, bx, by, 0.3f);
      }
    if (m.flags & 4)
      for (int k = 0; k < 3; k++) {
        if (((int)floorf(t * 30) + k) % 3 == 0) continue;
        V3 c = toCam(modelToWorld(mi, P, {(k - 1) * 0.6f, m.yMin - 0.15f, -0.4f - k * 0.3f}));
        if (c.z < SC_NEAR) continue;
        float sx, sy; project(c, sx, sy);
        px((int)sx, (int)sy, true);
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
  u8g2.sendBuffer();
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
