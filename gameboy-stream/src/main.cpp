// Game Boy stream receiver for ESP32-C3 + 0.42" OLED (SSD1306, 72x40 visible, I2C)
//
// The browser (web/index.html) runs the emulator, shrinks each frame to 72x40
// and sends it over USB serial. Two packet types:
//
//   0xA5 0x5A + 360 bytes            1-bit frame
//   0xA5 0x5B + flags + 720 bytes    2-bit frame (4 grey levels): low bit-plane, then high
//
// Planes use SSD1306 page format (5 pages x 72 columns, byte = 8 vertical
// pixels, LSB on top), which is also U8g2's buffer layout.
//
// The OLED can only switch pixels on or off, so greys are made by time:
// the screen is redrawn as fast as I2C allows in a cycle of 3 sub-frames, and
// a pixel at level L (0-3) is lit in L of them. With flag bit 0 set, each
// pixel's cycle is phase-shifted by position so the flicker doesn't pulse
// across the whole screen at once.
#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// Common pinout for ESP32-C3 "0.42 OLED" boards. Change if yours differs.
#define OLED_SDA 5
#define OLED_SCL 6

U8G2_SSD1306_72X40_ER_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

const int W = 72, H = 40;
const int PLANE = W * H / 8;   // 360
const uint32_t IDLE_AFTER_MS = 2000;

// The SSD1306 is only rated for 400 kHz, but these panels run happily faster.
// If the picture glitches, lower this.
#ifndef I2C_HZ
#define I2C_HZ 1000000
#endif
const uint8_t OLED_ADDR = 0x3C;
const uint8_t COL_OFFSET = 28;   // the 72 visible columns are 28..99 of the controller's 128

uint8_t level[W * H];          // 0..3 per pixel
uint8_t phase[W * H];          // per-pixel flicker offset, 0..2
uint8_t body[PLANE * 2];
bool grey = false, scatter = true;

enum { WAIT_A5, WAIT_TYPE, WAIT_FLAGS, READ_BODY } rx = WAIT_A5;
uint8_t type = 0;
int need = 0, fill = 0;

uint32_t lastFrameAt = 0, statsAt = 0, subframes = 0, framesIn = 0;
bool streaming = false;
uint8_t sub = 0;

void drawIdle(uint32_t now) {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_5x7_tr);
  // Shared by the Game Boy and video streamers, so keep it neutral
  u8g2.drawStr(11, 10, "USB SCREEN");
  u8g2.drawStr(1, 20, "waiting for PC");
  int x = 6 + (now / 40) % 60;
  if ((now / 2400) % 2) x = 66 - (now / 40) % 60;
  u8g2.drawDisc(x, 32, 2);
  u8g2.sendBuffer();
}

void applyFrame() {
  for (int page = 0; page < H / 8; page++)
    for (int x = 0; x < W; x++) {
      uint8_t lo = body[page * W + x];
      uint8_t hi = (type == 0x5B) ? body[PLANE + page * W + x] : lo;
      for (int bit = 0; bit < 8; bit++)
        level[(page * 8 + bit) * W + x] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
    }
  grey = (type == 0x5B);
  lastFrameAt = millis();
  streaming = true;
  framesIn++;
}

void oledCommands(const uint8_t *cmds, size_t n) {
  Wire.beginTransmission(OLED_ADDR);
  Wire.write(0x00);                       // control byte: commands follow
  Wire.write(cmds, n);
  Wire.endTransmission();
}

// Push a whole frame in ONE I2C transfer. U8g2's sendBuffer() splits it into
// many small transfers, and the per-transfer overhead was most of the time.
void pushFrame(const uint8_t *buf) {
  static const uint8_t window[] = { 0x21, COL_OFFSET, COL_OFFSET + W - 1,   // column range
                                    0x22, 0, H / 8 - 1 };                    // page range
  oledCommands(window, sizeof(window));
  Wire.beginTransmission(OLED_ADDR);
  Wire.write(0x40);                       // control byte: display data follows
  Wire.write(buf, PLANE);
  Wire.endTransmission();
}

// Build one sub-frame and push it out
uint8_t subBuf[PLANE];
void renderSubframe() {
  uint8_t *buf = subBuf;
  for (int page = 0; page < H / 8; page++)
    for (int x = 0; x < W; x++) {
      uint8_t b = 0;
      for (int bit = 0; bit < 8; bit++) {
        int i = (page * 8 + bit) * W + x;
        uint8_t ph = scatter ? (sub + phase[i]) % 3 : sub;
        if (level[i] > ph) b |= 1 << bit;
      }
      buf[page * W + x] = b;
    }
  pushFrame(buf);
  sub = (sub + 1) % 3;
  subframes++;
}

void readSerial() {
  while (Serial.available()) {
    if (rx == READ_BODY) {
      int n = Serial.read(body + fill, need - fill);
      if (n <= 0) break;
      fill += n;
      if (fill == need) { applyFrame(); rx = WAIT_A5; }
      continue;
    }
    int b = Serial.read();
    switch (rx) {
      case WAIT_A5: if (b == 0xA5) rx = WAIT_TYPE; break;
      case WAIT_TYPE:
        if (b == 0x5A)      { type = b; need = PLANE; fill = 0; rx = READ_BODY; }
        else if (b == 0x5B) { type = b; rx = WAIT_FLAGS; }
        else                rx = (b == 0xA5) ? WAIT_TYPE : WAIT_A5;
        break;
      case WAIT_FLAGS:
        scatter = b & 1; need = PLANE * 2; fill = 0; rx = READ_BODY;
        break;
      default: break;
    }
  }
}

void setup() {
  Serial.setRxBufferSize(4096);
  Serial.begin(115200);   // baud is ignored on native USB, but begin() is required
  Wire.setBufferSize(PLANE + 8);          // room for a whole frame in one transfer
  Wire.begin(OLED_SDA, OLED_SCL);
  u8g2.setBusClock(I2C_HZ);
  u8g2.begin();
  u8g2.setContrast(255);
  Wire.setClock(I2C_HZ);
  // Run the panel's own scan oscillator at its fastest, so its refresh doesn't
  // beat visibly against our grey sub-frames
  static const uint8_t fastOsc[] = { 0xD5, 0xF0 };
  oledCommands(fastOsc, sizeof(fastOsc));
  // Spread the flicker phases in a diagonal pattern
  for (int y = 0; y < H; y++)
    for (int x = 0; x < W; x++) phase[y * W + x] = (x + 2 * y) % 3;
}

void loop() {
  uint32_t before = framesIn;
  readSerial();
  // Read the clock *after* receiving: applyFrame() stamps lastFrameAt with
  // millis(), and an earlier 'now' would make now - lastFrameAt wrap around.
  uint32_t now = millis();

  if (streaming && now - lastFrameAt > IDLE_AFTER_MS) streaming = false;

  if (!streaming) {
    static uint32_t lastIdle = 0;
    if (now - lastIdle > 33) { lastIdle = now; drawIdle(now); }
  } else if (grey) {
    renderSubframe();                          // keep cycling for greys
  } else if (framesIn != before) {
    sub = 0; renderSubframe();                 // 1-bit: only redraw on new frames
  }

  // Report refresh rates back to the page once a second
  if (now - statsAt >= 1000) {
    if (streaming) Serial.printf("STATS %lu %lu\n", (unsigned long)subframes, (unsigned long)framesIn);
    subframes = framesIn = 0; statsAt = now;
  }
}
