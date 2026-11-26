"""Global geostationary satellite composites from SSEC RealEarth.

Tiles (EPSG:4326, 256 px) are stitched server-side into one 2048x1024 plate
carree image per time and cached as WebP. Terms: non-commercial use with the
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
ZOOM = 2  # 8 x 4 tiles of 256 px = 2048 x 1024, the composite's native size


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
        return self.root / product / f"{stamp}.webp"

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
        cols, rows = 2 ** (ZOOM + 1), 2 ** ZOOM
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
    out = io.BytesIO()
    # Store luminance in RGB channels and coverage in alpha; WebP keeps it compact.
    canvas.convert("RGBA").save(out, format="WEBP", quality=82, method=4)
    return out.getvalue()
