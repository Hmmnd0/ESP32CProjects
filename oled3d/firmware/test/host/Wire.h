#pragma once
struct HostWire { void begin(int, int) {} void setClock(uint32_t) {} };
extern HostWire Wire;
