#!/usr/bin/env python3
"""Generate the pi.dev gallery preview card (pi.image) for pi-winfs-bridge."""
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "preview.png")

BG = (13, 17, 23)
PANEL = (22, 28, 38)
BORDER = (48, 58, 74)
FG = (230, 237, 243)
MUTED = (139, 148, 158)
ACCENT = (88, 166, 255)
GREEN = (63, 185, 80)
AMBER = (240, 180, 80)

CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
CJK_B = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"


def font(path, size, index=0):
    return ImageFont.truetype(path, size, index=index)


f_title = font(CJK_B, 62)
f_sub = font(CJK, 27)
f_badge = font(CJK_B, 21)
f_row = font(MONO, 25)
f_row_b = font(MONO, 25)
f_small = font(MONO, 20)
f_small_cjk = font(CJK, 20)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# subtle top gradient band
for y in range(0, 210):
    t = y / 210
    c = tuple(int(BG[i] + (PANEL[i] - BG[i]) * (1 - t) * 0.65) for i in range(3))
    d.line([(0, y), (W, y)], fill=c)

# outer border
d.rectangle([0, 0, W - 1, H - 1], outline=BORDER, width=2)


def text(x, y, s, f, fill, anchor="la"):
    d.text((x, y), s, font=f, fill=fill, anchor=anchor)


# --- header ---
text(64, 54, "pi-winfs-bridge", f_title, FG)
text(64, 132, "让 WSL2 里的 Pi 读写 Windows 盘，快 80~105 倍", f_sub, MUTED)

# badges
bx = 64
for label, col in (("Pi Extension", ACCENT), ("WSL2", GREEN), ("MIT", AMBER)):
    tw = d.textlength(label, font=f_badge)
    d.rounded_rectangle(
        [bx, 178, bx + tw + 30, 178 + 36], radius=18, outline=col, width=2
    )
    text(bx + 15, 186, label, f_badge, col)
    bx += tw + 30 + 12

# --- benchmark panel ---
PX, PY, PW, PH = 64, 246, W - 128, 254
d.rounded_rectangle([PX, PY, PX + PW, PY + PH], radius=14, fill=PANEL, outline=BORDER, width=2)

cols = [(PX + 34, "la"), (PX + 470, "ra"), (PX + 660, "ra"), (PX + 900, "ra")]
heads = ["operation", "WSL 9p", "bridge", "speedup"]
for (cx, anc), h in zip(cols, heads):
    text(cx, PY + 22, h, f_small, MUTED, anchor=anc)

d.line([(PX + 24, PY + 58), (PX + PW - 24, PY + 58)], fill=BORDER, width=1)

rows = [
    ("tree walk", "5533 ms", "53 ms", "105x"),
    ("grep (limit 100)", "3803 ms", "47 ms", "81x"),
    ("find *.json", "945 ms", "101 ms", "9x"),
    ("read 200 files", "863 ms", "961 ms", "1x"),
]
y = PY + 76
for name, slow, fast, mult in rows:
    dim = mult == "1x"
    text(cols[0][0], y, name, f_row, MUTED if dim else FG)
    text(cols[1][0], y, slow, f_row, MUTED)
    text(cols[2][0], y, fast, f_row_b, MUTED if dim else GREEN)
    text(cols[3][0], y, mult, f_row_b, MUTED if dim else GREEN)
    y += 44

# --- diagram strip ---
DY = 514
DH = 66
d.rounded_rectangle([64, DY, 560, DY + DH], radius=10, fill=PANEL, outline=BORDER, width=2)
text(84, DY + 10, "Pi (WSL2)", f_small_cjk, ACCENT)
text(84, DY + 36, "read / edit / ls / find / grep", f_small, MUTED)

text(586, DY + 18, "──TCP──▶", f_small, BORDER)

d.rounded_rectangle([760, DY, W - 64, DY + DH], radius=10, fill=PANEL, outline=BORDER, width=2)
text(780, DY + 10, "Windows  host", f_small_cjk, GREEN)
text(780, DY + 36, "bridge.py → native NTFS", f_small, MUTED)

# footer
text(64, H - 38, "pi install npm:pi-winfs-bridge", f_small, MUTED)

img.save(OUT, "PNG", optimize=True)
print("wrote", OUT, img.size, os.path.getsize(OUT), "bytes")
