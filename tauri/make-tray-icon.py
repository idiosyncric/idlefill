#!/usr/bin/env python3
"""Render the 22x22 tray template icon as raw RGBA bytes (tauri's
Image::new_owned takes RGBA, not PNG — the spike's correction: the tray
icon is embedded as a .rgba blob). A hollow ring: macOS draws template
images in the menu bar's own ink. Re-run after changing the shape."""
import struct, sys

W = H = 22
CX = CY = 10.5
R_OUT, R_IN = 8.5, 5.5

def inside(x, y, r):
    return (x - CX) ** 2 + (y - CY) ** 2 <= r * r

out = bytearray()
for y in range(H):
    for x in range(W):
        ring = inside(x, y, R_OUT) and not inside(x, y, R_IN)
        if ring:
            out += bytes((0, 0, 0, 255))
        else:
            out += bytes((0, 0, 0, 0))

path = sys.argv[1] if len(sys.argv) > 1 else "icons/tray-icon.rgba"
with open(path, "wb") as f:
    f.write(bytes(out))
print(f"{path}: {len(out)} bytes ({W}x{H} RGBA)")
