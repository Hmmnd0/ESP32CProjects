// Matrix digital rain for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
//
// Three layers of rain for depth:
//   far  - tiny 2x3 glyphs, slow, always dithered (dim)
//   mid  - 3x5 glyphs, the main rain
//   near - big 6x10 glyphs, fast and occasional
// Each layer blacks out the area behind its glyphs, so nearer rain visibly
// passes in front of farther rain. Tails fade out through dither patterns
// (no grey flicker needed), and trail glyphs mutate as they fall.
// Press BOOT to cycle calm / normal / storm.
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6
#define BOOT_BTN 9

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40;

// 3x5 glyphs, one byte per row, bit 2 = left pixel. Rough katakana + digits.
const uint8_t GLYPHS[][5] = {
  {7, 1, 2, 2, 4},  // ア
  {1, 2, 6, 2, 2},  // イ
  {2, 7, 5, 1, 2},  // ウ
  {0, 7, 2, 2, 7},  // エ
  {1, 7, 3, 5, 1},  // オ
  {2, 7, 3, 5, 5},  // カ
  {2, 7, 2, 7, 2},  // キ
  {2, 3, 5, 1, 2},  // ク
  {4, 7, 5, 1, 2},  // ケ
  {0, 7, 1, 1, 7},  // コ
  {5, 7, 5, 1, 2},  // サ
  {4, 1, 4, 1, 6},  // シ
  {5, 5, 1, 1, 2},  // ツ
  {7, 0, 7, 2, 4},  // テ
  {4, 6, 5, 4, 4},  // ト
  {0, 7, 0, 0, 7},  // ニ
  {2, 2, 5, 5, 5},  // ハ
  {4, 7, 4, 4, 3},  // ヒ
  {7, 5, 5, 5, 7},  // 0
  {2, 6, 2, 2, 7},  // 1
  {7, 1, 7, 4, 7},  // 2
  {7, 1, 3, 1, 7},  // 3
  {7, 4, 7, 1, 7},  // 5
  {7, 1, 2, 2, 2},  // 7
  {7, 5, 7, 1, 7},  // 9
  {7, 4, 7, 4, 7},  // E-ish (mirrored 3)
};
const int GLYPH_COUNT = sizeof(GLYPHS) / sizeof(GLYPHS[0]);

// Tiny 2x3 glyphs for the far layer (bit 1 = left pixel), generated at startup
const int TINY_COUNT = 16;
uint8_t tiny[TINY_COUNT][3];

// ---------- layers ----------
const int MAX_COLS = 24, MAX_ROWS = 10;

struct Drop {
  float head;      // row of the head (negative while waiting above the screen)
  float speed;     // rows per second
  uint8_t len;     // trail length in cells
  bool active;
};

struct Layer {
  // geometry
  int cellW, cellH;     // grid cell size in pixels
  int scale;            // glyph pixel size (1 or 2)
  bool tinyGlyphs;      // use the 2x3 set
  int xOffset;          // shift the grid sideways so layers don't line up
  // behaviour
  float speedMul;       // relative to the mid layer, in pixels per second
  float lenMul;
  float waitMul;        // how long empty columns stay empty
  int baseFade;         // 0 = solid trail, 1 = dim trail
  int maxActive;        // limit on simultaneous drops (0 = no limit)
  // state
  int cols, rows;
  uint8_t glyph[MAX_COLS][MAX_ROWS];
  Drop drops[MAX_COLS];
};

Layer layers[3] = {
  // far
  {3, 4, 1, true, 1,   0.45f, 1.4f, 0.6f, 1, 0},
  // mid
  {4, 6, 1, false, 0,  1.0f, 1.0f, 1.0f, 0, 0},
  // near
  {8, 12, 2, false, 0, 1.9f, 0.7f, 3.0f, 0, 2},
};

// Intensity presets for the mid layer: speed range (rows/s), trail length, max wait (s)
struct Mode { float vMin, vMax; uint8_t lMin, lMax; float waitMax; };
const Mode MODES[] = {
  {3, 7, 3, 6, 4.0},     // calm
  {5, 13, 3, 8, 2.0},    // normal
  {10, 22, 4, 9, 0.6},   // storm
};
int mode = 1;

float frand(float a, float b) { return a + (b - a) * (esp_random() / 4294967295.0f); }

int glyphCount(const Layer &L) { return L.tinyGlyphs ? TINY_COUNT : GLYPH_COUNT; }

int activeDrops(const Layer &L) {
  int n = 0;
  for (int c = 0; c < L.cols; c++) if (L.drops[c].active) n++;
  return n;
}

void spawn(Layer &L, Drop &d, bool initial) {
  const Mode &m = MODES[mode];
  // Mid-layer speed is in 6px rows; convert so every layer moves in pixels/s
  float pxPerSec = frand(m.vMin, m.vMax) * 6 * L.speedMul;
  d.speed = pxPerSec / L.cellH;
  d.len = max(2, (int)roundf(random(m.lMin, m.lMax + 1) * L.lenMul));
  float wait = (initial ? frand(0, 3) : frand(0, m.waitMax)) * L.waitMul;
  d.head = -1 - wait * d.speed;
  d.active = true;
}

void initLayer(Layer &L) {
  L.cols = min(MAX_COLS, (W - L.xOffset + L.cellW - 1) / L.cellW);
  L.rows = min(MAX_ROWS, (H + L.cellH - 1) / L.cellH);
  for (int c = 0; c < L.cols; c++) {
    for (int r = 0; r < L.rows; r++) L.glyph[c][r] = random(glyphCount(L));
    if (L.maxActive) L.drops[c].active = false;   // sparse layers start empty and fill up gradually
    else spawn(L, L.drops[c], true);
  }
}

// Draw a glyph with a dither mask: 0 = solid, 1 = checkerboard, 2 = sparse.
// The cell behind it is blacked out first so this layer hides the ones behind.
void drawGlyph(const Layer &L, int col, int row, uint8_t g, int fade) {
  int gw = L.tinyGlyphs ? 2 : 3, gh = L.tinyGlyphs ? 3 : 5;
  int x0 = L.xOffset + col * L.cellW, y0 = row * L.cellH;

  u8g2.setDrawColor(0);
  u8g2.drawBox(x0 - 1, y0 - 1, gw * L.scale + 2, gh * L.scale + 2);
  u8g2.setDrawColor(1);

  for (int r = 0; r < gh; r++) {
    uint8_t bits = L.tinyGlyphs ? tiny[g][r] : GLYPHS[g][r];
    for (int c = 0; c < gw; c++) {
      if (!(bits & ((1 << (gw - 1)) >> c))) continue;
      for (int sy = 0; sy < L.scale; sy++)
        for (int sx = 0; sx < L.scale; sx++) {
          int x = x0 + c * L.scale + sx, y = y0 + r * L.scale + sy;
          if (fade == 1 && ((x + y) & 1)) continue;
          if (fade == 2 && ((x & 1) || (y & 1))) continue;
          u8g2.drawPixel(x, y);
        }
    }
  }
}

void updateAndDraw(Layer &L, float dt, uint32_t now) {
  // A few glyphs mutate every frame, like the film
  for (int i = 0; i < 2; i++) L.glyph[random(L.cols)][random(L.rows)] = random(glyphCount(L));

  for (int c = 0; c < L.cols; c++) {
    Drop &d = L.drops[c];
    if (!d.active) {
      // Columns limited by maxActive wait here until there's room
      if (random(100) < 2 && (!L.maxActive || activeDrops(L) < L.maxActive)) spawn(L, d, false);
      continue;
    }
    int prevHead = (int)floorf(d.head);
    d.head += d.speed * dt;
    int head = (int)floorf(d.head);
    if (head != prevHead && head >= 0 && head < L.rows) L.glyph[c][head] = random(glyphCount(L));
    if (head - d.len > L.rows) {
      if (L.maxActive) d.active = false;     // sparse layers re-roll for a slot
      else spawn(L, d, false);
      continue;
    }

    // Draw tail first so the head is never covered by its own trail's blackout
    for (int dist = d.len - 1; dist >= 0; dist--) {
      int r = head - dist;
      if (r < 0 || r >= L.rows) continue;
      int fade = L.baseFade;
      if (dist >= d.len - 1 && d.len > 2) fade = 2;
      else if (dist >= d.len * 2 / 3) fade = max(fade, 1);
      if (dist == 0) fade = 0;                 // heads are always solid
      drawGlyph(L, c, r, L.glyph[c][r], fade);
      if (dist == 0 && !L.tinyGlyphs && (now / 60 + c) % 3 == 0) {
        // Make the head pop: an underline flash on some frames
        int x0 = L.xOffset + c * L.cellW, y0 = r * L.cellH;
        u8g2.drawBox(x0, y0 + 5 * L.scale, 3 * L.scale, L.scale);
      }
    }
  }
}

void showModeName() {
  static const char *names[] = {"calm", "normal", "storm"};
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_5x7_tr);
  int w = u8g2.getStrWidth(names[mode]);
  u8g2.drawStr((W - w) / 2, 24, names[mode]);
  u8g2.sendBuffer();
  delay(500);
}

void setup() {
  pinMode(BOOT_BTN, INPUT_PULLUP);
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.setBusClock(800000);
  u8g2.begin();
  u8g2.setContrast(255);
  randomSeed(esp_random());
  // Random 2x3 patterns with 3-5 pixels lit look like distant glyphs
  for (int i = 0; i < TINY_COUNT; i++) {
    int lit;
    do {
      lit = 0;
      for (int r = 0; r < 3; r++) { tiny[i][r] = random(4); lit += __builtin_popcount(tiny[i][r]); }
    } while (lit < 3 || lit > 5);
  }
  for (Layer &L : layers) initLayer(L);
}

void loop() {
  static uint32_t last = millis();
  static bool btnWas = false;
  uint32_t now = millis();
  float dt = (now - last) / 1000.0f;
  last = now;

  // BOOT button cycles intensity
  bool btn = digitalRead(BOOT_BTN) == LOW;
  if (btn && !btnWas) { mode = (mode + 1) % 3; showModeName(); last = millis(); }
  btnWas = btn;

  u8g2.clearBuffer();
  for (Layer &L : layers) updateAndDraw(L, dt, now);   // far -> mid -> near
  u8g2.sendBuffer();

  // ~40 fps
  int32_t spare = 25 - (int32_t)(millis() - now);
  if (spare > 0) delay(spare);
}
