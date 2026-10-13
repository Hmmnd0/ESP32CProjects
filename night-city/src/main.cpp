// Night city flyover for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
//
// A Blade Runner style city scrolling past: three parallax skyline layers,
// a hazy far layer with the stepped pyramid and refinery flames, fog,
// sweeping searchlights, flickering windows, blinking antenna lights, rain,
// and a police spinner that flies through between the towers (hidden when
// a near tower passes in front of it).
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40;
const uint8_t BAYER[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};

float frand(float a, float b) { return a + (b - a) * (esp_random() / 4294967295.0f); }
bool dither(int x, int y, float level) { return BAYER[y & 3][x & 3] < level * 16; }   // level 0..1

void px(int x, int y, bool on) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  u8g2.setDrawColor(on ? 1 : 0);
  u8g2.drawPixel(x, y);
  u8g2.setDrawColor(1);
}

// ---------- the spinner (side view, facing left) ----------
// '#' lit, 'o' solid dark (hides what's behind), ' ' transparent
const char *SPINNER[] = {
  "                 ##             ",
  "             #########          ",
  "          ###o#ooooooo#o#       ",
  "       ###oooo#ooooooo#ooo#     ",
  "  #######################ooo### ",
  "###oooooooooooooooooooooooooooo##",
  " ##o#o#o#oooooooooooooooo####o## ",
  "   ###########################   ",
  "     ##oo##          ##oo##      ",
  "      ####            ####       ",
};
const int SP_H = sizeof(SPINNER) / sizeof(SPINNER[0]);
const int SP_W = 33;

struct Spinner {
  bool active;
  float x, y, vx;       // vx < 0 flies left (nose first), > 0 flies right (mirrored)
  float phase;
  float nextAt;         // seconds until the next pass
} spinner = {false, 0, 0, 0, 0, 3};

void drawSpinner(float t) {
  bool flip = spinner.vx > 0;               // sprite faces left; mirror when flying right
  int x0 = (int)roundf(spinner.x), y0 = (int)roundf(spinner.y + sinf(t * 2.1f + spinner.phase) * 1.2f);

  // Headlight cone ahead of the nose
  int dir = flip ? 1 : -1;
  int noseX = flip ? x0 + SP_W : x0, noseY = y0 + 5;
  for (int d = 2; d < 26; d++) {
    int spread = d / 4;
    for (int k = -spread; k <= spread; k++) {
      int bx = noseX + dir * d, by = noseY + k + d / 6;
      if (dither(bx, by, 0.28f - d * 0.009f)) px(bx, by, true);
    }
  }

  for (int r = 0; r < SP_H; r++)
    for (int c = 0; c < SP_W; c++) {
      char ch = SPINNER[r][c];
      if (ch == ' ' || ch == 0) continue;
      int x = flip ? x0 + SP_W - 1 - c : x0 + c;
      px(x, y0 + r, ch == '#');
    }

  // Light bar: alternating left/right flashes on the roof
  bool blink = ((int)(t * 6)) & 1;
  int barX = flip ? x0 + SP_W - 1 - 17 : x0 + 17;
  px(barX - 1, y0 - 1, blink); px(barX + 2, y0 - 1, !blink);
  if (((int)(t * 12)) % 4 == 0) { px(barX - 2, y0 - 1, blink); px(barX + 3, y0 - 1, !blink); }

  // Underside thrusters flicker
  for (int i = 0; i < 3; i++) {
    int tx = flip ? x0 + SP_W - 1 - (8 + i * 6) : x0 + 8 + i * 6;
    if (random(3)) px(tx, y0 + SP_H, true);
  }
}

void updateSpinner(float t, float dt) {
  if (!spinner.active) {
    spinner.nextAt -= dt;
    if (spinner.nextAt > 0) return;
    bool left = random(3) > 0;               // usually flies nose-first against the scroll
    spinner.vx = left ? -frand(14, 22) : frand(8, 12);
    spinner.x = left ? W + 2 : -SP_W - 2;
    spinner.y = frand(4, 16);
    spinner.phase = frand(0, 6.28f);
    spinner.active = true;
  }
  spinner.x += spinner.vx * dt;
  if (spinner.x < -SP_W - 30 || spinner.x > W + 30) {
    spinner.active = false;
    spinner.nextAt = frand(4, 9);
  }
}

// ---------- skyline layers ----------
struct Building {
  float x;
  uint8_t w, h;
  uint8_t kind;         // far: 0 tower, 1 pyramid, 2 flame stack
  uint8_t seed;
  bool antenna;
};

struct Layer {
  float speed;          // px per second
  uint8_t minW, maxW, minH, maxH;
  uint8_t minGap, maxGap;   // space between buildings
  int count;
  Building b[10];
};

Layer far   = {3,  3, 7,  7, 20, 0, 2,  0, {}};
Layer mid   = {8,  5, 10, 10, 25, 1, 6,  0, {}};
Layer near_ = {20, 8, 14, 14, 30, 8, 24, 0, {}};

void newBuilding(Layer &L, Building &b, float x, bool isFar) {
  b.x = x;
  b.w = random(L.minW, L.maxW + 1);
  b.h = random(L.minH, L.maxH + 1);
  b.seed = random(256);
  b.antenna = random(3) == 0;
  b.kind = 0;
  if (isFar) {
    int r = random(14);
    if (r == 0) { b.kind = 1; b.w = 24; b.h = 16; }       // the pyramid
    else if (r < 3) { b.kind = 2; b.w = 3; b.h = random(5, 9); }  // flame stack
  }
}

void initLayer(Layer &L, bool isFar) {
  float x = -5;
  L.count = 0;
  while (x < W + 20 && L.count < 10) {
    Building &b = L.b[L.count++];
    newBuilding(L, b, x, isFar);
    x += b.w + random(L.minGap, L.maxGap + 1);
  }
}

void scrollLayer(Layer &L, float dt, bool isFar) {
  for (int i = 0; i < L.count; i++) L.b[i].x -= L.speed * dt;
  // Recycle buildings that left the screen to the right end
  for (int i = 0; i < L.count; i++) {
    Building &b = L.b[i];
    if (b.x + b.w < -2) {
      float right = -999;
      for (int j = 0; j < L.count; j++) right = max(right, L.b[j].x + L.b[j].w);
      newBuilding(L, b, right + random(L.minGap, L.maxGap + 1), isFar);
    }
  }
}

// cheap per-building hash for stable window patterns
bool windowLit(const Building &b, int wx, int wy, float t, int flickerRate) {
  uint32_t h = (b.seed * 2654435761u) ^ (wx * 97 + wy * 131);
  h ^= h >> 13; h *= 0x5bd1e995; h ^= h >> 15;
  bool lit = (h & 7) < 3;                              // ~3/8 of windows on
  if ((h & 255) < flickerRate && ((int)(t * 8 + (h >> 8)) % 7) == 0) lit = !lit;   // a few flicker
  return lit;
}

void drawFar(float t) {
  for (int i = 0; i < far.count; i++) {
    const Building &b = far.b[i];
    int x0 = (int)roundf(b.x), top = H - b.h;
    if (b.kind == 1) {
      // Stepped pyramid: dim dithered steps with a few lit edges
      for (int y = top; y < H; y++) {
        int row = y - top, half = row * b.w / (2 * b.h) + 1;
        if ((row % 3) == 0) half -= 1;                  // steps
        for (int x = x0 + b.w / 2 - half; x <= x0 + b.w / 2 + half; x++)
          px(x, y, (row % 3 == 0) ? dither(x, y, 0.5f) : dither(x, y, 0.18f));
      }
      continue;
    }
    if (b.kind == 2) {
      // Refinery stack with a flame that bursts now and then
      for (int y = top; y < H; y++) { px(x0 + 1, y, dither(x0 + 1, y, 0.5f)); }
      float burst = sinf(t * 0.9f + b.seed);
      if (burst > 0.55f) {
        int fh = (int)((burst - 0.55f) * 18) + random(2);
        for (int k = 0; k < fh; k++) {
          int fx = x0 + 1 + (random(3) - 1) * (k > 1), fy = top - 1 - k;
          px(fx, fy, true);
          if (k < fh / 2 && random(2)) px(fx + (random(2) ? 1 : -1), fy, true);
        }
      }
      continue;
    }
    for (int y = top; y < H; y++)
      for (int x = x0; x < x0 + b.w; x++) px(x, y, dither(x, y, 0.12f));
    if (b.antenna && ((int)(t * 1.5f + b.seed) & 1)) px(x0 + b.w / 2, top - 1, true);
  }
}

void drawFog() {
  // Haze thickening toward the ground, between the far and mid layers
  for (int y = 28; y < H; y++) {
    float lv = (y - 28) / 12.0f * 0.22f;
    for (int x = 0; x < W; x++) if (dither(x, y, lv)) px(x, y, true);
  }
}

void drawSearchlights(float t) {
  for (int i = 0; i < 2; i++) {
    float baseX = fmodf(20 + i * 40 - t * mid.speed * 0.5f + 400, 112) - 20;
    float ang = sinf(t * (0.35f + i * 0.17f) + i * 2) * 0.6f;       // radians from vertical
    float dx = sinf(ang), dy = -cosf(ang);
    for (int d = 0; d < 46; d += 1) {
      int x = (int)(baseX + dx * d), y = (int)(H - 1 + dy * d);
      if ((d + (int)(t * 20)) % 3 == 0) px(x, y, true);
    }
  }
}

void drawMid(float t) {
  for (int i = 0; i < mid.count; i++) {
    const Building &b = mid.b[i];
    int x0 = (int)roundf(b.x), top = H - b.h;
    for (int y = top; y < H; y++)
      for (int x = x0; x < x0 + b.w; x++) {
        int wx = x - x0, wy = y - top;
        bool win = (wx % 2 == 1) && (wy % 3 == 1) && wx < b.w - 1 && windowLit(b, wx, wy, t, 40);
        px(x, y, win);
      }
    if (b.antenna) {
      for (int y = top - 3; y < top; y++) px(x0 + 1, y, dither(x0 + 1, y, 0.5f));
      if (((int)(t * 2 + b.seed)) & 1) px(x0 + 1, top - 4, true);
    }
  }
}

void drawNear(float t) {
  for (int i = 0; i < near_.count; i++) {
    const Building &b = near_.b[i];
    int x0 = (int)roundf(b.x), top = H - b.h;
    for (int y = top; y < H; y++)
      for (int x = x0; x < x0 + b.w; x++) {
        int wx = x - x0, wy = y - top;
        bool on = false;
        if (wx == 0) on = dither(x, y, 0.5f);                          // lit edge
        else if (wy == 0) on = true;                                   // roofline
        else if (wy % 4 == 2 && wx > 1 && wx < b.w - 1)                 // window strips
          on = windowLit(b, wx / 3, wy, t, 25);
        px(x, y, on);
      }
    if (b.antenna) {
      for (int y = top - 5; y < top; y++) px(x0 + b.w - 3, y, true);
      if (((int)(t * 1.7f + b.seed)) & 1) { px(x0 + b.w - 3, top - 6, true); px(x0 + b.w - 4, top - 6, true); }
    }
  }
}

// ---------- rain ----------
struct Drop { float x, y, v; };
Drop drops[18];
void resetDrop(Drop &d, bool anywhere) { d.x = random(0, W + 14); d.y = anywhere ? random(-H, H) : random(-10, -2); d.v = 55 + random(35); }

void drawRain(float dt) {
  for (Drop &d : drops) {
    d.y += d.v * dt;
    d.x -= d.v * dt * 0.35f;
    if (d.y > H + 3) resetDrop(d, false);
    u8g2.drawLine((int)d.x, (int)d.y, (int)(d.x + 1), (int)(d.y - 3));
  }
}

// ---------- main ----------
void setup() {
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.setBusClock(800000);
  u8g2.begin();
  u8g2.setContrast(255);
  randomSeed(esp_random());
  initLayer(far, true);
  initLayer(mid, false);
  initLayer(near_, false);
  for (Drop &d : drops) resetDrop(d, true);
}

void loop() {
  static uint32_t last = millis();
  uint32_t now = millis();
  float dt = (now - last) / 1000.0f, t = now / 1000.0f;
  last = now;

  scrollLayer(far, dt, true);
  scrollLayer(mid, dt, false);
  scrollLayer(near_, dt, false);
  updateSpinner(t, dt);

  u8g2.clearBuffer();
  drawFar(t);
  drawFog();
  drawSearchlights(t);
  drawMid(t);
  if (spinner.active) drawSpinner(t);   // between mid and near: towers can pass in front of it
  drawNear(t);
  drawRain(dt);
  u8g2.sendBuffer();

  // ~40 fps
  int32_t spare = 25 - (int32_t)(millis() - now);
  if (spare > 0) delay(spare);
}
