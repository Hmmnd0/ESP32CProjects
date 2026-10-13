// Data layout for scenes exported by the OLED3D editor (see editor/exporter.js).
#pragma once
#include <stdint.h>

struct SBox { float x0, x1, y0, y1, z0, z1; uint8_t win, style, flags, seed; };   // style 0 none 1 grid 2 bands; flags 1 edges 2 bright
struct SBillboard { float x, y, z, yaw, w, h; uint8_t tw, th, nframes, flags; uint16_t texOff; float dur[4]; };  // flags 1 scan 2 glitch 4 border
struct SModel { uint16_t vOff, nV, fOff, nF; float scale; uint8_t flags; float bob; uint16_t kOff, nK, lOff, nL; float zFront, yMin; };  // flags 1 autoOrient 2 headlights 4 thrusters 8 powerDown
struct SModelKey { float t, x, y, z, yaw, pitch, roll; uint8_t ease; };
struct SModelLight { float x, y, z; uint8_t mode; float rate, phase; };            // mode 0 steady 1 blink 2 alt 3 strobe
struct SStrip { float ax, ay, az, bx, by, bz, spacing; uint8_t shape, mode; float rate; };  // shape 0 line 1 rect; mode as above + 4 chase
struct SCamKey { float t; uint8_t mode, model, ease; float a[6]; };                 // mode 0 fixed (eye, look) 1 follow (back side up ahead lookSide lookUp)
