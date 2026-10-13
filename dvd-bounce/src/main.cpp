// Bouncing DVD logo for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40;
const uint32_t STEP_MS = 40;   // lower = faster

int logoW, logoH;
int x = 5, y = 3, dx = 1, dy = 1;
bool inverted = false;          // mono stand-in for the classic colour change
uint32_t lastStep = 0;
uint32_t flashUntil = 0;        // corner-hit celebration
int cornerHits = 0;

void drawLogo(int lx, int ly) {
  if (inverted) {
    u8g2.setDrawColor(1);
    u8g2.drawRBox(lx, ly, logoW, logoH, 2);
    u8g2.setDrawColor(0);
  } else {
    u8g2.setDrawColor(1);
  }
  int cx = lx + logoW / 2;
  int tw = u8g2.getStrWidth("DVD");
  u8g2.drawStr(cx - tw / 2, ly + 9, "DVD");
  u8g2.drawFilledEllipse(cx, ly + 11, tw / 2, 1);   // the disc swoosh
  u8g2.setDrawColor(1);
}

void setup() {
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.begin();
  u8g2.setContrast(255);
  u8g2.setFont(u8g2_font_helvB08_tr);
  logoW = u8g2.getStrWidth("DVD") + 4;
  logoH = 14;
  randomSeed(esp_random());
  x = random(0, W - logoW);
  y = random(0, H - logoH);
  dx = random(2) ? 1 : -1;
  dy = random(2) ? 1 : -1;
}

void loop() {
  uint32_t now = millis();
  if (now - lastStep < STEP_MS) return;
  lastStep = now;

  x += dx; y += dy;
  bool hitX = false, hitY = false;
  if (x <= 0 || x >= W - logoW) { dx = -dx; hitX = true; x = constrain(x, 0, W - logoW); }
  if (y <= 0 || y >= H - logoH) { dy = -dy; hitY = true; y = constrain(y, 0, H - logoH); }
  if (hitX || hitY) inverted = !inverted;
  if (hitX && hitY) { cornerHits++; flashUntil = now + 1200; }

  u8g2.clearBuffer();
  drawLogo(x, y);
  u8g2.sendBuffer();

  // Corner hit: flash the whole screen
  bool flashing = now < flashUntil;
  u8g2.sendF("c", flashing && ((now / 150) % 2) ? 0xA7 : 0xA6);  // invert / normal
}
