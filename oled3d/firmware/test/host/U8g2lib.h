// Host stand-in for U8g2: a 72x40 1-bit buffer in SSD1306 page order.
#pragma once
#include <cstdint>
#include <cstring>
#define U8G2_R0 0
#define U8X8_PIN_NONE 255
struct U8G2_SSD1306_72X40_ER_F_HW_I2C {
  uint8_t buf[360]; int color = 1;
  U8G2_SSD1306_72X40_ER_F_HW_I2C(int, int) { clearBuffer(); }
  void begin() {} void setBusClock(uint32_t) {} void setContrast(int) {} void sendBuffer() {}
  void clearBuffer() { memset(buf, 0, sizeof(buf)); }
  uint8_t *getBufferPtr() { return buf; }
  void setDrawColor(int c) { color = c; }
  void drawPixel(int x, int y) {
    if ((unsigned)x >= 72 || (unsigned)y >= 40) return;
    uint8_t &b = buf[(y >> 3) * 72 + x], m = 1 << (y & 7);
    if (color) b |= m; else b &= ~m;
  }
  void drawHLine(int x, int y, int w) { for (int i = 0; i < w; i++) drawPixel(x + i, y); }
};
