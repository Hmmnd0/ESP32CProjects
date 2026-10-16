# Video → OLED

Play a video in Chrome, with sound, while the ESP32-C3's 0.42" OLED shows the picture in sync, shrunk to 72×40.

> **This project now lives in its own repository: [Hmmnd0/oled-video](https://github.com/Hmmnd0/oled-video)**, with full install instructions. That's the version to use and update.

## Run it

First install PlatformIO, Node.js, ffmpeg and Chrome or Edge. See [SETUP.md](../SETUP.md).

```
cd web && npm start
```

Open http://localhost:8100 in **Chrome or Edge**.

1. **Flash receiver** (once). This puts the `video-player` firmware on the board, which plays saved videos and shows frames sent over USB.
2. **Connect board** and pick the `usbmodem…` port.
3. Choose a video:
   - **Open video file…** or drop a file. MP4, MOV and WebM play straight away. MKV, AVI, WMV, FLV, MPEG-TS and others are converted to MP4 first by ffmpeg (Apple's hardware encoder), and cached in `.cache/` for a day.
   - **YouTube link**: paste and Load. The video plays in the embedded YouTube player. Chrome asks to share **this tab**; choose it, and the player area is cropped out and streamed. Keep the tab visible while it plays.
   - **Capture a tab or window…**: mirror anything else, such as another tab or an app window. Its sound stays with that tab.

## Editing

Every file you open or drop becomes a clip on the **Edit** timeline (open several at once to build a sequence). The stage, the OLED, live streaming and **Save to board** all show the edit.

| | |
|---|---|
| Space | play / pause |
| ⏮ / Home | back to the beginning |
| Click / drag the ruler | move the playhead |
| Drag a clip | reorder |
| Drag a clip's edge | trim its start or end |
| S or ✂ Split | split the clip at the playhead |
| Del | delete the selected clip (the gap closes up) |
| ← → (Shift) | step a frame (a second) |
| Scroll on the timeline | zoom around the pointer |

**Each clip has its own picture.** With a clip selected, the Picture panel edits that clip: framing, keep position, dither, brightness, contrast, gamma, sharpen and invert. Clips you haven't changed use the default look, which the panel edits when no clip is selected. Splitting gives both halves the same look, ready to change separately. **Copy to all clips**, **Reset clip** and **Make default** do what they say, and clips with their own look show ◐ on the timeline. Shades (black and white or 4 greys) applies to the whole video. During a transition each clip keeps its own look: crossfades blend the tones, while wipes and dither dissolves switch pixel by pixel between each clip's own dithering.

Click the **◆** between two clips to choose the transition: cut, crossfade, fade through black, dither dissolve (OLED-pixel blocks switch over in a pattern) or wipe, plus its length. A transition overlaps the two clips, so the edit gets shorter by its length. Sound crossfades with it. Each clip also has a volume.

The edit is remembered between visits: the project in the browser's storage, and the original files in IndexedDB. Converted files are kept for a day.

## Picture controls

- **Framing:** crop to fill (**Keep** slides which part stays in view), fit with black bars, or stretch.
- **Shades:** black and white (no flicker), or 4 greys (made by flickering pixels).
- **Dither, brightness, contrast, gamma, sharpen, invert:** sharpening and contrast make the biggest difference at this size.

## How it works

Each new video frame is drawn to a canvas, shrunk in two steps (to 288×160, then 72×40), adjusted, dithered and packed into the SSD1306's page format. It's sent as `0xA5 0x5A` + 360 bytes (1-bit) or `0xA5 0x5B` + flags + 720 bytes (4 greys). Frames are dropped rather than queued when USB is busy, so the picture never lags behind the sound.
