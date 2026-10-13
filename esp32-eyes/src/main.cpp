// Animated eyes for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40;
const int EYE_W = 24, EYE_H = 26, EYE_GAP = 10, EYE_R = 6;

enum Mood { NORMAL, HAPPY, ANGRY, SAD, SLEEPY, SURPRISED, MOOD_COUNT };

// Smoothed state
float lookX = 0, lookY = 0, tLookX = 0, tLookY = 0;   // pupil offset
float openAmt = 1, tOpen = 1;                          // 0 = closed, 1 = open
float sizeL = 1, sizeR = 1, tSize = 1;                 // eye scale
Mood mood = NORMAL;

uint32_t nextBlink, nextLook, nextMood, blinkEnd;
bool blinking = false;

float approach(float v, float target, float k) { return v + (target - v) * k; }

void drawEye(int cx, int cy, float scale, bool left) {
  int w = EYE_W * scale;
  int h = max(2, (int)(EYE_H * scale * openAmt));
  int x = cx - w / 2, y = cy - h / 2;
  int r = min(EYE_R, min(w, h) / 2 - 1);
  if (r < 1) { u8g2.drawBox(x, y, w, h); return; }

  u8g2.setDrawColor(1);
  u8g2.drawRBox(x, y, w, h, r);

  // Pupil: black disc that shifts further than the eye itself, clamped inside
  u8g2.setDrawColor(0);
  int pr = (mood == SURPRISED) ? 3 : 5;
  int maxDx = w / 2 - pr - 2, maxDy = h / 2 - pr - 2;
  if (maxDx > 0 && maxDy >= 0) {
    int px = cx + constrain((int)(lookX * 0.5f), -maxDx, maxDx);
    int py = cy + constrain((int)(lookY * 0.8f), -maxDy, maxDy);
    u8g2.drawDisc(px, py, pr);
    // Catch-light highlight
    u8g2.setDrawColor(1);
    u8g2.drawDisc(px - pr / 2, py - pr / 2, 1);
    u8g2.setDrawColor(0);
  }

  // Eyelid shapes are drawn by "erasing" with black
  switch (mood) {
    case HAPPY:   // bottom cut out -> ^ ^ shape
      u8g2.drawRBox(x - 2, y + h / 2 + 2, w + 4, h, EYE_R);
      break;
    case ANGRY:   // inner-top slant
      if (left) u8g2.drawTriangle(x, y - 1, x + w, y - 1, x + w, y + h / 2);
      else      u8g2.drawTriangle(x, y - 1, x + w, y - 1, x, y + h / 2);
      break;
    case SAD:     // outer-top slant
      if (left) u8g2.drawTriangle(x, y - 1, x + w, y - 1, x, y + h / 2);
      else      u8g2.drawTriangle(x, y - 1, x + w, y - 1, x + w, y + h / 2);
      break;
    case SLEEPY:  // heavy top lid
      u8g2.drawBox(x, y - 1, w, h / 2);
      break;
    default: break;
  }
  u8g2.setDrawColor(1);
}

void pickMood() {
  int r = random(100);
  if (r < 55) mood = NORMAL;
  else mood = (Mood)random(1, MOOD_COUNT);
  tSize = (mood == SURPRISED) ? 1.15f : 1.0f;
  nextMood = millis() + random(3000, 7000);
}

void setup() {
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.begin();
  u8g2.setContrast(255);
  randomSeed(esp_random());
  uint32_t now = millis();
  nextBlink = now + 1500;
  nextLook = now + 800;
  nextMood = now + 4000;
}

void loop() {
  uint32_t now = millis();

  // Blinking
  if (!blinking && now > nextBlink) {
    blinking = true; tOpen = 0; blinkEnd = now + 90;
  }
  if (blinking && now > blinkEnd && openAmt < 0.15f) {
    blinking = false; tOpen = (mood == SLEEPY) ? 0.8f : 1.0f;
    // occasional double blink
    nextBlink = now + (random(5) == 0 ? 180 : random(1800, 5000));
  }

  // Saccades: snap gaze to a new random point
  if (now > nextLook) {
    tLookX = random(-14, 15);
    tLookY = random(-5, 6);
    if (random(3) == 0) { tLookX = 0; tLookY = 0; }
    nextLook = now + random(600, 2500);
  }

  if (now > nextMood) pickMood();

  // Ease toward targets
  lookX = approach(lookX, tLookX, 0.35f);
  lookY = approach(lookY, tLookY, 0.35f);
  openAmt = approach(openAmt, tOpen, blinking ? 0.6f : 0.4f);
  // Eye nearer the gaze direction gets slightly bigger (fake perspective)
  float tl = tSize * (1.0f - lookX * 0.006f);
  float tr = tSize * (1.0f + lookX * 0.006f);
  sizeL = approach(sizeL, tl, 0.3f);
  sizeR = approach(sizeR, tr, 0.3f);

  int cy = H / 2 + (int)lookY;
  int lcx = W / 2 - EYE_GAP / 2 - EYE_W / 2 + (int)lookX;
  int rcx = W / 2 + EYE_GAP / 2 + EYE_W / 2 + (int)lookX;

  u8g2.clearBuffer();
  drawEye(lcx, cy, sizeL, true);
  drawEye(rcx, cy, sizeR, false);
  u8g2.sendBuffer();

  delay(16);  // ~60 fps target
}
