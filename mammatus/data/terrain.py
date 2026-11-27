"""Real terrain for the Sky view.

Elevation comes from Terrain Tiles on AWS Open Data (the Mapzen/Tilezen "Joerd" mosaic of USGS 3DEP,
SRTM, GMTED2010, ETOPO1 and national surveys): free, no key, global, Terrarium-encoded image tiles in
Web Mercator. Any tile server with the same encoding works (``MAMMATUS_TERRAIN_URL``).

For a point this builds a *patch*: three nested square height grids centred on the point, each
SIZE x SIZE, covering +-16 km, +-64 km and +-256 km (about 31 m, 125 m and 500 m per texel at 1024),
in the same local frame as the cloud box (x east, y north, kilometres from the point, rows running
north). The browser draws them as a clipmap: fine ground underfoot, whole ranges on the horizon.

Each grid's outer rim is blended into the next coarser grid (and the outermost into a level plain),
so the three meet without a seam and the shader only ever reads one of them.

Tiles and finished patches are cached on disk; terrain does not change, so a point is built once.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import json
import logging
import math
import os
import shutil
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .derive import NotAvailable
from .http import FetchError, get_bytes

log = logging.getLogger("mammatus.terrain")

HALF_KM = (16.0, 64.0, 256.0)      # half-widths of the three nested grids
SIZES = (512, 1024)                # texels per side the browser may ask for
KM_PER_DEG = 111.195               # the same local frame as the cloud box (data/sky.py)
MAGIC = b"MMT1"
BLEND = 0.15                       # share of a grid's half-width blended into the next coarser grid
SUB = 2                            # sub-samples per texel side (a box filter over the source pixels)
MERC_M_PER_PX = 156543.03392804097  # metres per pixel of a 256 px tile at zoom 0, on the equator
MERC_LAT = 85.0511
H_MIN, H_MAX = 0.0, 9000.0         # the sea is level (the source carries the sea floor); nothing tops 9 km

DEFAULT_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
DEFAULT_ATTRIBUTION = "Terrain Tiles on AWS (Mapzen; USGS 3DEP, SRTM, GMTED2010, ETOPO1 and others)"


@dataclass(frozen=True)
class TileSource:
    """A Terrarium-encoded elevation tile server."""

    url: str = DEFAULT_URL
    tile_px: int = 256
    max_zoom: int = 15
    attribution: str = DEFAULT_ATTRIBUTION

    def tile_url(self, z: int, x: int, y: int) -> str:
        return self.url.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))


# --------------------------------------------------------------------------- geometry

def zoom_for(lat: float, texel_m: float, src: TileSource) -> int:
    """The zoom whose pixels are closest in size to ``texel_m`` at this latitude."""
    px0 = MERC_M_PER_PX * max(0.05, math.cos(math.radians(lat))) * 256.0 / src.tile_px
    return int(min(src.max_zoom, max(0, round(math.log2(px0 / texel_m)))))


def level_axes(lat: float, lon: float, half_km: float, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Latitudes (rows, south to north) and longitudes (columns, west to east) of n sample centres."""
    off = ((np.arange(n, dtype=np.float64) + 0.5) / n * 2.0 - 1.0) * half_km
    lats = lat + off / KM_PER_DEG
    lons = lon + off / (KM_PER_DEG * max(0.05, math.cos(math.radians(lat))))
    return lats, lons


def mercator_px(lats, lons, z: int, tile_px: int) -> tuple[np.ndarray, np.ndarray]:
    """Global pixel coordinates (x east, y south) at zoom z; longitudes are not wrapped."""
    n = float(tile_px) * (1 << z)
    x = (np.asarray(lons, dtype=np.float64) + 180.0) / 360.0 * n
    la = np.radians(np.clip(np.asarray(lats, dtype=np.float64), -MERC_LAT, MERC_LAT))
    y = (1.0 - np.arcsinh(np.tan(la)) / math.pi) / 2.0 * n
    return x, y


@dataclass(frozen=True)
class LevelPlan:
    """Which tiles one grid needs, and where its samples fall in their mosaic."""

    z: int
    tx0: int            # first tile column (may be negative or past the antimeridian: wrap when fetching)
    ty0: int
    nx: int
    ny: int
    fx: np.ndarray      # sample positions in mosaic pixel-centre coordinates, per column
    fy: np.ndarray      # ... per row

    def tiles(self) -> list[tuple[int, int, int]]:
        n = 1 << self.z
        return [(self.z, (self.tx0 + i) % n, self.ty0 + j) for j in range(self.ny) for i in range(self.nx)]


def plan_level(lat: float, lon: float, half_km: float, size: int, src: TileSource, sub: int = SUB) -> LevelPlan:
    z = zoom_for(lat, 2000.0 * half_km / size, src)
    lats, lons = level_axes(lat, lon, half_km, size * sub)
    x, y = mercator_px(lats, lons, z, src.tile_px)
    tp, n = src.tile_px, 1 << z
    # bilinear needs the pixel on each side of a sample; pixel centres sit at +0.5
    tx0 = int(math.floor((x.min() - 0.5) / tp))
    tx1 = int(math.floor((x.max() + 0.5) / tp))
    ty0 = max(0, int(math.floor((y.min() - 0.5) / tp)))
    ty1 = min(n - 1, int(math.floor((y.max() + 0.5) / tp)))
    if tx1 - tx0 + 1 > n:          # zoom 0-2 near the poles: the whole world, once
        tx0, tx1 = 0, n - 1
    return LevelPlan(z, tx0, ty0, tx1 - tx0 + 1, ty1 - ty0 + 1, x - tx0 * tp - 0.5, y - ty0 * tp - 0.5)


def _lerp_axis(f: np.ndarray, n: int):
    i0 = np.clip(np.floor(f).astype(np.intp), 0, max(0, n - 2))
    w = np.clip(f - i0, 0.0, 1.0).astype(np.float32)
    return i0, np.minimum(i0 + 1, n - 1), w


def sample_grid(a: np.ndarray, fx: np.ndarray, fy: np.ndarray) -> np.ndarray:
    """Bilinear samples of a[row, col] on the grid fy x fx (pixel-centre coordinates), clamped at the edges."""
    x0, x1, wx = _lerp_axis(fx, a.shape[1])
    y0, y1, wy = _lerp_axis(fy, a.shape[0])
    top = a[np.ix_(y0, x0)] * (1.0 - wx) + a[np.ix_(y0, x1)] * wx
    bot = a[np.ix_(y1, x0)] * (1.0 - wx) + a[np.ix_(y1, x1)] * wx
    return (top * (1.0 - wy)[:, None] + bot * wy[:, None]).astype(np.float32)


def resample(mosaic: np.ndarray, plan: LevelPlan, size: int) -> np.ndarray:
    """One grid from its tile mosaic: bilinear, then a box filter over each texel's sub-samples."""
    s = sample_grid(mosaic, plan.fx, plan.fy)
    sub = len(plan.fx) // size
    return s.reshape(size, sub, size, sub).mean(axis=(1, 3), dtype=np.float32)


# The 7 x 7 border around a texel: everything exactly three texels away.
_RING = [(dj, di) for dj in range(-3, 4) for di in range(-3, 4) if max(abs(dj), abs(di)) == 3]
SUSPECT_MAX_ZOOM = 10      # the tile pyramid's coarse zooms carry a few badly filled voids the finer ones don't
SUSPECT_LIMIT = 96         # at most this many texels are checked per grid (a patch has had up to 44)


def suspects(a: np.ndarray, limit: int = SUSPECT_LIMIT) -> list[tuple[int, int]]:
    """Texels that look like a lone spike or pit: far outside everything three texels away.

    The source's coarse zooms have a few (near Boulder a needle a kilometre high stands on the plain, with
    a 260 m hole beside it; zoom 11 and up show level ground there). A sharp real summit looks the same at
    this resolution, so these are only *suspects*: the caller checks each against a finer zoom.
    """
    h, w = a.shape
    pad = np.pad(a, 3, mode="edge")
    # cheap screen first: far from the mean of the ring (a box sum over 7 x 7 less the 5 x 5 inside it)
    c = np.zeros((h + 7, w + 7), np.float64)
    c[1:, 1:] = pad.cumsum(0, dtype=np.float64).cumsum(1)
    box7 = c[7:, 7:] - c[:-7, 7:] - c[7:, :-7] + c[:-7, :-7]
    box5 = c[6:-1, 6:-1] - c[1:-6, 6:-1] - c[6:-1, 1:-6] + c[1:-6, 1:-6]
    jj, ii = np.nonzero(np.abs(a - (box7 - box5) / len(_RING)) > 150.0)
    if not len(jj):
        return []
    ring = np.stack([pad[jj + 3 + dj, ii + 3 + di] for dj, di in _RING], axis=1)
    q1, med, q3 = np.percentile(ring, [25, 50, 75], axis=1)
    v = a[jj, ii]
    off = np.abs(v - med)
    bad = (off > np.maximum(150.0, 6.0 * (q3 - q1))) & ((v > ring.max(axis=1)) | (v < ring.min(axis=1)))
    order = np.argsort(-np.where(bad, off, -1.0))[: min(limit, int(bad.sum()))]
    return [(int(jj[k]), int(ii[k])) for k in order]


def _smoothstep(a: float, b: float, x):
    t = np.clip((np.asarray(x, dtype=np.float32) - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _rim(size: int, blend: float = BLEND) -> np.ndarray:
    """0 in the middle of a grid rising to exactly 1 on its outermost texels."""
    u = np.abs((np.arange(size, dtype=np.float32) + 0.5) / size * 2.0 - 1.0)
    w = _smoothstep(1.0 - blend, 1.0 - 1.0 / size, u)
    return np.maximum.outer(w, w)


def _from_coarser(coarse: np.ndarray, half_fine: float, half_coarse: float) -> np.ndarray:
    """The coarser grid read (bilinearly, as the GPU will) at the finer grid's texel centres."""
    size = coarse.shape[0]
    off = ((np.arange(size, dtype=np.float64) + 0.5) / size * 2.0 - 1.0) * half_fine
    f = (off + half_coarse) / (2.0 * half_coarse) * size - 0.5
    return sample_grid(coarse, f, f)


def nest(levels: list[np.ndarray], halves=HALF_KM) -> tuple[list[np.ndarray], float]:
    """Blend each grid's rim into the next coarser one, and the outermost into a level plain.

    Returns the grids and the plain's height. After this, reading the finest grid that covers a place
    gives a continuous surface.
    """
    out = [np.clip(a, H_MIN, H_MAX).astype(np.float32) for a in levels]
    last = out[-1]
    ring = np.concatenate([last[0], last[-1], last[1:-1, 0], last[1:-1, -1]])
    base = float(np.median(ring))
    w = _rim(last.shape[0], 0.12)
    out[-1] = last * (1.0 - w) + base * w
    for k in range(len(out) - 2, -1, -1):
        w = _rim(out[k].shape[0])
        out[k] = out[k] * (1.0 - w) + _from_coarser(out[k + 1], halves[k], halves[k + 1]) * w
    return out, base


# --------------------------------------------------------------------------- encoding

def decode_tile(data: bytes, tile_px: int) -> np.ndarray:
    """A Terrarium tile as metres above sea level, float32 [tile_px, tile_px] (row 0 = north)."""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as im:
            rgb = np.asarray(im.convert("RGB"), dtype=np.float32)
    except Exception as exc:  # Pillow raises a zoo of errors on damaged files
        raise ValueError(f"unreadable terrain tile: {exc}") from exc
    if rgb.shape[:2] != (tile_px, tile_px):
        raise ValueError(f"terrain tile is {rgb.shape[1]}x{rgb.shape[0]}, expected {tile_px}")
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def encode_tile(elev: np.ndarray) -> bytes:
    """Metres -> a Terrarium PNG (tests and the demo server)."""
    from PIL import Image

    v = np.clip(np.asarray(elev, dtype=np.float64) + 32768.0, 0, 65535.996)
    rgb = np.stack([np.floor(v / 256.0), np.floor(v % 256.0), np.floor((v - np.floor(v)) * 256.0)], axis=-1).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "PNG")
    return buf.getvalue()


def _residuals(g: np.ndarray) -> bytes:
    """A grid as second differences (west, then south), zigzag-coded and split into low and high byte
    planes: terrain is smooth, so the high plane is nearly all zeros and the low plane small numbers."""
    d = np.diff(np.diff(g, axis=1, prepend=np.int16(0)), axis=0, prepend=np.int16(0)).astype(np.int16)
    z = ((d.astype(np.int32) << 1) ^ (d.astype(np.int32) >> 15)).astype(np.uint16)
    return (z & 255).astype(np.uint8).tobytes() + (z >> 8).astype(np.uint8).tobytes()


def _from_residuals(raw: bytes, off: int, size: int) -> np.ndarray:
    n = size * size
    lo = np.frombuffer(raw, np.uint8, n, off).astype(np.uint16)
    hi = np.frombuffer(raw, np.uint8, n, off + n).astype(np.uint16)
    z = (lo | (hi << 8)).reshape(size, size)
    d = ((z >> 1).astype(np.int16)) ^ -((z & 1).astype(np.int16))
    return np.cumsum(np.cumsum(d, axis=0, dtype=np.int16), axis=1, dtype=np.int16)


def pack(levels: list[np.ndarray], header: dict) -> bytes:
    """Encode a patch for the browser: a JSON header, then each grid as int16 metres (see _residuals)."""
    size = levels[0].shape[0]
    grids = [np.rint(np.clip(a, -500.0, H_MAX)).astype(np.int16) for a in levels]
    c = size // 2
    centre = levels[0][c - 1:c + 1, c - 1:c + 1]
    head = {
        "v": 1, **header, "size": size, "half": list(HALF_KM[:len(levels)]),
        "elev": round(float(centre.mean()), 1),
        "min": int(min(g.min() for g in grids)), "max": int(max(g.max() for g in grids)),
    }
    hjson = json.dumps(head, separators=(",", ":")).encode()
    hjson += b" " * (-len(hjson) % 4)
    raw = b"".join([MAGIC, len(hjson).to_bytes(4, "little"), hjson, *(_residuals(g) for g in grids)])
    return gzip.compress(raw, compresslevel=6, mtime=0)


def unpack(blob: bytes) -> tuple[dict, list[np.ndarray]]:
    raw = gzip.decompress(blob) if blob[:2] == b"\x1f\x8b" else blob
    if raw[:4] != MAGIC:
        raise ValueError("not a terrain patch")
    hlen = int.from_bytes(raw[4:8], "little")
    head = json.loads(raw[8:8 + hlen])
    size, off, out = head["size"], 8 + hlen, []
    for _ in head["half"]:
        out.append(_from_residuals(raw, off, size))
        off += size * size * 2
    return head, out


# --------------------------------------------------------------------------- made-up terrain (demo, tests)

def _hash2(ix: np.ndarray, iy: np.ndarray, seed: int) -> np.ndarray:
    h = (ix.astype(np.uint32) * np.uint32(374761393) + iy.astype(np.uint32) * np.uint32(668265263) + np.uint32(seed * 2246822519 & 0xFFFFFFFF))
    h = (h ^ (h >> np.uint32(13))) * np.uint32(1274126177)
    return ((h ^ (h >> np.uint32(16))) & np.uint32(0xFFFFFF)).astype(np.float32) / np.float32(0xFFFFFF)


def _gnoise(x: np.ndarray, y: np.ndarray, seed: int) -> np.ndarray:
    """Gradient (Perlin) noise, about -0.7..0.7, on the integer lattice of (x, y)."""
    x0, y0 = np.floor(x), np.floor(y)
    fx, fy = (x - x0).astype(np.float32), (y - y0).astype(np.float32)
    ux, uy = fx * fx * fx * (fx * (fx * 6 - 15) + 10), fy * fy * fy * (fy * (fy * 6 - 15) + 10)
    ix, iy = x0.astype(np.int64), y0.astype(np.int64)

    def corner(dx: int, dy: int) -> np.ndarray:
        ang = _hash2(ix + dx, iy + dy, seed) * np.float32(2 * math.pi)
        return np.cos(ang) * (fx - dx) + np.sin(ang) * (fy - dy)

    return (corner(0, 0) + (corner(1, 0) - corner(0, 0)) * ux) * (1 - uy) + (corner(0, 1) + (corner(1, 1) - corner(0, 1)) * ux) * uy


def synth_elevation(lats, lons) -> np.ndarray:
    """A plausible landscape as a function of place: plains, foothills and ranges with ridges and
    valleys. Deterministic, so every grid of a patch (and every patch) agrees on the ground."""
    la, lo = np.meshgrid(np.asarray(lats, dtype=np.float64), np.asarray(lons, dtype=np.float64), indexing="ij")
    x, y = lo * 85.0, la * 111.0                           # roughly km
    ranges = 0.5 + 0.9 * _gnoise(x / 210.0, y / 210.0, 1) + 0.35 * _gnoise(x / 70.0, y / 70.0, 2)
    ranges = np.clip((ranges - 0.3) / 0.5, 0.0, 1.0) ** 1.4       # 0 on the plains .. 1 in the high country
    # bend the ground a little so ridges wander instead of following the noise lattice
    wx = x + 9.0 * _gnoise(x / 31.0, y / 31.0, 3)
    wy = y + 9.0 * _gnoise(x / 31.0, y / 31.0, 4)
    ridged = np.zeros(x.shape, np.float32)
    amp, scale, norm, weight = 1.0, 38.0, 0.0, np.ones(x.shape, np.float32)
    for i in range(8):                                    # ranges 38 km across down to gullies of 300 m
        c, sn = math.cos(0.6 * i + 0.3), math.sin(0.6 * i + 0.3)
        r = 1.0 - np.abs(_gnoise((wx * c - wy * sn) / scale, (wx * sn + wy * c) / scale, 10 + i)) * 1.9
        r = np.clip(r, 0.0, 1.0) ** 2 * weight
        weight = np.clip(r * 1.5, 0.0, 1.0)               # detail gathers on the ridges, valleys stay smooth
        ridged += amp * r
        norm += amp
        amp *= 0.5
        scale /= 2.03
    ridged /= norm
    rolling = 0.5 + _gnoise(x / 11.0, y / 11.0, 30) * 0.7 + _gnoise(x / 2.7, y / 2.7, 31) * 0.3 + _gnoise(x / 0.7, y / 0.7, 32) * 0.1
    return np.maximum(120.0 + 500.0 * ranges + 80.0 * rolling + 3400.0 * ranges * ridged ** 1.3, 0.0).astype(np.float32)


def synth_levels(lat: float, lon: float, size: int) -> list[np.ndarray]:
    return [synth_elevation(*level_axes(lat, lon, h, size)) for h in HALF_KM]


def synth_patch(lat: float, lon: float, size: int = SIZES[0]) -> bytes:
    levels, base = nest(synth_levels(lat, lon, size))
    return pack(levels, {"lat": round(lat, 3), "lon": round(lon, 3), "base": round(base, 1), "zoom": [0, 0, 0],
                         "source": "demo", "attribution": "Synthetic terrain (demo)"})


# --------------------------------------------------------------------------- service

class TerrainService:
    """Builds and caches terrain patches. ``source=None`` turns terrain off."""

    def __init__(self, cache_dir: Path, pool, source: TileSource | None, cap_bytes: int = 1024**3):
        self.root = Path(cache_dir) / "terrain"
        self.pool = pool
        self.source = source
        self.cap = cap_bytes
        self._out: OrderedDict = OrderedDict()
        self._inflight: dict = {}
        self._build = asyncio.Semaphore(2)
        self._fetch = asyncio.Semaphore(12)
        self.stats = {"patches": 0, "tiles_downloaded": 0, "bytes_downloaded": 0, "tile_cache_hits": 0, "spikes_removed": 0}

    @property
    def enabled(self) -> bool:
        return self.source is not None

    # -- public ---------------------------------------------------------------
    async def patch(self, lat: float, lon: float, size: int = SIZES[-1]) -> bytes:
        if self.source is None:
            raise NotAvailable("Terrain is turned off on this server")
        if size not in SIZES:
            raise NotAvailable("Unsupported terrain size")
        lat, lon = round(lat, 3), round(lon, 3)
        key = (lat, lon, size)
        hit = self._out.get(key)
        if hit is not None:
            self._out.move_to_end(key)
            return hit
        path = self._patch_path(lat, lon, size)
        loop = asyncio.get_running_loop()
        blob = await loop.run_in_executor(None, _read_touch, path)
        if blob is None or blob[:2] != b"\x1f\x8b":
            blob = await self._once(key, lambda: self._make(lat, lon, size, path))
        self._out[key] = blob
        self._out.move_to_end(key)
        while len(self._out) > 6:
            self._out.popitem(last=False)
        return blob

    def cleanup(self) -> int:
        """Keep the cache under its cap: least recently used tiles and patches go first."""
        if not self.root.is_dir():
            return 0
        files, removed = [], 0
        for f in self.root.rglob("*"):
            try:
                st = f.stat()
            except OSError:
                continue
            if not f.is_file():
                continue
            if f.name.startswith(".") and time.time() - st.st_mtime > 3600:   # a write that never finished
                f.unlink(missing_ok=True)
                continue
            files.append((st.st_mtime, st.st_size, f))
        total = sum(s for _, s, _ in files)
        for _, size, f in sorted(files, key=lambda x: x[0]):
            if total <= self.cap:
                break
            f.unlink(missing_ok=True)
            total -= size
            removed += size
        return removed

    def clear(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)
        self._out.clear()

    def usage(self) -> int:
        if not self.root.is_dir():
            return 0
        total = 0
        for f in self.root.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                pass
        return total

    # -- building -------------------------------------------------------------
    def _patch_path(self, lat: float, lon: float, size: int) -> Path:
        return self.root / "patch" / f"{lat:+08.3f}_{lon:+09.3f}_{size}.mmt"

    def _tile_path(self, z: int, x: int, y: int) -> Path:
        return self.root / "tiles" / str(z) / str(x) / f"{y}.tile"

    async def _once(self, key, factory):
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(factory())
            self._inflight[key] = task

            def done(t: asyncio.Task, k=key) -> None:
                self._inflight.pop(k, None)
                if not t.cancelled():
                    t.exception()

            task.add_done_callback(done)
        # shield: a client giving up must not cancel work other requests share
        return await asyncio.shield(task)

    async def _make(self, lat: float, lon: float, size: int, path: Path) -> bytes:
        src = self.source
        loop = asyncio.get_running_loop()
        async with self._build:
            t0 = time.time()
            # tiles are picked for the finest size, so both sizes share one set of downloads
            plans = [plan_level(lat, lon, h, SIZES[-1], src) for h in HALF_KM]
            wanted = sorted({t for p in plans for t in p.tiles()})
            got = dict(zip(wanted, await asyncio.gather(*(self._tile(*t) for t in wanted))))

            def grids() -> list[np.ndarray]:
                out = []
                for p in plans:
                    tp, n = src.tile_px, 1 << p.z
                    mosaic = np.empty((p.ny * tp, p.nx * tp), np.float32)
                    for j in range(p.ny):
                        for i in range(p.nx):
                            mosaic[j * tp:(j + 1) * tp, i * tp:(i + 1) * tp] = got[(p.z, (p.tx0 + i) % n, p.ty0 + j)]
                    out.append(resample(mosaic, p, size))
                return out

            levels = await loop.run_in_executor(self.pool, grids)
            fixed = await self._repair(levels, plans, lat, lon)

            def finish() -> bytes:
                nested, base = nest(levels)
                return pack(nested, {"lat": lat, "lon": lon, "base": round(base, 1), "zoom": [p.z for p in plans],
                                     "source": "tiles", "attribution": src.attribution})

            blob = await loop.run_in_executor(self.pool, finish)
            await loop.run_in_executor(None, _write_atomic, path, blob)
            self.stats["patches"] += 1
            self.stats["spikes_removed"] += fixed
            log.info("terrain patch %.3f,%.3f (%d px): %d tiles, %.0f kB, %.1f s%s", lat, lon, size, len(wanted),
                     len(blob) / 1e3, time.time() - t0, f", {fixed} bad texels repaired" if fixed else "")
            return blob

    async def _repair(self, levels: list[np.ndarray], plans: list[LevelPlan], lat: float, lon: float) -> int:
        """Check lone spikes and pits in the middle grid against a finer zoom, and mend the false ones.

        Only the middle grid needs it: the inner one comes from zooms that don't have the fault, and in the
        outer one a spike is averaged away. A summit that the finer zoom confirms is left alone. Trouble
        fetching the check tiles leaves the grid as it was.
        """
        src, k = self.source, 1
        p = plans[k]
        zf = min(src.max_zoom, p.z + 2)
        if p.z > SUSPECT_MAX_ZOOM or zf <= p.z:
            return 0
        loop = asyncio.get_running_loop()
        grid = levels[k]
        size = grid.shape[0]
        found = await loop.run_in_executor(self.pool, suspects, grid)
        if not found:
            return 0
        lats, lons = level_axes(lat, lon, HALF_KM[k], size)
        tp, n = src.tile_px, 1 << zf
        px_m = MERC_M_PER_PX * max(0.05, math.cos(math.radians(lat))) * 256.0 / tp / n
        reach = int(math.ceil(1000.0 * HALF_KM[k] / size / px_m)) + 1      # half a texel in fine pixels, and one more
        spots = []
        for j, i in found:
            x, y = mercator_px([lats[j]], [lons[i]], zf, tp)
            spots.append((j, i, int(x[0] // tp) % n, min(n - 1, max(0, int(y[0] // tp))), int(x[0] % tp), int(y[0] % tp)))
        need = sorted({(zf, tx, ty) for _, _, tx, ty, _, _ in spots})
        try:
            tiles = dict(zip(need, await asyncio.gather(*(self._tile(*t) for t in need))))
        except FetchError as exc:
            log.info("terrain: could not check %d suspect texels (%s)", len(found), exc)
            return 0
        fixed = 0
        for j, i, tx, ty, cx, cy in spots:
            win = np.maximum(tiles[(zf, tx, ty)][max(0, cy - reach):cy + reach + 1, max(0, cx - reach):cx + reach + 1], H_MIN)
            v = float(grid[j, i])
            if v - float(win.max()) > 120.0 or float(win.min()) - v > 120.0:
                grid[j, i] = float(win.mean())
                fixed += 1
        return fixed

    async def _tile(self, z: int, x: int, y: int) -> np.ndarray:
        """One tile as metres, from the disk cache or the network."""
        src = self.source
        path = self._tile_path(z, x, y)
        loop = asyncio.get_running_loop()
        data = await loop.run_in_executor(None, _read_touch, path)
        if data is not None:
            try:
                elev = await loop.run_in_executor(self.pool, decode_tile, data, src.tile_px)
                self.stats["tile_cache_hits"] += 1
                return elev
            except ValueError:
                path.unlink(missing_ok=True)      # damaged on disk: fetch it again
        async with self._fetch:
            data = await get_bytes(src.tile_url(z, x, y), retries=2, timeout=30.0)
        try:
            elev = await loop.run_in_executor(self.pool, decode_tile, data or b"", src.tile_px)
        except ValueError as exc:
            raise FetchError(str(exc)) from exc
        self.stats["tiles_downloaded"] += 1
        self.stats["bytes_downloaded"] += len(data)
        await loop.run_in_executor(None, _write_atomic, path, data)
        return elev


def _read_touch(path: Path) -> bytes | None:
    """Read a cached file and mark it recently used."""
    try:
        data = path.read_bytes()
        os.utime(path, None)
        return data
    except OSError:
        return None


def _write_atomic(path: Path, data: bytes) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except OSError as exc:      # a full or read-only disk must not fail the request
        log.warning("terrain cache write failed: %s", exc)
