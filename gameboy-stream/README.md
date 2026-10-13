# Game Boy → ESP32-C3 OLED

Play Game Boy games in Chrome and mirror them, shrunk to 72×40, onto the 0.42" OLED over USB.

- `src/main.cpp` is the board firmware. It shows "open browser" until frames arrive.
- `web/` is the browser page: the emulator (WasmBoy), the downscaler and dithering, and the Web Serial sender.

## Run it

1. Flash the board (only needed once, or after flashing something else):
   `pio run -t upload` (from this folder)
2. Start the page:
   `cd web && npm start`
3. Open http://localhost:8080 in **Chrome or Edge**. Safari and Firefox have no Web Serial.
4. Drop a `.gb` file on the page, click **Connect board**, and pick the ESP32 (usbmodem…).

The page remembers the last ROM and your settings. In-game saves are kept in the browser automatically; use **Download .sav** to back them up.

## Picture options

- **Zoom**: 1× maps each Game Boy pixel to one OLED pixel (sharpest); 2× shrinks 2×2 blocks.
- **Outlines**: when shrinking, pulls pixels toward the darkest pixel they cover, so thin black lines don't get averaged away.
- **4 greys**: the board redraws the screen in a cycle of 3 sub-frames and lights a pixel in 0–3 of them. "Spread out" staggers the cycle per pixel so the flicker doesn't pulse across the whole screen.
- **Pokémon text** (Red/Blue/Yellow): reads the dialog box from the game's tile map at `$C3A0` and redraws it in a 4×6 font, 18 characters per line, under a 25-pixel view of the game.

## Frame format

- `0xA5 0x5A` + 360 bytes: 1-bit frame.
- `0xA5 0x5B` + flags + 720 bytes: 2-bit frame, low bit-plane then high. Flags bit 0 = spread the flicker.

Planes are 5 pages × 72 columns in SSD1306 page order (each byte is 8 vertical pixels, LSB on top). The board prints `STATS <sub-frames/s> <frames/s>` once a second.

`web/font4x6.js` is generated from U8g2 by `tools/gen-font.mjs`.
