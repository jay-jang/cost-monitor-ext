#!/usr/bin/env python3
"""Generate extension icons without external deps: dark tile, three provider
dots, and a partially-filled meter bar."""
import os
import struct
import zlib

BG = (31, 34, 41, 255)
DOTS = [(217, 119, 87, 255), (16, 163, 127, 255), (66, 133, 244, 255)]
TRACK = (14, 16, 19, 255)
FILL = (52, 168, 83, 255)


def chunk(tag, data):
    raw = tag + data
    return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw))


def write_png(path, size, pixels):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    scanlines = b"".join(
        b"\x00" + b"".join(bytes(pixels[y][x]) for x in range(size))
        for y in range(size)
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(scanlines, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def draw(size):
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    r = max(2, size // 6)  # corner radius

    def inside_tile(x, y):
        cx = min(x, size - 1 - x)
        cy = min(y, size - 1 - y)
        if cx >= r or cy >= r:
            return True
        return (cx - r) ** 2 + (cy - r) ** 2 <= r * r

    for y in range(size):
        for x in range(size):
            if inside_tile(x, y):
                px[y][x] = BG

    # three dots across the upper area
    dot_r = max(1, size * 9 // 128)
    dot_y = size * 38 // 128
    for i, color in enumerate(DOTS):
        dot_x = size * (32 + 32 * i) // 128
        for y in range(size):
            for x in range(size):
                if (x - dot_x) ** 2 + (y - dot_y) ** 2 <= dot_r * dot_r:
                    px[y][x] = color

    # meter bar across the lower area, ~65% filled
    bar_x0, bar_x1 = size * 20 // 128, size * 108 // 128
    bar_y0, bar_y1 = size * 72 // 128, size * 92 // 128
    fill_x = bar_x0 + (bar_x1 - bar_x0) * 65 // 100
    for y in range(bar_y0, bar_y1):
        for x in range(bar_x0, bar_x1):
            px[y][x] = FILL if x < fill_x else TRACK
    return px


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 48, 128):
        write_png(os.path.join(out, f"icon{size}.png"), size, draw(size))
        print(f"icon{size}.png")


if __name__ == "__main__":
    main()
