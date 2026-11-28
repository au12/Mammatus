"""Global geostationary satellite composites from SSEC RealEarth.

Tiles (EPSG:4326, 256 px) are stitched server-side into one 1024x1024 plate
carree image per time, smoothed along the meridians toward the poles, and
cached as WebP. Terms: non-commercial use with the
attribution "Courtesy of SSEC, University of Wisconsin-Madison".
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import time
from pathlib import Path

from .frames import DiskCache
from .http import FetchError, get_bytes, get_json

log = logging.getLogger("mammatus.sat")

BASE = "https://realearth.ssec.wisc.edu"
ATTRIBUTION = "Courtesy of SSEC, University of Wisconsin-Madison"
PRODUCTS = {
    "globalir": {"name": "Infrared", "desc": "Global infrared composite (cloud-top temperature), day and night."},
    "globalvis": {"name": "Visible", "desc": "Global visible composite (daylight only)."},
    "globalwv": {"name": "Water vapor", "desc": "Global water vapor composite (mid/upper-level moisture)."},
}
# RealEarth's EPSG:4326 pyramid is a square 2^z x 2^z grid of 256 px tiles over the whole globe
# (x wraps past 2^z, so asking for 2^(z+1) columns repeats the world). z=2 is the deepest level
# served without a "zoom limit exceeded" watermark: 1024 x 1024, 0.35 x 0.18 deg pixels.
ZOOM = 2
VERSION = 2  # bump when the stitched image changes; it names the cache file
# smoothing width along a row, in north-south pixels of ground: 1 below 60 deg, 6 by 80 deg (the
# polar fill), 20 by 88 deg so the last few degrees merge into one cap
POLAR_RAMP = ((60.0, 80.0, 5.0), (80.0, 88.0, 14.0))


class SatelliteService:
    def __init__(self, cache: DiskCache, pool):
        self.cache = cache
        self.pool = pool
        self.root = cache.root / "sat"
        self._times: dict[str, tuple[float, list[str]]] = {}
        self._inflight: dict[str, asyncio.Task] = {}

    async def times(self, product: str, count: int = 12) -> list[str]:
        if product not in PRODUCTS:
            raise ValueError("unknown product")
        hit = self._times.get(product)
        if hit and time.time() - hit[0] < 300:
            return hit[1][-count:]
        data = await get_json(f"{BASE}/api/times", params={"products": product})
        stamps = sorted((data or {}).get(product, []))
        self._times[product] = (time.time(), stamps)
        return stamps[-count:]

    def path(self, product: str, stamp: str) -> Path:
        return self.root / product / f"{stamp}.v{VERSION}.webp"

    async def image(self, product: str, stamp: str) -> Path:
        if product not in PRODUCTS or not re.fullmatch(r"\d{8}\.\d{6}", stamp):
            raise ValueError("bad satellite request")
        p = self.path(product, stamp)
        if p.exists():
            return p
        key = f"{product}/{stamp}"
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._build(product, stamp))
            self._inflight[key] = task
            task.add_done_callback(lambda t, k=key: (self._inflight.pop(k, None), t.cancelled() or t.exception()))
        await asyncio.shield(task)
        return p

    async def _build(self, product: str, stamp: str) -> None:
        day, hms = stamp.split(".")
        pid = f"{product}_{day}_{hms}"
        cols = rows = 2 ** ZOOM
        sem = asyncio.Semaphore(4)

        async def tile(x: int, y: int):
            async with sem:
                return x, y, await get_bytes(f"{BASE}/api/image", params={"products": pid, "x": x, "y": y, "z": ZOOM})

        results = await asyncio.gather(*(tile(x, y) for y in range(rows) for x in range(cols)))
        if not any(b for _, _, b in results):
            raise FetchError("no satellite tiles returned", 404)
        loop = asyncio.get_running_loop()
        data = await loop.run_in_executor(self.pool, _stitch, results, cols, rows, product)
        self.cache.write(self.path(product, stamp), data)


def _stitch(results, cols: int, rows: int, product: str) -> bytes:
    import numpy as np
    from PIL import Image

    canvas = Image.new("LA", (cols * 256, rows * 256), (0, 0))
    for x, y, blob in results:
        if not blob:
            continue
        try:
            im = Image.open(io.BytesIO(blob)).convert("LA")
        except Exception:
            continue
        canvas.paste(im, (x * 256, y * 256))
    a = np.asarray(canvas, dtype=np.float32)
    lum, cov = polar_smooth(a[..., 0], a[..., 1])
    v = np.clip(lum + 0.5, 0, 255).astype(np.uint8)
    rgba = np.dstack([v, v, v, np.clip(cov + 0.5, 0, 255).astype(np.uint8)])
    out = io.BytesIO()
    # Store luminance in RGB channels and coverage in alpha; WebP keeps it compact.
    Image.fromarray(rgba, "RGBA").save(out, format="WEBP", quality=82, method=4)
    return out.getvalue()


def _box_wrap(row, radius: float):
    """Circular moving average along one image row (longitude wraps). Fractional radii blend
    the two nearest whole ones, so the width grows smoothly from row to row (no arcs)."""
    r0 = int(radius)
    f = radius - r0
    a = _box_int(row, r0)
    return a if f < 1e-3 else a + (_box_int(row, r0 + 1) - a) * f


def _box_int(row, r: int):
    import numpy as np

    n = row.shape[0]
    if r <= 0:
        return row
    if 2 * r + 1 >= n:
        return np.full_like(row, row.mean())
    ext = np.concatenate([row[-r - 1:], row, row[:r]])
    c = np.cumsum(ext, dtype=np.float64)
    return ((c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)).astype(row.dtype)


def polar_smooth(lum, cov):
    """Even out how a plate carree image converges on the poles.

    Near a pole one pixel of longitude shrinks to a sliver of ground, so any east-west
    texture (and the stretched fill these composites use where geostationary satellites
    can't see) turns into spikes radiating from the pole on the globe. Each row is averaged
    along longitude over a fixed ground width (~1/cos(lat) pixels), widening further over the
    polar fill, so the image meets the pole in one smooth cap. Coverage-weighted, so gaps
    don't darken the clouds around them.
    """
    import numpy as np

    h, w = lum.shape
    aspect = w / (2.0 * h)  # longitude pixels per latitude pixel of ground at the equator
    lat = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    ground = np.ones(h)
    for lo, hi, add in POLAR_RAMP:
        t = np.clip((np.abs(lat) - lo) / (hi - lo), 0.0, 1.0)
        ground += add * t * t * (3.0 - 2.0 * t)
    width = ground * aspect / np.maximum(np.cos(np.radians(lat)), 1e-6)
    pre = lum * cov
    lum, cov = lum.copy(), cov.copy()
    # two box passes ~ a triangle of the full width; starts from zero a little past where a pixel
    # becomes narrower than it is tall, so mid-latitudes stay untouched and nothing switches on abruptly
    radius = np.maximum(width - 1.25, 0.0) / 2.0 / np.sqrt(2.0)
    for j in np.nonzero(radius > 0.0)[0]:
        r = radius[j]
        p, c = pre[j], cov[j]
        for _ in range(2):
            p, c = _box_wrap(p, r), _box_wrap(c, r)
        lum[j] = np.where(c > 1e-3, p / np.maximum(c, 1e-3), lum[j])
        cov[j] = c
    return lum, cov
