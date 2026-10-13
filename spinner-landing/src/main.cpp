// Spinner landing (faux 3D) for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
//
// A tiny real-time 3D renderer: a chase camera follows a police spinner down a
// street canyon of box buildings, past a giant billboard of a geisha (texture
// mapped in perspective), then climbs to the police HQ and swings round as
// the spinner settles onto the rooftop pad. ~25 s loop.
//
// Rendering: painter's algorithm (faces sorted far -> near), each face filled
// black with lit edges so nearer buildings hide farther ones. Window lights
// and edges thin out with distance like fog. The spinner is flat-shaded with
// dither patterns. Prints "fps N" over USB serial once a second.
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40;
const float FOCAL = 36, NEAR_Z = 0.6f, FAR_Z = 130;
const uint8_t BAYER[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};

// ---------- small helpers ----------
struct V3 { float x, y, z; };
V3 v3(float x, float y, float z) { return {x, y, z}; }
V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
V3 operator*(V3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
V3 cross(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
V3 norm(V3 a) { float l = sqrtf(dot(a, a)); return l > 1e-6f ? a * (1 / l) : a; }
V3 lerp3(V3 a, V3 b, float t) { return a + (b - a) * t; }

float frand(float a, float b) { return a + (b - a) * (esp_random() / 4294967295.0f); }
float ease(float t) { t = constrain(t, 0.0f, 1.0f); return t * t * (3 - 2 * t); }
float span(float t, float a, float b) { return constrain((t - a) / (b - a), 0.0f, 1.0f); }
bool dither(int x, int y, float level) { return BAYER[y & 3][x & 3] < level * 16; }

void px(int x, int y, bool on) {
  if ((unsigned)x >= W || (unsigned)y >= H) return;
  u8g2.setDrawColor(on ? 1 : 0);
  u8g2.drawPixel(x, y);
  u8g2.setDrawColor(1);
}

// Line clipped to the screen first (projected points can be far off-screen)
void line(float x0, float y0, float x1, float y1, float density = 1) {
  float t0 = 0, t1 = 1, dx = x1 - x0, dy = y1 - y0;
  bool inside = x0 >= 0 && x0 <= W - 1 && x1 >= 0 && x1 <= W - 1 && y0 >= 0 && y0 <= H - 1 && y1 >= 0 && y1 <= H - 1;
  float p[4] = {-dx, dx, -dy, dy}, q[4] = {x0, W - 1 - x0, y0, H - 1 - y0};
  for (int i = 0; i < 4 && !inside; i++) {
    if (p[i] == 0) { if (q[i] < 0) return; continue; }
    float r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return; if (r > t0) t0 = r; }
    else { if (r < t0) return; if (r < t1) t1 = r; }
  }
  int ax = (int)roundf(x0 + dx * t0), ay = (int)roundf(y0 + dy * t0);
  int bx = (int)roundf(x0 + dx * t1), by = (int)roundf(y0 + dy * t1);
  int sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1, ex = abs(bx - ax), ey = -abs(by - ay), err = ex + ey;
  for (;;) {
    if (density >= 1 || dither(ax, ay, density)) px(ax, ay, true);
    if (ax == bx && ay == by) break;
    int e2 = 2 * err;
    if (e2 >= ey) { err += ey; ax += sx; }
    if (e2 <= ex) { err += ex; ay += sy; }
  }
}

// ---------- camera ----------
struct Camera { V3 eye, r, u, f; } cam;

void lookAt(V3 eye, V3 target) {
  cam.eye = eye;
  cam.f = norm(target - eye);
  cam.r = norm(v3(cam.f.z, 0, -cam.f.x));
  cam.u = cross(cam.f, cam.r);
}
V3 toCam(V3 p) { V3 d = p - cam.eye; return {dot(d, cam.r), dot(d, cam.u), dot(d, cam.f)}; }
void project(V3 c, float &sx, float &sy) { sx = W / 2 + FOCAL * c.x / c.z; sy = H / 2 - FOCAL * c.y / c.z; }

// ---------- polygon fill (camera-space polygon, clipped at the near plane) ----------
const int MAXV = 10;

// Clip against z >= NEAR_Z, project, return vertex count
int clipProject(const V3 *in, int n, float *xs, float *ys) {
  V3 out[MAXV]; int m = 0;
  for (int i = 0; i < n && m < MAXV - 1; i++) {
    V3 a = in[i], b = in[(i + 1) % n];
    bool ia = a.z >= NEAR_Z, ib = b.z >= NEAR_Z;
    if (ia) out[m++] = a;
    if (ia != ib) { float t = (NEAR_Z - a.z) / (b.z - a.z); out[m++] = lerp3(a, b, t); }
  }
  for (int i = 0; i < m; i++) project(out[i], xs[i], ys[i]);
  return m;
}

// Scanline fill. shade < 0: solid black. Otherwise dither density 0..1.
// Integer (16.16 fixed-point) edge stepping: this chip has no FPU, so the
// per-row work is kept to integer adds.
int16_t spanL[H], spanR[H];
void fillPoly(const float *xs, const float *ys, int n, float shade) {
  int yTop = H, yBot = -1;
  for (int y = 0; y < H; y++) { spanL[y] = 32767; spanR[y] = -32768; }
  for (int i = 0; i < n; i++) {
    float ax = constrain(xs[i], -8000.0f, 8000.0f), ay = constrain(ys[i], -8000.0f, 8000.0f);
    float bx = constrain(xs[(i + 1) % n], -8000.0f, 8000.0f), by = constrain(ys[(i + 1) % n], -8000.0f, 8000.0f);
    if (ay == by) continue;
    if (ay > by) { float t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; }
    int r0 = max(0, (int)ceilf(ay - 0.5f)), r1 = min(H - 1, (int)ceilf(by - 0.5f) - 1);
    if (r0 > r1) continue;
    float slope = (bx - ax) / (by - ay);
    int32_t x = (int32_t)((ax + (r0 + 0.5f - ay) * slope) * 65536.0f);
    int32_t dx = (int32_t)(slope * 65536.0f);
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

// ---------- the city ----------
struct Box { float x0, x1, y1, z0, z1; uint8_t id, kind; };   // y0 is always 0
enum { PLAIN = 0, BILLBOARD = 1, HQ = 2 };
const int MAX_BOXES = 110;
Box boxes[MAX_BOXES];
int nBoxes = 0;

// Billboard: on the street-facing (+x) wall of a left-side building
const float BB_X = -7, BB_Z0 = 86, BB_Z1 = 102, BB_Y0 = 15, BB_Y1 = 34;
// Police HQ pad
const float PAD_Y = 50, PAD_X0 = -11, PAD_X1 = 11, PAD_Z0 = 329, PAD_Z1 = 351;

void addBox(float x0, float x1, float y1, float z0, float z1, uint8_t kind) {
  if (nBoxes >= MAX_BOXES) return;
  boxes[nBoxes] = {x0, x1, y1, z0, z1, (uint8_t)random(256), kind};
  nBoxes++;
}

void buildCity() {
  nBoxes = 0;
  for (int side = -1; side <= 1; side += 2) {
    // Street-front row
    for (float z = -30; z < 290;) {
      float d = random(8, 16);
      float inner = 6 + random(0, 3), outer = inner + random(8, 14);
      float h = random(14, 46) + (random(5) == 0 ? 30 : 0);
      if (side < 0 && z < BB_Z1 + 4 && z + d > BB_Z0 - 4) {
        // the billboard building
        addBox(-20, BB_X, 44, BB_Z0 - 4, BB_Z1 + 4, BILLBOARD);
        z = BB_Z1 + 4 + 3;
        continue;
      }
      if (side < 0) addBox(-outer, -inner, h, z, z + d, PLAIN);
      else addBox(inner, outer, h, z, z + d, PLAIN);
      z += d + random(2, 5);
    }
    // Taller back row for the skyline
    for (float z = -20; z < 300;) {
      float d = random(10, 20), inner = 24 + random(0, 6), outer = inner + random(10, 18);
      float h = random(36, 80);
      if (side < 0) addBox(-outer, -inner, h, z, z + d, PLAIN);
      else addBox(inner, outer, h, z, z + d, PLAIN);
      z += d + random(3, 9);
    }
  }
  // Police HQ: stepped tower with the landing pad on top
  addBox(-24, 24, 30, 316, 364, HQ);
  addBox(-16, 16, 44, 322, 358, HQ);
  addBox(PAD_X0, PAD_X1, PAD_Y, PAD_Z0, PAD_Z1, HQ);
  // Distant towers behind the HQ
  for (int i = 0; i < 6; i++) { float x = -60 + i * 22 + random(-4, 4); addBox(x, x + 10, random(50, 95), 400 + random(0, 30), 412 + random(0, 30), PLAIN); }
}

// Face corners of a box, in order bottom-left, bottom-right, top-right, top-left
// as seen from outside. f: 0 = -z, 1 = +x, 2 = +z, 3 = -x, 4 = top
void boxFace(const Box &b, int f, V3 *c, V3 &n) {
  float x0 = b.x0, x1 = b.x1, y0 = 0, y1 = b.y1, z0 = b.z0, z1 = b.z1;
  switch (f) {
    case 0: c[0] = {x0, y0, z0}; c[1] = {x1, y0, z0}; c[2] = {x1, y1, z0}; c[3] = {x0, y1, z0}; n = {0, 0, -1}; break;
    case 1: c[0] = {x1, y0, z0}; c[1] = {x1, y0, z1}; c[2] = {x1, y1, z1}; c[3] = {x1, y1, z0}; n = {1, 0, 0}; break;
    case 2: c[0] = {x1, y0, z1}; c[1] = {x0, y0, z1}; c[2] = {x0, y1, z1}; c[3] = {x1, y1, z1}; n = {0, 0, 1}; break;
    case 3: c[0] = {x0, y0, z1}; c[1] = {x0, y0, z0}; c[2] = {x0, y1, z0}; c[3] = {x0, y1, z1}; n = {-1, 0, 0}; break;
    default: c[0] = {x0, y1, z0}; c[1] = {x1, y1, z0}; c[2] = {x1, y1, z1}; c[3] = {x0, y1, z1}; n = {0, 1, 0}; break;
  }
}

bool windowLit(uint8_t id, int i, int j, float t) {
  uint32_t h = (id * 2654435761u) ^ (i * 97 + j * 131);
  h ^= h >> 13; h *= 0x5bd1e995; h ^= h >> 15;
  bool lit = (h & 7) < 3;
  if ((h & 255) < 20 && ((int)(t * 6 + (h >> 8)) % 9) == 0) lit = !lit;
  return lit;
}

// ---------- the geisha texture (34 x 38) ----------
bool inEllipse(float x, float y, float cx, float cy, float rx, float ry) {
  float dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}
bool geishaShape(int x, int y, bool blinking) {
  bool on = (x + y) % 4 == 0;                                  // screen glow
  bool hair = inEllipse(x, y, 17, 10, 11, 9) || inEllipse(x, y, 9, 15, 6, 7) || inEllipse(x, y, 25, 15, 6, 7);
  bool rim = !hair && (inEllipse(x, y, 17, 10, 12, 10) || inEllipse(x, y, 9, 15, 7, 8) || inEllipse(x, y, 25, 15, 7, 8));
  if (rim) on = true;
  if (hair) on = ((x * 3 + y) % 11 == 0);
  bool face = inEllipse(x, y, 17, 22, 7.5f, 9.5f) && y > 14;
  if (face) {
    on = true;
    if (!blinking && ((y == 21 && (x == 13 || x == 14 || x == 20 || x == 21)) || (y == 20 && (x == 15 || x == 19)))) on = false;
    if (blinking && y == 21 && ((x >= 13 && x <= 15) || (x >= 19 && x <= 21))) on = false;
    if (y == 18 && ((x >= 12 && x <= 14) || (x >= 20 && x <= 22))) on = false;
    if (y == 27 && x >= 16 && x <= 18) on = false;
  }
  float c = fabsf(x - 17.0f), edge = 4 + (y - 31) * 1.4f;
  if (y >= 31) { if (c < 4) on = true; else if (c < edge - 1) on = false; else if (c < edge + 1) on = true; }
  return on;
}

// Baked once at startup: one row = 34 bits
uint64_t texOpen[38], texBlink[38];
void bakeGeisha() {
  for (int y = 0; y < 38; y++) {
    texOpen[y] = texBlink[y] = 0;
    for (int x = 0; x < 34; x++) {
      if (geishaShape(x, y, false)) texOpen[y] |= 1ULL << x;
      if (geishaShape(x, y, true)) texBlink[y] |= 1ULL << x;
    }
  }
}

// Draw the billboard quad (corners in camera space: TL, TR, BR, BL) via a homography
void drawBillboard(const V3 *c, float t) {
  float X[4], Y[4];
  for (int i = 0; i < 4; i++) { if (c[i].z < NEAR_Z) return; project(c[i], X[i], Y[i]); }
  float dx1 = X[1] - X[2], dx2 = X[3] - X[2], dx3 = X[0] - X[1] + X[2] - X[3];
  float dy1 = Y[1] - Y[2], dy2 = Y[3] - Y[2], dy3 = Y[0] - Y[1] + Y[2] - Y[3];
  float den = dx1 * dy2 - dx2 * dy1;
  if (fabsf(den) < 1e-4f) return;
  float g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  float a = X[1] - X[0] + g * X[1], b = X[3] - X[0] + h * X[3], cc = X[0];
  float d = Y[1] - Y[0] + g * Y[1], e = Y[3] - Y[0] + h * Y[3], f = Y[0];
  // inverse of [[a b cc][d e f][g h 1]]
  float A = e - f * h, B = cc * h - b, C = b * f - cc * e;
  float D = f * g - d, E = a - cc * g, F = cc * d - a * f;
  float G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  int x0 = max(0, (int)floorf(min(min(X[0], X[1]), min(X[2], X[3])))), x1 = min(W - 1, (int)ceilf(max(max(X[0], X[1]), max(X[2], X[3]))));
  int y0 = max(0, (int)floorf(min(min(Y[0], Y[1]), min(Y[2], Y[3])))), y1 = min(H - 1, (int)ceilf(max(max(Y[0], Y[1]), max(Y[2], Y[3]))));
  bool glitch = fmodf(t * 1.7f, 4.0f) < 0.12f;
  const uint64_t *tex = fmodf(t, 3.3f) < 0.15f ? texBlink : texOpen;
  int scan = (int)(t * 20) % 48;
  for (int y = y0; y <= y1; y++) {
    float fy = y + 0.5f, fx = x0 + 0.5f;
    // Numerators and denominator step linearly along the row; one divide per pixel
    float U = A * fx + B * fy + C, V = D * fx + E * fy + F, Wd = G * fx + Hh * fy + I;
    for (int x = x0; x <= x1; x++, U += A, V += D, Wd += G) {
      if (fabsf(Wd) < 1e-6f) continue;
      float inv = 1.0f / Wd, u = U * inv, v = V * inv;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      int ty = (int)(v * 38), tx = (int)(u * 34) + (glitch && (ty / 4) % 3 == 0 ? 3 : 0);
      bool on = tx < 34 && ((tex[ty] >> tx) & 1) && ty != scan && ty != scan - 1;
      px(x, y, on);
    }
  }
  for (int i = 0; i < 4; i++) line(X[i], Y[i], X[(i + 1) % 4], Y[(i + 1) % 4]);
}

// ---------- the spinner model ----------
const float SPS = 1.5f;   // model scale
const V3 SV[] = {
  {0, 0.2f, 2.3f},                                          // 0 nose
  {-0.8f, 0.5f, 1.2f}, {0.8f, 0.5f, 1.2f},                  // 1,2 front top
  {-0.8f, -0.2f, 1.0f}, {0.8f, -0.2f, 1.0f},                // 3,4 front bottom
  {-0.85f, 0.7f, -1.9f}, {0.85f, 0.7f, -1.9f},              // 5,6 rear top
  {-0.85f, -0.2f, -1.9f}, {0.85f, -0.2f, -1.9f},            // 7,8 rear bottom
  {-0.55f, 1.15f, 0.1f}, {0.55f, 1.15f, 0.1f},              // 9,10 canopy front
  {-0.5f, 1.1f, -1.0f}, {0.5f, 1.1f, -1.0f},                // 11,12 canopy rear
};
struct SFace { uint8_t n, v[4]; bool glass; };
const SFace SF[] = {
  {3, {0, 1, 2}, false},     // hood
  {3, {0, 4, 3}, false},     // chin
  {3, {0, 3, 1}, false},     // nose left
  {3, {0, 2, 4}, false},     // nose right
  {4, {1, 3, 7, 5}, false},  // left side
  {4, {2, 6, 8, 4}, false},  // right side
  {4, {5, 7, 8, 6}, false},  // tail
  {4, {3, 4, 8, 7}, false},  // belly
  {4, {1, 2, 10, 9}, true},  // windscreen
  {4, {9, 10, 12, 11}, false},  // canopy roof
  {4, {1, 9, 11, 5}, true},  // left window
  {4, {2, 6, 12, 10}, true}, // right window
  {4, {11, 12, 6, 5}, false},   // rear deck
};
const int NSF = sizeof(SF) / sizeof(SF[0]);

struct SpinnerPose { V3 pos; float yaw, pitch, roll; } sp;

V3 spinnerWorld(V3 m) {
  m = m * SPS;
  float cr = cosf(sp.roll), sr = sinf(sp.roll), cp = cosf(sp.pitch), spi = sinf(sp.pitch), cy = cosf(sp.yaw), sy = sinf(sp.yaw);
  V3 a = {m.x * cr - m.y * sr, m.x * sr + m.y * cr, m.z};                 // roll (about z)
  V3 b = {a.x, a.y * cp + a.z * spi, -a.y * spi + a.z * cp};             // pitch (about x), nose up when pitch > 0
  return V3{b.x * cy + b.z * sy, b.y, -b.x * sy + b.z * cy} + sp.pos;   // yaw (about y)
}

// ---------- flight path ----------
struct Key { float t; V3 p; };
const Key KEYS[] = {
  {0, {0, 20, -10}},
  {4, {2, 22, 70}},
  {8, {-1, 24, 150}},
  {12, {0, 38, 240}},
  {16, {3, 57, 318}},
  {19.5f, {0, PAD_Y + 0.3f, 340}},
};
const int NK = sizeof(KEYS) / sizeof(KEYS[0]);
const float T_TOUCHDOWN = 19.5f, T_FADE = 23.0f, T_END = 25.0f;

V3 pathAt(float t) {
  if (t <= KEYS[0].t) return KEYS[0].p;
  if (t >= KEYS[NK - 1].t) return KEYS[NK - 1].p;
  int i = 0;
  while (t > KEYS[i + 1].t) i++;
  float t0 = KEYS[i].t, t1 = KEYS[i + 1].t, dt = t1 - t0, s = (t - t0) / dt;
  auto tangent = [&](int k) -> V3 {
    if (k == NK - 1) return v3(0, 0, 0);                       // come to rest at the end
    int a = max(0, k - 1), b = min(NK - 1, k + 1);
    return (KEYS[b].p - KEYS[a].p) * (dt / (KEYS[b].t - KEYS[a].t));
  };
  V3 m0 = tangent(i), m1 = tangent(i + 1);
  float s2 = s * s, s3 = s2 * s;
  return KEYS[i].p * (2 * s3 - 3 * s2 + 1) + m0 * (s3 - 2 * s2 + s) + KEYS[i + 1].p * (-2 * s3 + 3 * s2) + m1 * (s3 - s2);
}

// ---------- render queue ----------
struct Face { float depth; uint8_t box, face; };
const int MAX_FACES = 260;
V3 boxCam[MAX_BOXES][8];   // camera-space corners, index bits: x1 | y1<<1 | z1<<2
const uint8_t FACE_CORNERS[5][4] = {{0, 1, 3, 2}, {1, 5, 7, 3}, {5, 4, 6, 7}, {4, 0, 2, 6}, {2, 3, 7, 6}};
Face faces[MAX_FACES];
int nFaces;
uint32_t usCollect, usFaces, usFill, usWin, usSpin, usSend, usBB;

void drawBoxFace(const Face &F, float t) {
  const Box &b = boxes[F.box];
  V3 cc[4];
  for (int i = 0; i < 4; i++) cc[i] = boxCam[F.box][FACE_CORNERS[F.face][i]];
  float xs[MAXV], ys[MAXV];
  int m = clipProject(cc, 4, xs, ys);
  if (m < 3) return;
  // Entirely off-screen? Nothing to draw.
  float bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
  for (int i = 0; i < m; i++) { bx0 = min(bx0, xs[i]); bx1 = max(bx1, xs[i]); by0 = min(by0, ys[i]); by1 = max(by1, ys[i]); }
  if (bx1 < 0 || bx0 >= W || by1 < 0 || by0 >= H) return;
  uint32_t a0 = micros();
  fillPoly(xs, ys, m, -1);
  usFill += micros() - a0;

  float fog = constrain(1.3f - F.depth / 110.0f, 0.0f, 1.0f);   // 1 near, 0 far
  if (b.kind == HQ) fog = max(fog, 0.6f);
  if (fog > 0.05f) outlinePoly(xs, ys, m, fog > 0.7f ? 1 : fog);

  // Windows on the walls. With all four corners in front of the camera,
  // place them by blending the projected corners (cheap, and accurate enough
  // at this size) instead of projecting every window in 3D.
  uint32_t a1 = micros();
  bool allFront = cc[0].z >= NEAR_Z && cc[1].z >= NEAR_Z && cc[2].z >= NEAR_Z && cc[3].z >= NEAR_Z;
  if (F.face != 4 && fog > 0 && allFront) {
    float X[4], Y[4];
    for (int i = 0; i < 4; i++) project(cc[i], X[i], Y[i]);
    float wdth = (F.face == 1 || F.face == 3) ? b.z1 - b.z0 : b.x1 - b.x0;
    int cols = max(1, (int)(wdth / 3.5f)), rows = max(1, (int)(b.y1 / 4.0f));
    // Don't bother when the windows would be packed tighter than the pixels
    float spanX = max(fabsf(X[1] - X[0]), fabsf(X[2] - X[3])), spanY = max(fabsf(Y[3] - Y[0]), fabsf(Y[2] - Y[1]));
    int stepI = max(1, (int)ceilf(cols / max(1.0f, spanX / 2))), stepJ = max(1, (int)ceilf(rows / max(1.0f, spanY / 2)));
    for (int j = 1; j < rows; j += stepJ) {
      float v = (float)j / rows;
      float lx = X[0] + (X[3] - X[0]) * v, ly = Y[0] + (Y[3] - Y[0]) * v;   // left edge
      float rx = X[1] + (X[2] - X[1]) * v, ry = Y[1] + (Y[2] - Y[1]) * v;   // right edge
      if ((ly < -1 && ry < -1) || (ly > H && ry > H)) continue;
      for (int i = 1; i < cols; i += stepI) {
        if (b.kind == HQ && j % 3 != 1) continue;                   // HQ: horizontal bands
        if (!windowLit(b.id + F.face * 7, i, j, t)) continue;
        float u = (float)i / cols;
        int sx = (int)(lx + (rx - lx) * u), sy = (int)(ly + (ry - ly) * u);
        if (fog >= 1 || dither(sx, sy, fog)) px(sx, sy, true);
      }
    }
  }

  usWin += micros() - a1;
  if (b.kind == BILLBOARD && F.face == 1) {
    uint32_t a2 = micros();
    V3 q[4] = {toCam({BB_X + 0.05f, BB_Y1, BB_Z0}), toCam({BB_X + 0.05f, BB_Y1, BB_Z1}),
               toCam({BB_X + 0.05f, BB_Y0, BB_Z1}), toCam({BB_X + 0.05f, BB_Y0, BB_Z0})};
    drawBillboard(q, t);
    usBB += micros() - a2;
  }
}

void drawCity(float t) {
  nFaces = 0;
  for (int bi = 0; bi < nBoxes; bi++) {
    const Box &b = boxes[bi];
    V3 centre = {(b.x0 + b.x1) / 2, b.y1 / 2, (b.z0 + b.z1) / 2};
    V3 cc = toCam(centre);
    float radius = max(max(b.x1 - b.x0, b.z1 - b.z0), b.y1) * 0.8f;
    if (cc.z + radius < NEAR_Z || cc.z - radius > FAR_Z) continue;
    if (fabsf(cc.x) - radius > cc.z * 1.3f + 2) continue;          // outside the side of the view
    if (fabsf(cc.y) - radius > cc.z * 0.8f + 2) continue;          // above/below the view
    for (int k = 0; k < 8; k++) boxCam[bi][k] = toCam({(k & 1) ? b.x1 : b.x0, (k & 2) ? b.y1 : 0, (k & 4) ? b.z1 : b.z0});
    // Visible faces: the camera is on the outside of that face's plane
    const V3 &e = cam.eye;
    bool vis[5] = {e.z < b.z0, e.x > b.x1, e.z > b.z1, e.x < b.x0, e.y > b.y1};
    for (int f = 0; f < 5 && nFaces < MAX_FACES; f++) {
      if (!vis[f]) continue;
      float depth = 0;
      for (int i = 0; i < 4; i++) depth += boxCam[bi][FACE_CORNERS[f][i]].z;
      faces[nFaces++] = {depth / 4, (uint8_t)bi, (uint8_t)f};
    }
  }
  usCollect += 0;
  // Painter's algorithm: far to near (insertion sort; nearly sorted frame to frame)
  for (int i = 1; i < nFaces; i++) {
    Face k = faces[i]; int j = i - 1;
    while (j >= 0 && faces[j].depth < k.depth) { faces[j + 1] = faces[j]; j--; }
    faces[j + 1] = k;
  }
  uint32_t a = micros();
  for (int i = 0; i < nFaces; i++) drawBoxFace(faces[i], t);
  usFaces += micros() - a;
}

void drawPadLights(float t) {
  // Lights round the pad edge, chasing; a mast with a beacon
  int chase = (int)(t * 8) % 4, k = 0;
  auto light = [&](float x, float z) {
    V3 c = toCam({x, PAD_Y + 0.1f, z});
    if (c.z >= NEAR_Z && (k++ % 4) == chase) { float sx, sy; project(c, sx, sy); px((int)sx, (int)sy, true); }
  };
  for (float x = PAD_X0; x <= PAD_X1; x += 2) { light(x, PAD_Z0); }
  for (float z = PAD_Z0; z <= PAD_Z1; z += 2) { light(PAD_X1, z); }
  for (float x = PAD_X1; x >= PAD_X0; x -= 2) { light(x, PAD_Z1); }
  for (float z = PAD_Z1; z >= PAD_Z0; z -= 2) { light(PAD_X0, z); }
  V3 a = toCam({9, PAD_Y, 349}), b = toCam({9, PAD_Y + 12, 349});
  if (a.z > NEAR_Z && b.z > NEAR_Z) {
    float ax, ay, bx, by; project(a, ax, ay); project(b, bx, by);
    line(ax, ay, bx, by, 0.5f);
    if (((int)(t * 1.5f)) & 1) { px((int)bx, (int)by - 1, true); px((int)bx - 1, (int)by - 1, true); px((int)bx + 1, (int)by - 1, true); }
  }
}

void drawSpinner(float t, bool landed) {
  V3 wv[13], cv[13];
  for (int i = 0; i < 13; i++) { wv[i] = spinnerWorld(SV[i]); cv[i] = toCam(wv[i]); }
  V3 centre = spinnerWorld({0, 0.4f, -0.2f});
  V3 light = norm(v3(-0.5f, 1, -0.4f));

  struct SD { float depth; uint8_t i; } order[NSF];
  int n = 0;
  for (int f = 0; f < NSF; f++) {
    const SFace &F = SF[f];
    V3 nrm = norm(cross(wv[F.v[1]] - wv[F.v[0]], wv[F.v[2]] - wv[F.v[0]]));
    V3 fc = {0, 0, 0};
    for (int k = 0; k < F.n; k++) fc = fc + wv[F.v[k]];
    fc = fc * (1.0f / F.n);
    if (dot(nrm, fc - centre) < 0) nrm = nrm * -1;                 // make it point outward
    if (dot(nrm, cam.eye - fc) <= 0) continue;                      // back face
    float d = 0;
    for (int k = 0; k < F.n; k++) d += cv[F.v[k]].z;
    order[n++] = {d / F.n, (uint8_t)f};
    (void)light;
  }
  for (int i = 1; i < n; i++) { SD k = order[i]; int j = i - 1; while (j >= 0 && order[j].depth < k.depth) { order[j + 1] = order[j]; j--; } order[j + 1] = k; }

  for (int i = 0; i < n; i++) {
    const SFace &F = SF[order[i].i];
    V3 poly[4];
    for (int k = 0; k < F.n; k++) poly[k] = cv[F.v[k]];
    float xs[MAXV], ys[MAXV];
    int m = clipProject(poly, F.n, xs, ys);
    if (m < 3) continue;
    float shade;
    if (F.glass) shade = -1;
    else {
      V3 nrm = norm(cross(wv[F.v[1]] - wv[F.v[0]], wv[F.v[2]] - wv[F.v[0]]));
      V3 fc = wv[F.v[0]];
      if (dot(nrm, fc - centre) < 0) nrm = nrm * -1;
      shade = 0.12f + 0.6f * max(0.0f, dot(nrm, light));
    }
    fillPoly(xs, ys, m, shade);
    outlinePoly(xs, ys, m, 1);
  }

  // Light bar: alternating flashes either side of the roof
  bool blink = ((int)(t * 6)) & 1;
  for (int s = -1; s <= 1; s += 2) {
    V3 c = toCam(spinnerWorld({0.35f * s, 1.3f, -0.45f}));
    if (c.z < NEAR_Z) continue;
    float sx, sy; project(c, sx, sy);
    if ((s < 0) == blink) { px((int)sx, (int)sy, true); px((int)sx + 1, (int)sy, true); px((int)sx, (int)sy - 1, true); }
  }
  if (!landed) {
    // Headlight beams: dotted rays ahead of the nose
    for (int s = -1; s <= 1; s += 2) {
      V3 a = toCam(spinnerWorld({0.4f * s, 0.25f, 2.2f})), b = toCam(spinnerWorld({1.6f * s, -1.2f, 12.0f}));
      if (a.z < NEAR_Z || b.z < NEAR_Z) continue;
      float ax, ay, bx, by; project(a, ax, ay); project(b, bx, by);
      line(ax, ay, bx, by, 0.3f);
    }
    // Thrusters under the belly
    for (int k = 0; k < 3; k++) {
      V3 c = toCam(spinnerWorld({(k - 1) * 0.6f, -0.35f, -0.4f - k * 0.3f}));
      if (c.z < NEAR_Z || random(3) == 0) continue;
      float sx, sy; project(c, sx, sy);
      px((int)sx, (int)sy, true);
    }
  }
}

// ---------- exhaust puffs at touchdown ----------
struct Puff { V3 p, v; float life; };
Puff puffs[20];
void spawnPuffs() {
  for (Puff &p : puffs) {
    float a = frand(0, 6.283f), s = frand(4, 9);
    p = {{sp.pos.x + cosf(a) * 1.5f, PAD_Y + 0.3f, sp.pos.z + sinf(a) * 1.5f}, {cosf(a) * s, frand(0.5f, 1.5f), sinf(a) * s}, frand(0.6f, 1.4f)};
  }
}
void drawPuffs(float dt) {
  for (Puff &p : puffs) {
    if (p.life <= 0) continue;
    p.life -= dt; p.p = p.p + p.v * dt; p.v = p.v * (1 - dt * 2);
    V3 c = toCam(p.p);
    if (c.z < NEAR_Z || random(3) == 0) continue;
    float sx, sy; project(c, sx, sy);
    px((int)sx, (int)sy, true);
  }
}

// ---------- rain (screen space) ----------
struct Drop { float x, y, v; };
Drop drops[16];
void resetDrop(Drop &d, bool anywhere) { d.x = random(0, W + 14); d.y = anywhere ? random(-H, H) : random(-10, -2); d.v = 60 + random(35); }
void drawRain(float dt) {
  for (Drop &d : drops) {
    d.y += d.v * dt; d.x -= d.v * dt * 0.3f;
    if (d.y > H + 3) resetDrop(d, false);
    line(d.x, d.y, d.x + 1, d.y - 3);
  }
}

void fadeOut(float f) {
  if (f <= 0) return;
  u8g2.setDrawColor(0);
  for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (BAYER[y & 3][x & 3] < f * 16) u8g2.drawPixel(x, y);
  u8g2.setDrawColor(1);
}

// ---------- main ----------
uint32_t loopStart;
float prevYaw = 0;

void setup() {
  Serial.begin(115200);
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.setBusClock(800000);
  u8g2.begin();
  u8g2.setContrast(255);
  randomSeed(esp_random());
  buildCity();
  bakeGeisha();
  for (Drop &d : drops) resetDrop(d, true);
  loopStart = millis();
}

void loop() {
  static uint32_t last = millis(), fpsAt = 0;
  static int frames = 0;
  static bool puffed = false;
  uint32_t now = millis();
  float dt = (now - last) / 1000.0f;
  last = now;
  float t = (now - loopStart) / 1000.0f;
  if (t >= T_END) { loopStart = now; t = 0; puffed = false; for (Puff &p : puffs) p.life = 0; }

  // Spinner pose from the path: heading follows the direction of travel
  sp.pos = pathAt(t);
  V3 ahead = pathAt(t + 0.15f) - sp.pos;
  float horiz = sqrtf(ahead.x * ahead.x + ahead.z * ahead.z);
  float yaw = horiz > 0.05f ? atan2f(ahead.x, ahead.z) : prevYaw;
  float yawRate = (yaw - prevYaw) / max(dt, 0.001f);
  prevYaw = yaw;
  sp.yaw = yaw;
  sp.pitch = constrain(atan2f(ahead.y, max(horiz, 0.01f)) * 0.5f, -0.3f, 0.3f);
  sp.roll = constrain(-yawRate * 0.5f, -0.5f, 0.5f) + sinf(t * 1.7f) * 0.04f;
  bool landed = t >= T_TOUCHDOWN;
  if (!landed) sp.pos.y += sinf(t * 2.3f) * 0.25f * (1 - span(t, 16, T_TOUCHDOWN));
  if (landed && !puffed) { puffed = true; spawnPuffs(); }

  // Chase camera: behind, above and to the right; glances at the billboard
  V3 fwd = {sinf(yaw), 0, cosf(yaw)}, right = {cosf(yaw), 0, -sinf(yaw)};
  V3 chaseEye = sp.pos - fwd * 9 + right * 3.5f + v3(0, 3, 0);
  V3 chaseTgt = sp.pos + fwd * 4 + v3(0, 0.6f, 0);
  float glance = ease(span(t, 2.2f, 3.4f)) * (1 - ease(span(t, 5.2f, 6.4f)));
  chaseTgt = chaseTgt - right * (9 * glance) + v3(0, 3 * glance, 0);
  // Landing camera: close three-quarter view of the pad
  V3 landEye = {13, PAD_Y + 7, PAD_Z0 - 4}, landTgt = {0, PAD_Y + 0.5f, 340};
  float k = ease(span(t, 13.0f, 16.5f));
  lookAt(lerp3(chaseEye, landEye, k), lerp3(chaseTgt, landTgt, k));

  u8g2.clearBuffer();
  uint32_t c0 = micros();
  drawCity(t);
  usCollect += micros() - c0;
  drawPadLights(t);
  uint32_t c1 = micros();
  drawSpinner(t, landed);
  usSpin += micros() - c1;
  drawPuffs(dt);
  drawRain(dt);
  float f = 0;
  if (t < 0.7f) f = 1 - span(t, 0, 0.7f);
  else if (t >= T_FADE) f = span(t, T_FADE, T_END - 0.3f);
  fadeOut(f);
  uint32_t c2 = micros();
  u8g2.sendBuffer();
  usSend += micros() - c2;

  frames++;
  if (now - fpsAt >= 1000) {
    Serial.printf("fps %d faces %d | city %lu (draw %lu: fill %lu win %lu bb %lu) spin %lu send %lu ms\n", frames, nFaces,
      usCollect / 1000, usFaces / 1000, usFill / 1000, usWin / 1000, usBB / 1000, usSpin / 1000, usSend / 1000);
    usCollect = usFaces = usFill = usWin = usSpin = usSend = usBB = 0;
    frames = 0; fpsAt = now;
  }
}
