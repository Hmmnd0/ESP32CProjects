// Origami unicorn for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
//
// A ~20 s loop: a sheet of paper fades in and creases, folds in half twice,
// then its facets open out one by one into a low-poly unicorn. The horn
// glints, rain falls with ripples on the floor, a light sweeps across the
// paper, and the unicorn dissolves away before the loop starts again.
// Facets are shaded with dither patterns (lit from the upper left), so it
// reads as folded paper without any grey flicker.
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40, FLOOR_Y = 37;

// ---------- timeline (seconds) ----------
const float T_SHEET_IN = 0.0, T_CREASES = 1.2, T_FOLD1 = 3.0, T_FOLD2 = 4.0, T_FACETS = 5.0;
const float FACET_STEP = 0.25, FACET_DUR = 1.3;
const float T_GLINT = 11.4, T_RAIN = 9.0, T_SWEEP = 13.0, T_DISSOLVE = 17.0, T_END = 20.5;

// ---------- the unicorn (side view, facing right) ----------
// Traced from the classic origami unicorn: long segmented horn, narrow head
// angled down, steep neck with a mane fold, layered folds along the back,
// a spike tail pointing left and long single-point legs.
struct Pt { float x, y; };
const Pt P[] = {
  {53.8, 0.0},  // 0 horn tip
  {48.8, 4.5},  // 1 horn base (back)
  {50.2, 5.4},  // 2 horn base (front)
  {47.8, 5.1},  // 3 back of head
  {51.2, 6.0},  // 4 forehead
  {53.4, 11.9}, // 5 snout
  {49.1, 10.6}, // 6 jaw
  {42.7, 15.3}, // 7 base of neck (back)
  {44.9, 23.4}, // 8 chest
  {39.8, 11.1}, // 9 mane tip
  {43.6, 11.1}, // 10 mane fold
  {39.3, 15.0}, // 11 front of back
  {30.8, 16.2}, // 12 back fold A
  {34.2, 15.6}, // 13 back fold B
  {37.6, 15.0}, // 14 back fold C
  {27.9, 16.4}, // 15 rump
  {18.5, 25.1}, // 16 tail tip
  {27.2, 21.9}, // 17 under the tail
  {31.3, 23.0}, // 18 top of back leg
  {24.9, 35.7}, // 19 back hoof
  {40.2, 23.8}, // 20 belly front
  {49.1, 37.0}, // 21 front hoof
  {33.4, 20.8}, // 22 inner fold
  {39.3, 19.1}, // 23 inner fold
};
const float SHIFT_X = 0;   // already centred-ish; nudge here if needed

// Facets in the order they unfold. shade = dither density 1..4 (4 = solid)
struct Facet { uint8_t a, b, c, shade; };
const Facet FACETS[] = {
  {11, 7, 8, 4},   // shoulder
  {11, 8, 20, 4},  // chest block
  {11, 20, 23, 4}, // front of body
  {14, 11, 23, 4}, // back fold C
  {13, 14, 23, 4}, // back fold B
  {13, 23, 22, 4},
  {12, 13, 22, 4}, // back fold A
  {22, 23, 20, 4}, // belly
  {22, 20, 18, 4},
  {15, 12, 22, 4}, // rump
  {15, 22, 17, 4},
  {17, 22, 18, 4},
  {15, 17, 16, 4}, // tail
  {17, 18, 19, 4}, // back leg
  {20, 8, 21, 4},  // front leg
  {6, 8, 7, 4},    // neck (front)
  {3, 6, 7, 4},    // neck (back)
  {9, 10, 7, 4},   // mane fold
  {3, 5, 6, 4},    // cheek
  {3, 4, 5, 4},    // face
};
const int NF = sizeof(FACETS) / sizeof(FACETS[0]);

// Dark fold lines drawn over the solid paper, like the gaps between facets
// in the printed unicorn. Pairs of point indices.
const uint8_t CREASES[][2] = {
  {3, 6},    // head / neck gap
  {11, 8},   // shoulder
  {12, 22},  // back fold A
  {14, 23},  // back fold C
  {15, 17},  // tail joint
  {17, 18},  // top of back leg
  {20, 8},   // top of front leg
};
const int NC = sizeof(CREASES) / sizeof(CREASES[0]);

// Where the sheet ends up after folding twice (the facets grow out of this square)
const float SQ_X0 = 21, SQ_Y0 = 5, SQ_SIZE = 30;     // the full sheet
const float SMALL = SQ_SIZE / 2;                      // after two folds: top-left quarter

const uint8_t BAYER[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};

float ease(float t) { t = constrain(t, 0.0f, 1.0f); return t * t * (3 - 2 * t); }
float lerp(float a, float b, float t) { return a + (b - a) * t; }
float span(float t, float a, float b) { return constrain((t - a) / (b - a), 0.0f, 1.0f); }

// Global dissolve: 0 = fully visible, 1 = gone. Applied to every paper pixel.
float dissolve = 0;
// Light sweep: pixels with x - y near this value are lit up
float sweepPos = -999;

bool visible(int x, int y) { return BAYER[y & 3][x & 3] >= dissolve * 16; }

void paperPixel(int x, int y, bool on) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  if (!visible(x, y)) return;
  if (fabsf((x - y) - sweepPos) < 2.5f) on = true;   // the sweep brightens everything it crosses
  u8g2.setDrawColor(on ? 1 : 0);
  u8g2.drawPixel(x, y);
  u8g2.setDrawColor(1);
}

void paperLine(float x0, float y0, float x1, float y1) {
  int steps = max(1, (int)ceilf(max(fabsf(x1 - x0), fabsf(y1 - y0))));
  for (int i = 0; i <= steps; i++) {
    float t = (float)i / steps;
    paperPixel((int)roundf(lerp(x0, x1, t)), (int)roundf(lerp(y0, y1, t)), true);
  }
}

// Filled, dithered triangle with lit edges. Inside pixels are written black or
// white, so the paper hides the rain behind it.
void paperTri(Pt a, Pt b, Pt c, int shade) {
  float area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (fabsf(area) < 0.5f) { paperLine(a.x, a.y, b.x, b.y); paperLine(b.x, b.y, c.x, c.y); return; }
  int x0 = max(0, (int)floorf(min(a.x, min(b.x, c.x)))), x1 = min(W - 1, (int)ceilf(max(a.x, max(b.x, c.x))));
  int y0 = max(0, (int)floorf(min(a.y, min(b.y, c.y)))), y1 = min(H - 1, (int)ceilf(max(a.y, max(b.y, c.y))));
  float s = area > 0 ? 1 : -1;
  for (int y = y0; y <= y1; y++)
    for (int x = x0; x <= x1; x++) {
      float px = x + 0.5f, py = y + 0.5f;
      float w0 = ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)) * s;
      float w1 = ((c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)) * s;
      float w2 = ((a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x)) * s;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) paperPixel(x, y, BAYER[y & 3][x & 3] < shade * 4);
    }
  paperLine(a.x, a.y, b.x, b.y);
  paperLine(b.x, b.y, c.x, c.y);
  paperLine(c.x, c.y, a.x, a.y);
}

void paperRect(float x0, float y0, float x1, float y1, int shade) {
  if (x1 < x0) { float t = x0; x0 = x1; x1 = t; }
  if (y1 < y0) { float t = y0; y0 = y1; y1 = t; }
  paperTri({x0, y0}, {x1, y0}, {x1, y1}, shade);
  paperTri({x0, y0}, {x1, y1}, {x0, y1}, shade);
}

// A unicorn point's final screen position, and where it starts inside the folded square
Pt finalPos(int i) { return {P[i].x + SHIFT_X, P[i].y}; }
float bbX0 = 999, bbX1 = -999, bbY0 = 999, bbY1 = -999;
void computeBounds() {
  for (const Pt &p : P) { bbX0 = min(bbX0, p.x); bbX1 = max(bbX1, p.x); bbY0 = min(bbY0, p.y); bbY1 = max(bbY1, p.y); }
}
Pt foldedPos(int i) {
  // The unicorn's bounding box squeezed into the small folded square
  return {SQ_X0 + 1 + (P[i].x - bbX0) / (bbX1 - bbX0) * (SMALL - 2),
          SQ_Y0 + 1 + (P[i].y - bbY0) / (bbY1 - bbY0) * (SMALL - 2)};
}

// ---------- scenes ----------
void drawSheet(float t) {
  float cx = SQ_X0 + SQ_SIZE / 2, cy = SQ_Y0 + SQ_SIZE / 2, x1 = SQ_X0 + SQ_SIZE, y1 = SQ_Y0 + SQ_SIZE;

  if (t < T_FOLD1) {
    dissolve = 1 - ease(span(t, T_SHEET_IN, T_CREASES));      // fade in
    paperRect(SQ_X0, SQ_Y0, x1, y1, 1);
    dissolve = 0;
    // Creases draw themselves: centre lines, then diagonals (dotted)
    float c1 = ease(span(t, T_CREASES, T_CREASES + 0.7f)), c2 = ease(span(t, T_CREASES + 0.7f, T_FOLD1 - 0.2f));
    for (float k = 0; k < c1 * SQ_SIZE; k += 2) {
      paperPixel(cx, SQ_Y0 + k, true);
      paperPixel(SQ_X0 + k, cy, true);
    }
    for (float k = 0; k < c2 * SQ_SIZE; k += 3) {
      paperPixel(SQ_X0 + k, SQ_Y0 + k, true);
      paperPixel(x1 - k, SQ_Y0 + k, true);
    }
    return;
  }

  if (t < T_FOLD2) {
    // Fold 1: right half swings over the left along the vertical crease
    float a = ease(span(t, T_FOLD1, T_FOLD2)) * PI;
    float edge = cx + cosf(a) * SQ_SIZE / 2;
    paperRect(SQ_X0, SQ_Y0, cx, y1, 1);
    paperRect(cx, SQ_Y0, edge, y1, a < PI / 2 ? 1 : 2);       // back of the paper is darker
    return;
  }

  // Fold 2: bottom half swings up along the horizontal crease
  float a = ease(span(t, T_FOLD2, T_FACETS)) * PI;
  float edge = cy + cosf(a) * SQ_SIZE / 2;
  paperRect(SQ_X0, SQ_Y0, cx, cy, 2);
  paperRect(SQ_X0, cy, cx, edge, a < PI / 2 ? 2 : 1);
}

void drawUnicorn(float t) {
  // The folded square fades out as the facets open
  float sq = span(t, T_FACETS, T_FACETS + 1.5f);
  if (sq < 1) {
    float saved = dissolve;
    dissolve = max(saved, ease(sq));
    paperRect(SQ_X0, SQ_Y0, SQ_X0 + SMALL, SQ_Y0 + SMALL, 2);
    dissolve = saved;
  }

  for (int f = 0; f < NF; f++) {
    float start = T_FACETS + f * FACET_STEP;
    if (t < start) continue;
    float k = ease(span(t, start, start + FACET_DUR));
    const Facet &F = FACETS[f];
    Pt v[3];
    const uint8_t idx[3] = {F.a, F.b, F.c};
    for (int i = 0; i < 3; i++) {
      Pt from = foldedPos(idx[i]), to = finalPos(idx[i]);
      v[i] = {lerp(from.x, to.x, k), lerp(from.y, to.y, k)};
    }
    // While a facet is unfolding it's seen from the back (darker) until halfway
    paperTri(v[0], v[1], v[2], k < 0.5f ? max(1, F.shade - 1) : F.shade);
  }

  // Creases appear once the body has settled
  float c = span(t, T_FACETS + NF * FACET_STEP, T_FACETS + NF * FACET_STEP + 0.6f);
  if (c > 0) {
    for (int i = 0; i < NC; i++) {
      Pt a = finalPos(CREASES[i][0]), b = finalPos(CREASES[i][1]);
      // shorten each crease a little so it doesn't notch the outline
      Pt a2 = {lerp(a.x, b.x, 0.15f), lerp(a.y, b.y, 0.15f)}, b2 = {lerp(a.x, b.x, 0.85f), lerp(a.y, b.y, 0.85f)};
      int steps = max(1, (int)ceilf(max(fabsf(b2.x - a2.x), fabsf(b2.y - a2.y))));
      for (int k = 0; k <= steps * c; k++) {
        float u = (float)k / steps;
        paperPixel((int)roundf(lerp(a2.x, b2.x, u)), (int)roundf(lerp(a2.y, b2.y, u)), false);
      }
    }
  }

  // The horn grows last: a 2px-wide spike with gaps, like the segmented horn
  float h = ease(span(t, T_FACETS + NF * FACET_STEP + 0.2f, T_FACETS + NF * FACET_STEP + 1.2f));
  if (h > 0) {
    Pt base = {(finalPos(1).x + finalPos(2).x) / 2, (finalPos(1).y + finalPos(2).y) / 2};
    Pt tip = finalPos(0);
    Pt end = {lerp(base.x, tip.x, h), lerp(base.y, tip.y, h)};
    float len = sqrtf((end.x - base.x) * (end.x - base.x) + (end.y - base.y) * (end.y - base.y));
    for (float d = 0; d <= len; d += 0.5f) {
      float u = len > 0 ? d / len : 0;
      int x = (int)roundf(lerp(base.x, end.x, u)), y = (int)roundf(lerp(base.y, end.y, u));
      bool gap = ((int)d % 3) == 2 && d > 1;          // segment breaks
      paperPixel(x, y, !gap);
      if (d < len * 0.6f) paperPixel(x - 1, y, !gap);  // thicker near the base
    }
  }
}

void drawGlint(float t) {
  float g = span(t, T_GLINT, T_GLINT + 0.8f);
  if (g <= 0 || g >= 1) return;
  float r = sinf(g * PI) * 4;
  Pt tip = finalPos(5);
  int x = (int)tip.x, y = (int)tip.y + 1;
  u8g2.setDrawColor(1);
  u8g2.drawHLine(x - (int)r, y, 2 * (int)r + 1);
  u8g2.drawVLine(x, max(0, y - (int)r), 2 * (int)r + 1);
  if (r > 2) { u8g2.drawPixel(x - 1, y - 1); u8g2.drawPixel(x + 1, y - 1); u8g2.drawPixel(x - 1, y + 1); u8g2.drawPixel(x + 1, y + 1); }
}

// ---------- rain ----------
struct Drop { float x, y, v; };
struct Ripple { float x; float age; bool live; };
const int NDROPS = 14, NRIPPLES = 8;
Drop drops[NDROPS];
Ripple ripples[NRIPPLES];

void resetDrop(Drop &d, bool anywhere) {
  d.x = random(4, W + 12);
  d.y = anywhere ? random(-H, H) : random(-12, -2);
  d.v = 45 + random(30);   // px per second
}

void rain(float t, float dt) {
  if (t < T_RAIN) return;
  float density = span(t, T_RAIN, T_RAIN + 2);          // rain builds up
  int active = (int)(NDROPS * density);
  for (int i = 0; i < active; i++) {
    Drop &d = drops[i];
    d.y += d.v * dt;
    d.x -= d.v * dt * 0.3f;                              // slight slant
    if (d.y >= FLOOR_Y) {
      for (Ripple &r : ripples) if (!r.live) { r = {d.x, 0, true}; break; }
      resetDrop(d, false);
      continue;
    }
    u8g2.drawLine((int)d.x, (int)d.y, (int)(d.x + 1), (int)(d.y - 3));
  }
  for (Ripple &r : ripples) {
    if (!r.live) continue;
    r.age += dt;
    int w = 1 + (int)(r.age * 14);
    if (w > 6) { r.live = false; continue; }
    u8g2.drawPixel((int)r.x - w, FLOOR_Y + 1);
    u8g2.drawPixel((int)r.x + w, FLOOR_Y + 1);
    if (w < 3) u8g2.drawPixel((int)r.x, FLOOR_Y + 1);
  }
}

void drawFloor(float t) {
  // A faint dotted floor line that appears with the unicorn
  float f = span(t, T_FACETS + 2, T_FACETS + 4);
  if (f <= 0) return;
  for (int x = 4; x < W - 4; x += 3)
    if (BAYER[FLOOR_Y & 3][x & 3] < f * 16) u8g2.drawPixel(x, FLOOR_Y);
}

// ---------- main ----------
uint32_t loopStart;

void setup() {
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.setBusClock(800000);
  u8g2.begin();
  u8g2.setContrast(255);
  randomSeed(esp_random());
  computeBounds();
  for (Drop &d : drops) resetDrop(d, true);
  loopStart = millis();
}

void loop() {
  static uint32_t last = millis();
  uint32_t now = millis();
  float dt = (now - last) / 1000.0f;
  last = now;
  float t = (now - loopStart) / 1000.0f;
  if (t >= T_END) {
    loopStart = now; t = 0;
    for (Drop &d : drops) resetDrop(d, true);
    for (Ripple &r : ripples) r.live = false;
  }

  u8g2.clearBuffer();
  rain(t, dt);
  drawFloor(t);

  dissolve = ease(span(t, T_DISSOLVE, T_DISSOLVE + 2));
  float s = span(t, T_SWEEP, T_SWEEP + 1.2f);
  sweepPos = (s > 0 && s < 1) ? lerp(-45, 75, s) : -999;

  if (t < T_FACETS) drawSheet(t);
  else if (dissolve < 1) drawUnicorn(t);
  drawGlint(t);
  u8g2.sendBuffer();

  // ~40 fps
  int32_t spare = 25 - (int32_t)(millis() - now);
  if (spare > 0) delay(spare);
}
