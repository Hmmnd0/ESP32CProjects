// Host stand-in for the bits of Arduino the engine uses, so it can be tested on a PC.
#pragma once
#include <cstdint>
#include <cstring>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
using std::min; using std::max;
#ifndef PI
#define PI 3.14159265358979f
#endif
inline uint32_t millis() { return 0; }
inline uint32_t micros() { return 0; }
inline void delay(uint32_t) {}
struct HostSerial {
  void setRxBufferSize(int) {} void begin(int) {}
  int available() { return 0; } int read() { return -1; } int read(uint8_t *, int) { return 0; }
  template <typename... A> void printf(const char *f, A... a) { std::printf(f, a...); }
};
extern HostSerial Serial;
