#!/usr/bin/env python3
"""Turns square app icons (tools/logo-src/*.png) into wide 5:3 tile banners.

The icon is placed in the middle and its left/right edge colours are stretched
outwards, so the logo sits on a seamless brand-coloured tile.
Output: rootfs/opt/novatv/web/shared/logos/<name>.png
Usage: python3 tools/make-banners.py   (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "logo-src"
OUT = ROOT / "rootfs" / "opt" / "novatv" / "web" / "shared" / "logos"
W, H = 640, 384

# some App Store artwork has a rounded frame baked in: crop it off (pixels on a 512 icon)
CROP = {"hbomax": 44, "netflix": 44, "spotify": 44, "playtv": 40, "appletv": 44, "arte": 44, "fubo": 44,
        "iplayer": 44, "itvx": 44, "joyn": 44, "npo": 44, "sling": 64, "tubi": 44, "francetv": 48, "canalplus": 48, "molotov": 48}
# icons whose logo touches the edge: use a solid tile in the icon's main colour instead of stretched edges
SOLID = {"playtv"}
# logo size inside the tile (1.0 = icon fills the tile height)
SCALE = {"playtv": 0.8, "vrtmax": 0.92, "youtube": 0.9, "prime": 0.95, "spotify": 0.74, "netflix": 0.92}


def banner(path):
    name = path.stem
    icon = Image.open(path).convert("RGB")
    c = CROP.get(name, 0)
    if c:
        icon = icon.crop((c, c, icon.width - c, icon.height - c))
    size = round(H * SCALE.get(name, 1.0))
    icon = icon.resize((size, size), Image.LANCZOS)

    if name in SOLID:
        # most common darker colour (skips white lettering)
        colors = icon.convert("P", palette=Image.ADAPTIVE, colors=8).convert("RGB").getcolors()
        main = max((c for c in colors if sum(c[1]) < 600), default=max(colors))[1]
        bg = Image.new("RGB", (W, H), main)
        bg.paste(icon, ((W - size) // 2, (H - size) // 2))
        OUT.mkdir(parents=True, exist_ok=True)
        bg.save(OUT / f"{name}.png", optimize=True)
        return name

    # background: the icon's edge columns stretched across the full width, then the icon on top
    left = icon.crop((0, 0, 1, size)).resize((W // 2, size))
    right = icon.crop((size - 1, 0, size, size)).resize((W - W // 2, size))
    bg = Image.new("RGB", (W, size))
    bg.paste(left, (0, 0))
    bg.paste(right, (W // 2, 0))
    if size < H:  # smaller logo: extend the top/bottom rows too
        full = bg.resize((W, H))
        top = bg.crop((0, 0, W, 1)).resize((W, (H - size) // 2 + 1))
        bot = bg.crop((0, size - 1, W, size)).resize((W, H - size - (H - size) // 2 + 1))
        full.paste(top, (0, 0))
        full.paste(bot, (0, (H - size) // 2 + size - 1))
        bg = full.filter(ImageFilter.GaussianBlur(2))
    else:
        bg = bg.filter(ImageFilter.GaussianBlur(2))
    x, y = (W - size) // 2, (H - size) // 2
    # soft horizontal blend so the icon's own edges disappear into the background
    mask = Image.new("L", (size, size), 255)
    fade = max(4, size // 14)
    for i in range(fade):
        v = round(255 * (i + 1) / (fade + 1))
        for xx in (i, size - 1 - i):
            mask.paste(v, (xx, 0, xx + 1, size))
    bg.paste(icon, (x, y), mask)
    OUT.mkdir(parents=True, exist_ok=True)
    bg.save(OUT / f"{name}.png", optimize=True)
    return name


if __name__ == "__main__":
    for p in sorted(SRC.glob("*.png")):
        print("banner:", banner(p))
