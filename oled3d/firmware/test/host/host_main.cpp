// Renders the scene at fixed times and writes the 1-bit frames to stdout
// (360 bytes each), for comparing engine versions pixel by pixel.
//   host_main <step-seconds> [only-frame]
#include "../../src/main.cpp"
HostSerial Serial;
HostWire Wire;
int main(int argc, char **argv) {
  prepareBoxes();
  float step = argc > 1 ? atof(argv[1]) : 0.25f;
  int only = argc > 2 ? atoi(argv[2]) : -1;
  for (int i = 0; i * step < SC_DURATION; i++) {
    if (only >= 0 && i != only) continue;
    renderScene(i * step);
    fwrite(u8g2.getBufferPtr(), 1, 360, stdout);
  }
  return 0;
}
