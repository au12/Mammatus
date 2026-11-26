"""MRMS composite reflectivity: list recent scans, decode, downsample, cache.

The native 0.01-degree CONUS grid (7000x3500) is reduced to 0.02 degrees with
a max filter so storm cores survive, then encoded like model frames.
"""

from __future__ import annotations

import asyncio
import gzip
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from .frames import DiskCache, _ECCODES_LOCK, downsample, encode, lod_grid, quantize
from .grib import register_grid
from .http import FetchError, get_bytes, list_s3

log = logging.getLogger("mammatus.radar")

BUCKET = "https://noaa-mrms-pds.s3.amazonaws.com"
PRODUCT = "MergedReflectivityQCComposite_00.50"
SCALE, OFFSET = 0.5, -40.0
UTC = timezone.utc


class RadarService:
    def __init__(self, cache: DiskCache, pool):
        self.cache = cache
        self.pool = pool
        self.root = cache.root / "radar"
        self._times: list[str] = []
        self._times_at = 0.0
        self._lock = asyncio.Lock()
        self._inflight: dict[str, asyncio.Task] = {}
        self.last_viewed = 0.0
        self._task: asyncio.Task | None = None

    async def times(self, hours: float = 2.0, spacing_min: float = 4.0) -> list[str]:
        """Recent scan times (YYYYMMDD-HHMMSS), thinned to about one per ``spacing_min``."""
        self.last_viewed = time.time()
        async with self._lock:
            if time.time() - self._times_at < 90 and self._times:
                return self._thin(self._times, hours, spacing_min)
            now = datetime.now(UTC)
            start = now - timedelta(hours=max(hours, 2.0) + 0.25)
            keys: list[tuple[str, int]] = []
            days = sorted({start.strftime("%Y%m%d"), now.strftime("%Y%m%d")})
            for day in days:
                prefix = f"CONUS/{PRODUCT}/{day}/"
                after = f"{prefix}MRMS_{PRODUCT}_{start:%Y%m%d-%H%M%S}.grib2.gz" if day == start.strftime("%Y%m%d") else None
                try:
                    listed = await list_s3(BUCKET, prefix, max_pages=2) if not after else await _list_after(prefix, after)
                except FetchError as exc:
                    log.warning("MRMS listing failed: %s", exc)
                    listed = []
                keys.extend(listed)
            stamps = []
            for key, size in keys:
                m = re.search(r"_(\d{8}-\d{6})\.grib2\.gz$", key)
                if m and size > 1000:
                    stamps.append(m.group(1))
            stamps.sort()
            if stamps:
                self._times = stamps
                self._times_at = time.time()
            return self._thin(self._times, hours, spacing_min)

    @staticmethod
    def _thin(stamps: list[str], hours: float, spacing_min: float) -> list[str]:
        if not stamps:
            return []
        latest = datetime.strptime(stamps[-1], "%Y%m%d-%H%M%S")
        cutoff = latest - timedelta(hours=hours)
        out: list[str] = []
        last_t = None
        for s in reversed(stamps):
            t = datetime.strptime(s, "%Y%m%d-%H%M%S")
            if t < cutoff:
                break
            if last_t is None or (last_t - t).total_seconds() >= spacing_min * 60 - 30:
                out.append(s)
                last_t = t
        return list(reversed(out))

    def path(self, stamp: str, lod: int) -> Path:
        return self.root / stamp[:8] / f"{stamp}.{lod}.mmf"

    async def frame(self, stamp: str, lod: int) -> Path:
        if not re.fullmatch(r"\d{8}-\d{6}", stamp):
            raise ValueError("bad radar time")
        self.last_viewed = time.time()
        p = self.path(stamp, lod)
        if p.exists():
            return p
        task = self._inflight.get(stamp)
        if task is None:
            task = asyncio.create_task(self._build(stamp))
            self._inflight[stamp] = task
            task.add_done_callback(lambda t, s=stamp: (self._inflight.pop(s, None), t.cancelled() or t.exception()))
        await asyncio.shield(task)
        return p

    async def _build(self, stamp: str) -> None:
        day = stamp[:8]
        url = f"{BUCKET}/CONUS/{PRODUCT}/{day}/MRMS_{PRODUCT}_{stamp}.grib2.gz"
        blob = await get_bytes(url)
        if not blob:
            raise FetchError("radar scan not found", 404)
        loop = asyncio.get_running_loop()
        lods = await loop.run_in_executor(self.pool, _process, blob, stamp)
        for lod in (2, 1, 0):
            self.cache.write(self.path(stamp, lod), lods[lod])

    async def warm_loop(self) -> None:
        """Keep the latest scans decoded while someone has looked at radar recently."""
        while True:
            await asyncio.sleep(120)
            if time.time() - self.last_viewed > 900:
                continue
            try:
                stamps = await self.times()
                for s in stamps[-3:]:
                    if not self.path(s, 0).exists():
                        await self.frame(s, 0)
            except Exception as exc:
                log.debug("radar warm failed: %s", exc)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self.warm_loop(), name="radar-warm")


async def _list_after(prefix: str, after: str) -> list[tuple[str, int]]:
    from .http import request
    import xml.etree.ElementTree as ET

    out = []
    params = {"list-type": "2", "prefix": prefix, "start-after": after, "max-keys": "1000"}
    resp = await request("GET", BUCKET + "/", params=params)
    root = ET.fromstring(resp.content)
    for el in root.iter():
        if el.tag.endswith("Contents"):
            key = size = None
            for c in el:
                if c.tag.endswith("Key"):
                    key = c.text
                elif c.tag.endswith("Size"):
                    size = int(c.text or 0)
            if key:
                out.append((key, size or 0))
    return out


def _process(blob: bytes, stamp: str) -> tuple[bytes, bytes, bytes]:
    import eccodes

    raw = gzip.decompress(blob)
    with _ECCODES_LOCK:
        h = eccodes.codes_new_from_message(raw)
        try:
            ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
            spec = {
                "type": "latlon", "ni": ni, "nj": nj,
                "la1": eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees"),
                "lo1": eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees"),
                "dlon": eccodes.codes_get(h, "iDirectionIncrementInDegrees"),
                "dlat": -eccodes.codes_get(h, "jDirectionIncrementInDegrees")
                if not eccodes.codes_get(h, "jScansPositively") else eccodes.codes_get(h, "jDirectionIncrementInDegrees"),
            }
            try:
                vals = eccodes.codes_get_values(h).astype(np.float32)
            except TypeError:
                vals = eccodes.codes_get_values(h).astype(np.float32)
        finally:
            eccodes.codes_release(h)
    vals = vals.reshape(nj, ni)
    vals[vals <= -998] = np.nan
    np.maximum(vals, -30.0, out=vals, where=np.isfinite(vals))
    grid = register_grid(spec)
    base = grid.client()
    small = downsample(vals, "max")
    del vals
    g0 = lod_grid(base, 2, 0.5)
    valid = datetime.strptime(stamp, "%Y%m%d-%H%M%S").strftime("%Y-%m-%dT%H:%M:%SZ")
    header = {
        "v": 1, "model": "mrms", "run": stamp, "fhr": 0, "valid": valid, "var": "mrms",
        "kind": "scalar", "comps": 1, "scale": SCALE, "offset": OFFSET, "units": "dBZ",
        "src": "NOAA/NSSL MRMS", "lod": 0,
    }
    out = []
    grids = [g0, lod_grid(g0, 2, 0.5), lod_grid(lod_grid(g0, 2, 0.5), 2, 0.5)]
    arr = small
    for lod in range(3):
        if lod > 0:
            arr = downsample(arr, "max")
        h_, w_ = arr.shape
        finite = arr[np.isfinite(arr)]
        hdr = dict(header, w=w_, h=h_, lod=lod, grid=dict(grids[lod], id=f"mrms{lod}"),
                   min=float(finite.min()) if finite.size else 0.0, max=float(finite.max()) if finite.size else 0.0)
        out.append(encode(hdr, [quantize(arr, SCALE, OFFSET)]))
    return tuple(out)
