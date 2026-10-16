# OLED3D

A tiny 3D scene editor for the ESP32-C3 + 0.42" OLED (72×40). Build a scene in the browser, preview it exactly as the board will draw it, stream it live to the OLED, then flash it so the board plays it on its own.

```
editor/     the web editor (three.js scene view + our own engine for the OLED preview)
  engine.js     the renderer, in JavaScript. firmware/src/main.cpp is a line-for-line port
  exporter.js   scene JSON -> firmware/include/scene.h
  server.mjs    local server: scenes, export, flashing
firmware/   the player: plays scene.h, and shows live frames from the editor
scenes/     saved scenes (JSON)
tools/      make-example.mjs rebuilds the spinner-landing example
```

## Run it

First install PlatformIO, Node.js and Chrome or Edge. See [SETUP.md](../SETUP.md) for step-by-step instructions for macOS, Windows and Linux.

```
cd editor && npm install && npm start
```

Open http://localhost:8090 in **Chrome or Edge** (Web Serial is needed for the live link).

The first time, flash the player firmware once with **Flash to board**. After that:

- **Connect board** then **Live on OLED** streams the editor preview to the screen as you edit.
- **Flash to board** exports the scene, builds and uploads it. The board then plays it with no computer attached.

## Making scenes

- **Buildings** are boxes, with window grids or bands, lit edges, and fog.
- **Street…** fills a street with buildings.
- **Billboards** take any image (dithered to dots), up to 4 animation frames, with optional scanline, glitch and frame.
- **Text signs** are neon text, vertical or horizontal.
- **Models**: spinner, blimp, pyramid and cube are built in, or **Import .obj** from Blender (export with Forward −Z, Up Y; 255 vertices max; materials named glass/dark become black). Models fly along keyframes and can face their direction of travel, bank, bob, and carry blinking lights, headlights and thrusters.
- **Light strips** are lines or rectangles of lights, steady, blinking, strobing or chasing.
- **Camera keys** are either *fixed* (an eye position plus a point to look at) or *follow*, which chases a model. **Key from current view** records whatever the editor view shows. **Camera view** looks through the scene camera, with the OLED's frame outlined.

## Timeline

- Double-click a row to add a key. Drag keys to retime them. Each key's **ease** shapes the move to the next key.
- With a model selected and no key selected, dragging it adds a key at the playhead.
- The shaded graph is the estimated board frame rate across the loop. Green is fine; red is under 12 fps. When the board is connected it reports its real frame rate under the preview.

## Keys

| | |
|---|---|
| Space | play / pause |
| ← → (Shift) | step 0.05 s (1 s) |
| W / E / R | move / rotate / resize |
| Right-drag + WASD | fly through the scene (Q/E down/up, Shift fast, scroll = speed) |
| Z | toggle fly mode with the mouse captured (Esc to stop) |
| Middle-drag | pan |
| V | four views (3D, Top, Front, Side), like Hammer |
| B | block tool: drag a rectangle in a 2D view to make a box |
| [ / ] | smaller / bigger grid (1 to 64) |
| P | camera path tool: in a 2D view, drag from where the camera is to what it looks at; the playhead then steps on |
| M | model path tool: select a model, then click points along its route in a 2D view; the playhead steps on after each |
| F | focus the selection |
| C | camera view |
| K | add a key |
| Del | delete the key or object |
| Cmd+Z / Cmd+Shift+Z (Ctrl on Windows/Linux) | undo / redo |
| Cmd+S (Ctrl+S on Windows/Linux) | save |

## Limits (it's a tiny chip)

No FPU, so everything is budgeted:

- up to 420 visible faces per frame
- 160 faces and 255 vertices per model
- billboard textures up to 64×64 with 4 frames
- 40 raindrops

Keep scenes in the green on the cost graph.
