"""Small deterministic PNGs for browser image-adjustment integration checks.

No third-party modules are required. The PNG has colour and neutral patches,
a soft grey edge for sharpening, a translucent circle, and a transparent border.
"""

import json
import math
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parent
WIDTH, HEIGHT = 320, 240


def png(path, pixel):
    rows = bytearray()
    for y in range(HEIGHT):
        rows.append(0)
        for x in range(WIDTH):
            rows.extend(pixel(x, y))

    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)

    path.write_bytes(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', WIDTH, HEIGHT, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(bytes(rows), 9))
        + chunk(b'IEND', b'')
    )


def primary(x, y):
    if x < 16 or y < 16 or x >= WIDTH - 16 or y >= HEIGHT - 16:
        return (0, 0, 0, 0)
    value = (223, 225, 217, 255)
    if 24 <= x < 188 and 24 <= y < 90:
        g = round(30 + (x - 24) / 163 * 190)
        value = (g, g, g, 255)
    if 28 <= x < 92 and 110 <= y < 162:
        value = (184, 71, 48, 255)
    if 106 <= x < 170 and 110 <= y < 162:
        value = (49, 145, 82, 255)
    if 28 <= x < 92 and 176 <= y < 212:
        value = (48, 94, 179, 255)
    if 106 <= x < 170 and 176 <= y < 212:
        value = (203, 153, 56, 255)
    if 198 <= x < 288 and 110 <= y < 212:
        # A deliberately soft edge has overshoot-free source values, so an
        # unsharp-mask operation can visibly increase edge contrast.
        transition = (math.tanh((x - 242) / 3.2) + 1) / 2
        g = round(76 + transition * 104)
        if 126 <= y < 130 or 190 <= y < 194:
            g = 38
        value = (g, g, g, 255)
    distance = math.hypot(x - 258, y - 55)
    if distance < 31:
        alpha = round(158 * min(1, 31 - distance))
        value = (220, 132, 63, alpha)
    return value


def alternate(x, y):
    if x < 16 or y < 16 or x >= WIDTH - 16 or y >= HEIGHT - 16:
        return (0, 0, 0, 0)
    if 26 <= x < 294 and 26 <= y < 214:
        if abs((x - 160) / 1.3) + abs(y - 120) < 85:
            return (212, 47, 150, 255)
        return (33, 128, 172, 255)
    return (208, 229, 236, 255)


png(ROOT / 'image-filter-probe.png', primary)
png(ROOT / 'image-filter-alternate.png', alternate)
(ROOT / 'image-filter-fixture.json').write_text(json.dumps({
    'width': WIDTH,
    'height': HEIGHT,
    'files': ['image-filter-probe.png', 'image-filter-alternate.png'],
    'probes': {
        'transparent': [0, 0],
        'neutralLow': [40, 44],
        'neutralHigh': [174, 44],
        'neutralMiddle': [105, 44],
        'red': [58, 136],
        'translucent': [258, 55],
        'softEdge': [240, 154],
    },
}, ensure_ascii=False, indent=2) + '\n')
print('Generated two 320×240 RGBA filter fixtures.')
