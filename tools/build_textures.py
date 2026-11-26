"""Prepare globe textures (NASA Blue Marble / Black Marble, public domain).

Outputs to mammatus/static/img/:
  earth-day-4k.jpg / earth-day-2k.jpg      true-color day side
  earth-night-4k.jpg / earth-night-2k.jpg  city lights (grayscale, tinted in the shader)
  earth-terrain.jpg                        R = water mask, G = elevation (2048x1024)
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
SRC = HERE / "sources"
OUT = HERE.parent / "mammatus" / "static" / "img"
OUT.mkdir(parents=True, exist_ok=True)


def save_jpeg(im: Image.Image, name: str, quality: int) -> None:
    im.save(OUT / name, "JPEG", quality=quality, optimize=True, progressive=True, subsampling=2)
    print(name, im.size, (OUT / name).stat().st_size // 1024, "KB")


day = Image.open(SRC / "earth-blue-marble.jpg").convert("RGB")
save_jpeg(day, "earth-day-4k.jpg", 82)
save_jpeg(day.resize((2048, 1024), Image.LANCZOS), "earth-day-2k.jpg", 82)

night = np.asarray(Image.open(SRC / "earth-night.jpg").convert("L")).astype(np.float32)
# remove the moonlit land base so only city lights remain, then stretch
night = np.clip((night - 52.0) / (126.0 - 52.0), 0, 1) ** 1.25 * 255.0
night_im = Image.fromarray(night.astype(np.uint8), "L")
save_jpeg(night_im, "earth-night-4k.jpg", 80)
save_jpeg(night_im.resize((2048, 1024), Image.LANCZOS), "earth-night-2k.jpg", 80)

water = Image.open(SRC / "earth-water.png").convert("L").resize((2048, 1024), Image.LANCZOS)
water = water.filter(ImageFilter.GaussianBlur(0.6))
elev = Image.open(SRC / "earth-topology.png").convert("L").resize((2048, 1024), Image.LANCZOS)
zero = Image.new("L", water.size, 0)
terrain = Image.merge("RGB", (water, elev, zero))
save_jpeg(terrain, "earth-terrain.jpg", 88)
