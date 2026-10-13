# Video → OLED

Play a video in Chrome, with sound, while the ESP32-C3's 0.42" OLED shows the picture in sync, shrunk to 72×40.

## Run it

```
cd web && npm start
```

Open http://localhost:8100 in **Chrome or Edge**.

1. **Flash receiver** (once). This puts the Game Boy streamer's receiver firmware on the board, which shows frames sent over USB.
2. **Connect board** and pick the `usbmodem…` port.
3. Choose a video:
   - **Open video file…** or drop a file. MP4, MOV and WebM play straight away. MKV, AVI, WMV, FLV, MPEG-TS and others are converted to MP4 first by ffmpeg (Apple's hardware encoder), and cached in `.cache/` for a day.
   - **YouTube link**: paste and Load. The video plays in the embedded YouTube player. Chrome asks to share **this tab**; choose it, and the player area is cropped out and streamed. Keep the tab visible while it plays.
   - **Capture a tab or window…**: mirror anything else, such as another tab or an app window. Its sound stays with that tab.

## Picture controls

- **Framing:** crop to fill (**Keep** slides which part stays in view), fit with black bars, or stretch.
- **Shades:** black and white (no flicker), or 4 greys (made by flickering pixels).
- **Dither, brightness, contrast, gamma, sharpen, invert:** sharpening and contrast make the biggest difference at this size.

## How it works

Each new video frame is drawn to a canvas, shrunk in two steps (to 288×160, then 72×40), adjusted, dithered and packed into the SSD1306's page format. It's sent as `0xA5 0x5A` + 360 bytes (1-bit) or `0xA5 0x5B` + flags + 720 bytes (4 greys). Frames are dropped rather than queued when USB is busy, so the picture never lags behind the sound.
