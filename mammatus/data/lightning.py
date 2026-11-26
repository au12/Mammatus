"""GOES GLM lightning, ingested on demand.

The Geostationary Lightning Mapper on GOES-East and GOES-West reports every flash it sees in
20-second netCDF files on NOAA's open-data buckets. While someone has the lightning layer on,
Mammatus lists new files every few seconds, keeps only the flash centroids (a few KB out of a
170-360 KB file), merges the two satellites along the longitude midway between them so the
overlap is never counted twice, and serves 10-minute chunks in a compact binary format.

A chunk is *final* once every 20-second file that could hold one of its flashes has been
ingested from every satellite. Final chunks are written to disk and served as immutable, so
browsers fetch each one once; the newest chunk is polled with ``after=`` for just the tail.
Nothing is downloaded when nobody is looking.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .http import FetchError, get_bytes, request

log = logging.getLogger("mammatus.lightning")

UTC = timezone.utc
PRODUCT = "GLM-L2-LCFA"
CHUNK = 600            # seconds per chunk
FILE_SPAN = 20         # seconds per GLM file
LEAD = 4.0             # flashes may begin up to ~3.3 s before the file that reports them
IDLE_AFTER = 900       # stop ingesting this long after the last request
MEMORY = 2 * 3600      # how far back open chunks are kept in memory
HISTORY = 6 * 3600     # how long final chunks stay on disk
MAGIC = b"MML1"
POS_SCALE = 180.0      # int16 units per degree (~600 m, far finer than GLM's ~8 km pixels)
T_SCALE = 100.0        # uint16 units per second within a chunk (10 ms)

SOURCES = {
    # Sub-satellite longitudes: GOES-East 75.2W, GOES-West 137.2W. Older satellites are fallbacks.
    "east": {"label": "GOES-East", "buckets": ("noaa-goes19", "noaa-goes16"), "sublon": -75.2},
    "west": {"label": "GOES-West", "buckets": ("noaa-goes18", "noaa-goes17"), "sublon": -137.2},
}

def _angle(lon: np.ndarray, center: float) -> np.ndarray:
    return np.abs((lon - center + 180.0) % 360.0 - 180.0)


def nearest_satellite_mask(lon: np.ndarray, source: str, others: list[str]) -> np.ndarray:
    """Keep flashes this satellite sees closer to nadir than any other active satellite.

    With East and West both on, that splits the overlap at 106.2W (and the dateline side correctly)."""
    own = _angle(lon, SOURCES[source]["sublon"])
    keep = np.ones(lon.shape, bool)
    for o in others:
        other = _angle(lon, SOURCES[o]["sublon"])
        keep &= (own <= other) if source < o else (own < other)
    return keep

DTYPE = np.dtype([("t", "f8"), ("lat", "f4"), ("lon", "f4"), ("e", "u1")])
_NAME = re.compile(r"OR_GLM-L2-LCFA_G(\d{2})_s(\d{13})(\d)_e(\d{13})(\d)_c\d+\.nc$")


# --------------------------------------------------------------------------- parsing

def parse_name(key: str) -> tuple[float, float] | None:
    """Start and end (epoch seconds) from a GLM file name."""
    m = _NAME.search(key)
    if not m:
        return None

    def ts(digits: str, tenths: str) -> float:
        return datetime.strptime(digits, "%Y%j%H%M%S").replace(tzinfo=UTC).timestamp() + int(tenths) / 10

    return ts(m.group(2), m.group(3)), ts(m.group(4), m.group(5))


def _attr(ds, name):
    v = ds.attrs.get(name)
    if v is None:
        return None
    if isinstance(v, bytes):
        return v.decode()
    if hasattr(v, "shape") and v.shape:
        v = v.reshape(-1)[0]
    return v.decode() if isinstance(v, bytes) else v


def _unpack(ds) -> np.ndarray:
    """Apply netCDF packing conventions (_Unsigned, _FillValue, scale_factor, add_offset)."""
    raw = ds[:]
    fill = _attr(ds, "_FillValue")
    bad = (raw == fill) if fill is not None else np.zeros(raw.shape, bool)
    if str(_attr(ds, "_Unsigned")).lower() == "true" and raw.dtype.kind == "i":
        raw = raw.view(raw.dtype.str.replace("i", "u"))
    out = raw.astype(np.float64)
    sf, ao = _attr(ds, "scale_factor"), _attr(ds, "add_offset")
    if sf is not None:
        out *= float(sf)
    if ao is not None:
        out += float(ao)
    out[bad] = np.nan
    return out


def _reference_time(f, ds) -> float:
    units = str(_attr(ds, "units") or "")
    m = re.search(r"since (\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)", units)
    if m:
        return datetime.fromisoformat(m.group(1).replace(" ", "T")).replace(tzinfo=UTC).timestamp()
    start = str(_attr(f, "time_coverage_start") or "").rstrip("Z")
    return datetime.fromisoformat(start).replace(tzinfo=UTC).timestamp()


def parse_glm(blob: bytes) -> np.ndarray:
    """Flash centroids from one GLM L2 LCFA file as a structured array (t, lat, lon, e)."""
    import h5py

    with h5py.File(io.BytesIO(blob), "r") as f:
        if "flash_lat" not in f or f["flash_lat"].shape[0] == 0:
            return np.zeros(0, DTYPE)
        lat = f["flash_lat"][:].astype(np.float32)
        lon = f["flash_lon"][:].astype(np.float32)
        tds = f["flash_time_offset_of_first_event"]
        t = _reference_time(f, tds) + _unpack(tds)
        energy = _unpack(f["flash_energy"]) if "flash_energy" in f else np.full(lat.shape, 1e-14)
    ok = np.isfinite(lat) & np.isfinite(lon) & np.isfinite(t) & (np.abs(lat) <= 90) & (np.abs(lon) <= 180)
    out = np.zeros(int(ok.sum()), DTYPE)
    out["t"], out["lat"], out["lon"] = t[ok], lat[ok], lon[ok]
    e = np.nan_to_num(energy[ok], nan=1e-15)
    # radiant energy spans ~1e-15..3e-12 J; store log-scaled 0..255
    out["e"] = np.clip((np.log10(np.maximum(e, 1e-16)) + 15.0) / 3.5 * 255.0, 0, 255).astype(np.uint8)
    return out


# --------------------------------------------------------------------------- wire format

def encode_chunk(t0: int, arr: np.ndarray, *, final: bool, latest: float | None, now: float) -> bytes:
    """MML1: magic, uint32 header length, JSON header (padded to 4 bytes), then column arrays:
    uint16 time (10 ms since t0), int16 lat and lon (1/180 degree), uint8 energy."""
    arr = np.sort(arr, order="t") if len(arr) else arr
    header = {"v": 1, "t0": t0, "n": int(len(arr)), "final": final, "latest": latest, "now": round(now, 2),
              "tScale": T_SCALE, "posScale": POS_SCALE}
    h = json.dumps(header, separators=(",", ":")).encode()
    h += b" " * (-len(h) % 4)
    dt = np.clip(np.round((arr["t"] - t0) * T_SCALE), 0, 65535).astype("<u2")
    lat = np.round(arr["lat"].astype(np.float64) * POS_SCALE).astype("<i2")
    lon = np.round(arr["lon"].astype(np.float64) * POS_SCALE).astype("<i2")
    return b"".join([MAGIC, len(h).to_bytes(4, "little"), h, dt.tobytes(), lat.tobytes(), lon.tobytes(),
                     arr["e"].astype("u1").tobytes()])


def decode_chunk(blob: bytes) -> tuple[dict, np.ndarray]:
    raw = gzip.decompress(blob) if blob[:2] == b"\x1f\x8b" else blob
    if raw[:4] != MAGIC:
        raise ValueError("not a lightning chunk")
    hlen = int.from_bytes(raw[4:8], "little")
    header = json.loads(raw[8:8 + hlen])
    n, off = header["n"], 8 + hlen
    dt = np.frombuffer(raw, "<u2", n, off)
    lat = np.frombuffer(raw, "<i2", n, off + 2 * n)
    lon = np.frombuffer(raw, "<i2", n, off + 4 * n)
    e = np.frombuffer(raw, "u1", n, off + 6 * n)
    out = np.zeros(n, DTYPE)
    out["t"] = header["t0"] + dt / header["tScale"]
    out["lat"], out["lon"], out["e"] = lat / header["posScale"], lon / header["posScale"], e
    return header, out


# --------------------------------------------------------------------------- coverage bookkeeping

def add_interval(intervals: list[list[float]], start: float, end: float, slack: float = 1.0) -> None:
    """Insert [start, end] into a sorted list of disjoint intervals, merging neighbours."""
    intervals.append([start, end])
    intervals.sort()
    merged: list[list[float]] = []
    for s, e in intervals:
        if merged and s <= merged[-1][1] + slack:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    intervals[:] = merged


def covers(intervals: list[list[float]], start: float, end: float) -> bool:
    return any(s <= start and e >= end for s, e in intervals)


@dataclass
class _Source:
    id: str
    label: str
    buckets: tuple[str, ...]
    bucket: str | None = None
    resolved_at: float = 0.0
    files: dict[str, tuple[float, float]] = field(default_factory=dict)
    done: set[str] = field(default_factory=set)
    attempts: dict[str, int] = field(default_factory=dict)
    coverage: list[list[float]] = field(default_factory=list)
    last_key: dict[str, str] = field(default_factory=dict)
    listed: set[str] = field(default_factory=set)   # hourly prefixes listed at least once
    closed: set[str] = field(default_factory=set)   # ... listed after the hour ended (nothing new can appear)
    error: str | None = None

    @property
    def satellite(self) -> str:
        return f"GOES-{int(self.bucket.split('goes')[-1])}" if self.bucket else ""


@dataclass
class _Chunk:
    t0: int
    parts: list[np.ndarray] = field(default_factory=list)
    version: int = 0
    merged: tuple[int, np.ndarray] | None = None

    def array(self) -> np.ndarray:
        if self.merged and self.merged[0] == self.version:
            return self.merged[1]
        arr = np.sort(np.concatenate(self.parts), order="t") if self.parts else np.zeros(0, DTYPE)
        self.merged = (self.version, arr)
        return arr


# --------------------------------------------------------------------------- service

class LightningService:
    def __init__(self, cache_root: Path, pool, sources: tuple[str, ...] = ("east", "west"), backfill_min: int = 30):
        self.root = cache_root / "lightning"
        self.pool = pool
        self.sources = [_Source(id=s, label=SOURCES[s]["label"], buckets=SOURCES[s]["buckets"])
                        for s in sources if s in SOURCES]
        self.enabled = bool(self.sources)
        self.backfill = max(10, backfill_min) * 60
        self.chunks: dict[int, _Chunk] = {}
        self.final: set[int] = set()
        self.wanted: set[int] = set()   # older chunks a viewer asked for (radar loops): fetched on demand
        self.last_viewed = 0.0
        self.session = 0.0          # when the current ingest session started (0 = idle)
        self.stats = {"files": 0, "bytes": 0, "flashes": 0, "errors": 0}
        self._inflight: set[tuple[str, str]] = set()
        self._dl = asyncio.Semaphore(6)
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._scan_disk()

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self.enabled and self._task is None:
            self._task = asyncio.create_task(self._run(), name="lightning-ingest")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    def touch(self) -> None:
        self.last_viewed = time.time()
        if not self.session:
            self._wake.set()

    async def _run(self) -> None:
        while True:
            try:
                if time.time() - self.last_viewed > IDLE_AFTER:
                    if self.session:
                        log.info("lightning: idle, pausing ingest")
                        self.session = 0.0
                    self._wake.clear()
                    await self._wake.wait()
                    continue
                first = not self.session
                if first:
                    self.session = time.time()
                    log.info("lightning: viewer active, ingesting %s", ", ".join(s.id for s in self.sources))
                await self._tick(first)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.stats["errors"] += 1
                log.exception("lightning ingest tick failed")
            await asyncio.sleep(8)

    # ------------------------------------------------------------------ ingest
    async def _tick(self, first: bool) -> None:
        now = time.time()
        live_since = (int(now - self.backfill) // CHUNK) * CHUNK if first else now - 240
        self.wanted = {t for t in self.wanted if t not in self.final and t >= now - MEMORY}
        # the live edge, plus any older chunk someone stepped back to
        ranges = [(live_since, now + 60)] + [(t0 - FILE_SPAN, t0 + CHUNK + FILE_SPAN) for t0 in self.wanted]
        todo: list[tuple[float, _Source, str, float]] = []
        for src in self.sources:
            try:
                await self._resolve(src)
                if not src.bucket:
                    continue
                await self._list(src, ranges)
                for key, (s, e) in src.files.items():
                    if key in src.done or (src.id, key) in self._inflight:
                        continue
                    if not any(a - 1 <= s < b for a, b in ranges):
                        continue
                    if (int(s // CHUNK) * CHUNK) in self.final and (int((s - LEAD) // CHUNK) * CHUNK) in self.final:
                        src.done.add(key)
                        continue
                    todo.append((s, src, key, e))
                src.error = None
            except FetchError as exc:
                src.error = str(exc)
                log.warning("lightning: listing %s failed: %s", src.id, exc)
        todo.sort(key=lambda x: -x[0])  # newest first, so the live edge is ready before history
        if todo:
            await asyncio.gather(*(self._ingest(src, key, s, e) for s, src, key, e in todo))
        self._finalize()
        self._expire()

    async def _resolve(self, src: _Source) -> None:
        """Pick the bucket of the satellite currently in this slot (GOES-19 for East, ...)."""
        if src.bucket and time.time() - src.resolved_at < 6 * 3600:
            return
        now = datetime.now(UTC)
        for bucket in src.buckets:
            for hours_back in (0, 1):
                t = datetime.fromtimestamp(now.timestamp() - hours_back * 3600, UTC)
                prefix = f"{PRODUCT}/{t:%Y/%j/%H}/"
                try:
                    resp = await request("GET", f"https://{bucket}.s3.amazonaws.com/",
                                         params={"list-type": "2", "prefix": prefix, "max-keys": "5"}, retries=1)
                except FetchError:
                    continue
                if b"<Key>" in resp.content:
                    if src.bucket != bucket:
                        log.info("lightning: %s uses %s", src.id, bucket)
                    src.bucket, src.resolved_at = bucket, time.time()
                    return
        src.error = "no recent GLM files found"

    async def _list(self, src: _Source, ranges: list[tuple[float, float]]) -> None:
        """List every hourly prefix touching ``ranges``: fully the first time, then only newer keys."""
        hours: set[int] = set()
        for a, b in ranges:
            h = int(a // 3600) * 3600
            while h <= b:
                hours.add(h)
                h += 3600
        for hour in sorted(hours):
            prefix = f"{PRODUCT}/{datetime.fromtimestamp(hour, UTC):%Y/%j/%H}/"
            if prefix in src.closed:
                continue
            params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
            if prefix in src.listed and src.last_key.get(prefix):
                params["start-after"] = src.last_key[prefix]
            resp = await request("GET", f"https://{src.bucket}.s3.amazonaws.com/", params=params, retries=2)
            for key in re.findall(rb"<Key>([^<]+)</Key>", resp.content):
                k = key.decode()
                span = parse_name(k)
                if span:
                    src.files[k] = span
                    if k > src.last_key.get(prefix, ""):
                        src.last_key[prefix] = k
            src.listed.add(prefix)
            if hour + 3600 + 120 < time.time():
                src.closed.add(prefix)

    async def _ingest(self, src: _Source, key: str, start: float, end: float) -> None:
        tag = (src.id, key)
        self._inflight.add(tag)
        try:
            async with self._dl:
                try:
                    blob = await get_bytes(f"https://{src.bucket}.s3.amazonaws.com/{key}", ok404=True, retries=2)
                except FetchError as exc:
                    n = src.attempts[key] = src.attempts.get(key, 0) + 1
                    if n >= 3:
                        log.warning("lightning: giving up on %s: %s", key, exc)
                        src.done.add(key)
                    return
            if blob is None:  # vanished; do not wait for it
                src.done.add(key)
                return
            loop = asyncio.get_running_loop()
            try:
                arr = await loop.run_in_executor(self.pool, parse_glm, blob)
            except Exception as exc:
                log.warning("lightning: cannot read %s: %s", key, exc)
                src.done.add(key)
                return
            others = [o.id for o in self.sources if o is not src and o.bucket]
            if others and len(arr):
                arr = arr[nearest_satellite_mask(arr["lon"].astype(np.float64), src.id, others)]
            self._add(arr)
            src.done.add(key)
            add_interval(src.coverage, start, end)
            self.stats["files"] += 1
            self.stats["bytes"] += len(blob)
            self.stats["flashes"] += int(len(arr))
        finally:
            self._inflight.discard(tag)

    def _add(self, arr: np.ndarray) -> None:
        if not len(arr):
            return
        keys = (arr["t"] // CHUNK).astype(np.int64) * CHUNK
        for t0 in np.unique(keys):
            t0 = int(t0)
            if t0 in self.final:
                continue
            ch = self.chunks.setdefault(t0, _Chunk(t0))
            ch.parts.append(arr[keys == t0])
            ch.version += 1

    # ------------------------------------------------------------------ chunks
    def _complete(self, t0: int) -> bool:
        active = [s for s in self.sources if s.bucket]
        return bool(active) and all(covers(s.coverage, t0, t0 + CHUNK + FILE_SPAN) for s in active)

    def _finalize(self) -> None:
        """Write every complete chunk to disk, including complete chunks that had no flashes."""
        now = time.time()
        window = range(int((now - MEMORY) // CHUNK) * CHUNK, int(now // CHUNK) * CHUNK, CHUNK)
        for t0 in sorted(set(self.chunks) | set(window)):
            if t0 in self.final or not self._complete(t0):
                continue
            ch = self.chunks.pop(t0, None)
            arr = ch.array() if ch else np.zeros(0, DTYPE)
            blob = gzip.compress(encode_chunk(t0, arr, final=True, latest=None, now=now), compresslevel=6, mtime=0)
            path = self._path(t0)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(blob)
            tmp.replace(path)
            self.final.add(t0)

    def _expire(self) -> None:
        now = time.time()
        for t0 in [t for t in self.chunks if t + CHUNK < now - MEMORY]:
            del self.chunks[t0]
        for src in self.sources:
            old = [k for k, (s, _) in src.files.items() if s < now - MEMORY - 600]
            for k in old:
                src.files.pop(k, None)
                src.done.discard(k)
                src.attempts.pop(k, None)
            src.coverage[:] = [[s, e] for s, e in src.coverage if e > now - MEMORY - 1200]
            stale = f"{PRODUCT}/{datetime.fromtimestamp(now - MEMORY - 3600, UTC):%Y/%j/%H}/"
            for p in [p for p in src.last_key if p < stale]:
                src.last_key.pop(p, None)
            src.listed = {p for p in src.listed if p >= stale}
            src.closed = {p for p in src.closed if p >= stale}
        for t0 in [t for t in self.final if t + CHUNK < now - HISTORY]:
            self.final.discard(t0)
            self._path(t0).unlink(missing_ok=True)

    def _path(self, t0: int) -> Path:
        return self.root / f"{datetime.fromtimestamp(t0, UTC):%Y%m%d}" / f"{t0}.mml.gz"

    def _scan_disk(self) -> None:
        if not self.root.is_dir():
            return
        cutoff = time.time() - HISTORY
        for path in self.root.rglob("*.mml.gz"):
            try:
                t0 = int(path.name.split(".")[0])
            except ValueError:
                continue
            if t0 >= cutoff:
                self.final.add(t0)
            else:
                path.unlink(missing_ok=True)

    # ------------------------------------------------------------------ queries
    def latest(self) -> float | None:
        """Time up to which every active satellite has been ingested (the live edge)."""
        now = time.time()
        ends = []
        for s in self.sources:
            if not s.bucket:
                continue
            recent = [e for _, e in s.coverage if e > now - 900]
            if not recent:
                return None
            ends.append(max(recent))
        return min(ends) if ends else None

    def status(self) -> dict:
        self.touch()
        now = time.time()
        starts = list(self.final) + list(self.chunks)
        return {
            "enabled": self.enabled,
            "now": round(now, 2),
            "latest": self.latest(),
            "start": min(starts) if starts else None,
            "chunk": CHUNK,
            "ingesting": bool(self.session),
            "warming": bool(self.session) and time.time() - self.session < 60,
            "sources": [{"id": s.id, "label": s.label, "satellite": s.satellite, "ok": bool(s.bucket) and not s.error}
                        for s in self.sources],
        }

    def chunk(self, t0: int, after: float | None = None) -> tuple[bytes, bool]:
        """Gzipped MML1 bytes for the chunk starting at ``t0`` and whether it is final."""
        if t0 % CHUNK:
            raise ValueError("chunk start must be a multiple of 600 s")
        self.touch()
        now = time.time()
        if t0 in self.final:
            path = self._path(t0)
            if path.exists():
                return path.read_bytes(), True
            self.final.discard(t0)
        if t0 + CHUNK < now and t0 >= now - MEMORY and not self._complete(t0) and t0 not in self.wanted:
            self.wanted.add(t0)  # history we have not ingested yet: fetch it, the client re-polls
            self._wake.set()
        ch = self.chunks.get(t0)
        arr = ch.array() if ch else np.zeros(0, DTYPE)
        if after is not None and len(arr):
            arr = arr[arr["t"] > after]
        body = encode_chunk(t0, arr, final=False, latest=self.latest(), now=now)
        return gzip.compress(body, compresslevel=4, mtime=0), False
