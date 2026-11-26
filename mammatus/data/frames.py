"""Frame computation, compact encoding and on-disk caching.

A frame is one variable for one (model, run, hour), quantized to uint16 and
stored delta+zigzag encoded with byte planes split, then gzipped. That packs
smooth fields to roughly a third of their raw size and lets the browser decode
with a tight loop. A half-resolution copy (LOD 1) is stored alongside so small
screens download about a quarter of the bytes.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import math
import os
import shutil
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from .catalog import DEFAULT_PRODUCT, REF_SELECTOR, VARS, Var
from .derive import NotAvailable, Result
from .grib import (
    E, Decoded, Grid, Record, W, decode_message, interval_records, parse_ecmwf_index,
    parse_wgrib_idx, register_grid, select,
)
from .http import FetchError, fetch_ranges, get_text
from .models import REGISTRY, Model, parse_run

log = logging.getLogger("mammatus.frames")

MAGIC = b"MMF1"
_ECCODES_LOCK = threading.Lock()
_PARALLEL_DECODE = os.environ.get("MAMMATUS_PARALLEL_DECODE", "0") == "1"


# --------------------------------------------------------------------------- codec

def quantize(arr: np.ndarray, scale: float, offset: float) -> np.ndarray:
    q = np.rint((arr.astype(np.float64) - offset) / scale) + 1.0
    q = np.clip(q, 1, 65535)
    q[~np.isfinite(arr)] = 0
    return q.astype(np.uint16)


def _transform(q: np.ndarray) -> bytes:
    a = q.astype(np.int32)
    d = np.empty_like(a)
    d[:, 1:] = a[:, 1:] - a[:, :-1]
    first = a[:, 0]
    d[:, 0] = first - np.concatenate(([0], first[:-1]))
    d16 = (d & 0xFFFF).astype(np.uint16).view(np.int16).astype(np.int32)
    z = ((d16 << 1) ^ (d16 >> 15)) & 0xFFFF
    b = z.astype("<u2").view(np.uint8).reshape(-1, 2)
    return b[:, 0].tobytes() + b[:, 1].tobytes()


def _untransform(buf: bytes, h: int, w: int) -> np.ndarray:
    n = h * w
    raw = np.frombuffer(buf, dtype=np.uint8, count=2 * n)
    z = raw[:n].astype(np.int32) | (raw[n:].astype(np.int32) << 8)
    d = (z >> 1) ^ -(z & 1)
    d = d.reshape(h, w)
    first = np.cumsum(d[:, 0]) & 0xFFFF
    d[:, 0] = first
    return (np.cumsum(d, axis=1) & 0xFFFF).astype(np.uint16)


def encode(header: dict, comps: list[np.ndarray]) -> bytes:
    hjson = json.dumps(header, separators=(",", ":")).encode("utf-8")
    hjson += b" " * (-len(hjson) % 4)
    parts = [MAGIC, len(hjson).to_bytes(4, "little"), hjson]
    for q in comps:
        parts.append(_transform(q))
    return gzip.compress(b"".join(parts), compresslevel=6, mtime=0)


def decode(blob: bytes) -> tuple[dict, list[np.ndarray]]:
    raw = gzip.decompress(blob) if blob[:2] == b"\x1f\x8b" else blob
    if raw[:4] != MAGIC:
        raise ValueError("not a frame")
    hlen = int.from_bytes(raw[4:8], "little")
    header = json.loads(raw[8:8 + hlen])
    h, w = header["h"], header["w"]
    off = 8 + hlen
    comps = []
    for _ in range(header["comps"]):
        comps.append(_untransform(raw[off:off + 2 * h * w], h, w))
        off += 2 * h * w
    return header, comps


def dequantize(q: np.ndarray, scale: float, offset: float) -> np.ndarray:
    out = (q.astype(np.float32) - 1.0) * scale + offset
    out[q == 0] = np.nan
    return out


def downsample(arr: np.ndarray, mode: str) -> np.ndarray:
    h, w = arr.shape
    h2, w2 = (h + 1) // 2, (w + 1) // 2
    if mode == "nearest":
        return arr[0::2, 0::2]
    pad = np.pad(arr, ((0, h2 * 2 - h), (0, w2 * 2 - w)), mode="edge")
    blocks = pad.reshape(h2, 2, w2, 2)
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            if mode == "max":
                return np.nanmax(blocks, axis=(1, 3)).astype(np.float32)
            return np.nanmean(blocks, axis=(1, 3)).astype(np.float32)


def downsample_ptype(arr: np.ndarray) -> np.ndarray:
    h, w = arr.shape
    h2, w2 = (h + 1) // 2, (w + 1) // 2
    pad = np.pad(np.nan_to_num(arr), ((0, h2 * 2 - h), (0, w2 * 2 - w)), mode="edge")
    blocks = pad.reshape(h2, 2, w2, 2).transpose(0, 2, 1, 3).reshape(h2, w2, 4)
    rate = np.mod(blocks, 4096)
    idx = np.argmax(rate, axis=2)
    return np.take_along_axis(blocks, idx[..., None], axis=2)[..., 0].astype(np.float32)


def lod_grid(spec: dict, factor: int, shift: float) -> dict:
    s = dict(spec)
    s["ni"] = math.ceil(spec["ni"] / factor)
    s["nj"] = math.ceil(spec["nj"] / factor)
    if spec["type"] == "latlon":
        s["la1"] = spec["la1"] + spec["dlat"] * shift
        s["lo1"] = spec["lo1"] + spec["dlon"] * shift
        s["dlat"] = spec["dlat"] * factor
        s["dlon"] = spec["dlon"] * factor
        s["wrap"] = abs(abs(s["dlon"]) * s["ni"] - 360.0) < 1e-6
    else:
        s["x1"] = spec["x1"] + spec["dx"] * shift
        s["y1"] = spec["y1"] + spec["dy"] * shift * (1 if spec.get("jpos", 1) else -1)
        s["dx"] = spec["dx"] * factor
        s["dy"] = spec["dy"] * factor
    return s


# --------------------------------------------------------------------------- disk cache

class DiskCache:
    def __init__(self, root: Path, cap_bytes: int):
        self.root = root
        self.cap = cap_bytes
        self.total = 0
        root.mkdir(parents=True, exist_ok=True)

    def scan(self) -> int:
        total = 0
        for dirpath, _, files in os.walk(self.root):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, f))
                except OSError:
                    pass
        self.total = total
        return total

    def write(self, path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        self.total += len(data)

    def run_dirs(self) -> list[tuple[float, Path]]:
        out = []
        frames = self.root / "frames"
        if not frames.is_dir():
            return out
        for model_dir in frames.iterdir():
            if not model_dir.is_dir():
                continue
            for run_dir in model_dir.iterdir():
                if run_dir.is_dir() and run_dir.name.isdigit():
                    out.append((run_dir.stat().st_mtime, run_dir))
        return out

    def cleanup(self, protected: set[Path], retention_hours: int) -> int:
        """Delete expired runs, then oldest runs until under the size cap."""
        removed = 0
        now = time.time()
        runs = sorted(self.run_dirs())
        for mtime, path in runs:
            try:
                run_time = datetime.strptime(path.name, "%Y%m%d%H").timestamp()
            except ValueError:
                continue
            if path in protected:
                continue
            if now - run_time > retention_hours * 3600:
                removed += self._rm(path)
        if self.total > self.cap:
            self.scan()
        for mtime, path in sorted(self.run_dirs()):
            if self.total <= self.cap * 0.9:
                break
            if path in protected:
                continue
            removed += self._rm(path)
        for sub, max_age in (("radar", 4 * 3600), ("sat", 30 * 3600)):
            d = self.root / sub
            if d.is_dir():
                for f in d.rglob("*"):
                    if f.is_file() and now - f.stat().st_mtime > max_age:
                        size = f.stat().st_size
                        f.unlink(missing_ok=True)
                        self.total -= size
                        removed += size
        return removed

    def _rm(self, path: Path) -> int:
        size = 0
        for dirpath, _, files in os.walk(path):
            for f in files:
                try:
                    size += os.path.getsize(os.path.join(dirpath, f))
                except OSError:
                    pass
        shutil.rmtree(path, ignore_errors=True)
        self.total = max(0, self.total - size)
        log.info("cache: removed %s (%.1f MB)", path.relative_to(self.root), size / 1e6)
        return size


# --------------------------------------------------------------------------- run context

class RunContext:
    """Per-request access to one model run: indexes, messages, other variables."""

    def __init__(self, service: "FrameService", model: Model, run: str, var_id: str):
        self.service = service
        self.model = model
        self.run = run
        self.run_dt = parse_run(run)
        self.var_id = var_id
        self.steps: list[int] = service.steps_for(model.id, run)
        self._memo: dict = {}

    def prev_step(self, fhr: int) -> int | None:
        prev = [s for s in self.steps if s < fhr]
        if prev:
            return prev[-1]
        return 0 if fhr > 0 else None

    async def grid(self) -> Grid:
        g = self.service.model_grids.get(self.model.id)
        if g is not None:
            return g
        step = self.steps[0] if self.steps else 0
        d = await self.get(REF_SELECTOR[self.model.id], step)
        return d.grid

    def _product(self, sel) -> str:
        return sel.product or DEFAULT_PRODUCT[self.model.id]

    async def records(self, product: str, fhr: int) -> tuple[list[Record], list[str]]:
        return await self.service.records(self.model, product, self.run_dt, fhr)

    async def get(self, sel, fhr: int) -> Decoded:
        return (await self.get_many([sel], fhr))[0]

    async def get_many(self, sels: list, fhr: int) -> list[Decoded]:
        out: list[Decoded | None] = [None] * len(sels)
        by_product: dict[str, list[int]] = {}
        for i, sel in enumerate(sels):
            key = (sel, fhr)
            if key in self._memo:
                out[i] = self._memo[key]
            else:
                by_product.setdefault(self._product(sel), []).append(i)

        async def load(product: str, idxs: list[int]) -> None:
            records, url = await self.records(product, fhr)
            picks = []
            for i in idxs:
                rec = select(records, sels[i], fhr)
                if rec is None:
                    raise NotAvailable(f"{_sel_name(sels[i])} is not in {self.model.short} f{fhr:03d}")
                picks.append(rec)
            decoded = await self.service.fetch_decode(url, picks)
            for i, d in zip(idxs, decoded):
                self._memo[(sels[i], fhr)] = d
                out[i] = d

        await asyncio.gather(*(load(p, ix) for p, ix in by_product.items()))
        return [d for d in out if d is not None]

    async def integral(self, sel, a: int, b: int) -> tuple[np.ndarray, Grid]:
        """Integral of an accumulated (or averaged) field over hours [a, b]."""
        if a >= b:
            g = await self.grid()
            return np.zeros((g.nj, g.ni), np.float32), g
        if isinstance(sel, E):
            # ECMWF accumulations run from the start; IFS uses metres, AIFS kg m-2 (=mm).
            top = await self.get(sel, b)
            factor = 1000.0 if top.units in ("m", "m of water equivalent") else 1.0
            if a == 0:
                return top.values * factor, top.grid
            low = await self.get(sel, a)
            return (top.values - low.values) * factor, top.grid
        records, url = await self.records(self._product(sel), b)
        cands = interval_records(records, sel, b)
        if not cands:
            raise NotAvailable(f"{_sel_name(sel)} accumulation missing at f{b:03d}")
        le = [r for r in cands if r.t0 <= a]
        if le:
            rec = max(le, key=lambda r: r.t0)
            d = (await self.service.fetch_decode(url, [rec]))[0]
            vals = d.values * (rec.t1 - rec.t0 if rec.tkind == "ave" else 1.0)
            if rec.t0 == a:
                return vals, d.grid
            sub, _ = await self.integral(sel, rec.t0, a)
            return vals - sub, d.grid
        rec = min(cands, key=lambda r: r.t0)
        d = (await self.service.fetch_decode(url, [rec]))[0]
        vals = d.values * (rec.t1 - rec.t0 if rec.tkind == "ave" else 1.0)
        head, _ = await self.integral(sel, a, rec.t0)
        return head + vals, d.grid

    async def fraction(self, sel: W, a: int, b: int) -> np.ndarray:
        """Average of a 0/1 categorical field over (a, b], falling back to its value at b."""
        ave_sel = W(sel.var, sel.levels, "ave", sel.product)
        try:
            records, _ = await self.records(self._product(sel), b)
            if any(ave_sel.matches(r) and r.t1 == b for r in records):
                integ, _ = await self.integral(ave_sel, a, b)
                return np.clip(np.nan_to_num(integ) / max(1, b - a), 0, 1).astype(np.float32)
        except NotAvailable:
            pass
        d = await self.get(sel, b)
        return np.clip(np.nan_to_num(d.values), 0, 1).astype(np.float32)

    async def column_tmax(self, column, fhr: int) -> np.ndarray:
        sels = [s for _, s in column.temps] + [column.sfc_pressure, column.t2m]
        ds = await self.get_many(sels, fhr)
        psfc = np.nan_to_num(ds[-2].values, nan=101325.0)
        tmax = np.nan_to_num(ds[-1].values, nan=-1e9).astype(np.float32)
        for (p_hpa, _), d in zip(column.temps, ds[:-2]):
            above_ground = (p_hpa * 100.0) <= psfc
            t = np.nan_to_num(d.values, nan=-1e9)
            tmax = np.where(above_ground, np.maximum(tmax, t), tmax)
        return tmax

    def has_var(self, var_id: str, fhr: int) -> bool:
        return self.service.has_frame(self.model.id, self.run, var_id, fhr)

    async def var_values(self, var_id: str, fhr: int) -> tuple[list[np.ndarray], Grid]:
        return await self.service.values(self.model.id, self.run, var_id, fhr)


def _sel_name(sel) -> str:
    if isinstance(sel, W):
        return f"{sel.var} {sel.lv()[0]}"
    return f"{sel.param} {sel.levtype}{' ' + sel.level if sel.level else ''}"


# --------------------------------------------------------------------------- service

@dataclass
class FrameInfo:
    path: Path
    etag: str


class FrameService:
    def __init__(self, cache_dir: Path, cap_bytes: int, workers: int):
        self.cache = DiskCache(cache_dir, cap_bytes)
        self.frames_root = cache_dir / "frames"
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="decode")
        self._idx: OrderedDict = OrderedDict()
        self._idx_locks: dict = {}
        self._inflight: dict = {}
        self._values: OrderedDict = OrderedDict()
        self._values_bytes = 0
        self._values_cap = 384 * 1024 * 1024
        self.model_grids: dict[str, Grid] = {}
        self.runs = None  # set by the app (RunsService)
        self.compute_sem = asyncio.Semaphore(max(2, workers * 2))
        self.stats = {"frames_computed": 0, "bytes_downloaded": 0, "cache_hits": 0}

    def steps_for(self, model: str, run: str) -> list[int]:
        if self.runs is not None:
            steps = self.runs.steps(model, run)
            if steps:
                return steps
        return []

    # -- index ----------------------------------------------------------------
    async def records(self, model: Model, product: str, run_dt: datetime, fhr: int) -> tuple[list[Record], list[str]]:
        key = (model.id, product, run_dt, fhr)
        hit = self._idx.get(key)
        if hit:
            self._idx.move_to_end(key)
            return hit
        lock = self._idx_locks.setdefault(key, asyncio.Lock())
        async with lock:
            hit = self._idx.get(key)
            if hit:
                return hit
            last: Exception | None = None
            for source in model.sources:
                url = source.url(product, run_dt, fhr)
                idx_url = model.index_url(source, product, run_dt, fhr)
                try:
                    text = await get_text(idx_url, ok404=True, retries=2)
                except FetchError as exc:
                    last = exc
                    continue
                if not text:
                    continue
                recs = parse_ecmwf_index(text) if model.idx_kind == "ecmwf" else parse_wgrib_idx(text)
                if not recs:
                    continue
                mirrors = [url] + [s.url(product, run_dt, fhr) for s in model.sources if s.url(product, run_dt, fhr) != url]
                self._idx[key] = (recs, mirrors)
                while len(self._idx) > 400:
                    self._idx.popitem(last=False)
                self._idx_locks.pop(key, None)
                return recs, mirrors
            self._idx_locks.pop(key, None)
            if last:
                raise last
            raise NotAvailable(f"{model.short} {product} f{fhr:03d} is not published yet")

    async def fetch_decode(self, urls: list[str] | str, recs: list[Record]) -> list[Decoded]:
        urls = [urls] if isinstance(urls, str) else urls
        blobs = None
        last: Exception | None = None
        for url in urls:
            try:
                blobs = await fetch_ranges(url, [(r.start, r.end) for r in recs])
                break
            except FetchError as exc:
                last = exc
                log.info("fetch from %s failed (%s); trying next mirror", url.split("/")[2], exc)
        if blobs is None:
            raise last or FetchError("no mirror available")
        self.stats["bytes_downloaded"] += sum(len(b) for b in blobs)
        loop = asyncio.get_running_loop()
        out = []
        for blob in blobs:
            d = await loop.run_in_executor(self.pool, _decode_locked, blob)
            grid = register_grid(d.grid)
            d.grid = grid
            out.append(d)
        return out

    # -- paths ----------------------------------------------------------------
    def frame_path(self, model: str, run: str, var: str, fhr: int, lod: int) -> Path:
        v = VARS[var]
        if v.static:
            return self.frames_root / model / "static" / var / f"{lod}.mmf"
        return self.frames_root / model / run / var / f"{fhr:03d}.{lod}.mmf"

    def has_frame(self, model: str, run: str, var: str, fhr: int) -> bool:
        return self.frame_path(model, run, var, fhr, 0).exists()

    # -- main entry -----------------------------------------------------------
    async def get(self, model_id: str, run: str, var_id: str, fhr: int, lod: int = 0) -> FrameInfo:
        path = self.frame_path(model_id, run, var_id, fhr, lod)
        if path.exists():
            self.stats["cache_hits"] += 1
            return FrameInfo(path, _etag(path))
        await self._ensure(model_id, run, var_id, fhr)
        if not path.exists():
            raise NotAvailable("frame could not be produced")
        return FrameInfo(path, _etag(path))

    async def _ensure(self, model_id: str, run: str, var_id: str, fhr: int) -> None:
        key = (model_id, run, var_id, fhr if not VARS[var_id].static else -1)
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._compute(model_id, run, var_id, fhr))
            self._inflight[key] = task

            def _done(t: asyncio.Task, k=key) -> None:
                self._inflight.pop(k, None)
                if not t.cancelled():
                    t.exception()  # mark retrieved; waiters re-raise it themselves

            task.add_done_callback(_done)
        # shield: a client disconnecting must not cancel work other requests share
        await asyncio.shield(task)

    async def _compute(self, model_id: str, run: str, var_id: str, fhr: int) -> None:
        var = VARS[var_id]
        model = REGISTRY[model_id]
        recipe = var.recipes.get(model_id)
        if recipe is None:
            raise NotAvailable(f"{var.name} is not available from {model.short}")
        ctx = RunContext(self, model, run, var_id)
        if var.static and ctx.steps:
            fhr = ctx.steps[0]
        async with self.compute_sem:
            t0 = time.perf_counter()
            result: Result = await recipe.compute(ctx, fhr)
        self.model_grids.setdefault(model_id, result.grid)
        loop = asyncio.get_running_loop()
        lods = await loop.run_in_executor(
            self.pool, _encode_result, result, var, model, run, fhr
        )
        # lod0 last: its presence marks the frame complete
        for lod in (2, 1, 0):
            self.cache.write(self.frame_path(model_id, run, var_id, fhr, lod), lods[lod])
        self.stats["frames_computed"] += 1
        self._remember(model_id, run, var_id, fhr, [a.astype(np.float32) for a in result.data], result.grid)
        log.debug("computed %s %s %s f%03d in %.2fs", model_id, run, var_id, fhr, time.perf_counter() - t0)

    # -- decoded values (for derived products, sampling, alerts) -------------
    def _remember(self, model, run, var, fhr, data, grid) -> None:
        key = (model, run, var, fhr)
        size = sum(a.nbytes for a in data)
        if key in self._values:
            return
        self._values[key] = (data, grid)
        self._values_bytes += size
        while self._values_bytes > self._values_cap and self._values:
            _, (old, _) = self._values.popitem(last=False)
            self._values_bytes -= sum(a.nbytes for a in old)

    async def values(self, model: str, run: str, var: str, fhr: int) -> tuple[list[np.ndarray], Grid]:
        key = (model, run, var, fhr)
        hit = self._values.get(key)
        if hit is not None:
            self._values.move_to_end(key)
            return hit
        info = await self.get(model, run, var, fhr, 0)
        loop = asyncio.get_running_loop()
        header, comps = await loop.run_in_executor(self.pool, _read_frame, info.path)
        data = [dequantize(q, header["scale"], header["offset"]) for q in comps]
        from .grib import grid_from_client

        grid = grid_from_client(header["grid"])
        self.model_grids.setdefault(model, grid)
        self._remember(model, run, var, fhr, data, grid)
        return data, grid

    def close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)


def _decode_locked(blob: bytes) -> Decoded:
    if _PARALLEL_DECODE:
        return decode_message(blob)
    with _ECCODES_LOCK:
        return decode_message(blob)


def _read_frame(path: Path):
    return decode(path.read_bytes())


def _etag(path: Path) -> str:
    st = path.stat()
    return f'"{int(st.st_mtime)}-{st.st_size}"'


def _encode_result(result: Result, var: Var, model: Model, run: str, fhr: int) -> tuple[bytes, bytes, bytes]:
    grid = result.grid
    spec0 = grid.client()
    valid = (parse_run(run) + timedelta(hours=fhr)).strftime("%Y-%m-%dT%H:%M:%SZ")
    comps0 = [quantize(a, var.scale, var.offset) for a in result.data]
    finite = [a[np.isfinite(a)] for a in result.data]
    if result.kind == "vector" and len(result.data) == 2:
        sp = np.hypot(result.data[0], result.data[1])
        sp = sp[np.isfinite(sp)]
        vmin, vmax = (float(sp.min()), float(sp.max())) if sp.size else (0.0, 0.0)
    elif finite and finite[0].size:
        vmin, vmax = float(finite[0].min()), float(finite[0].max())
    else:
        vmin = vmax = 0.0
    header = {
        "v": 1, "model": model.id, "run": run, "fhr": fhr, "valid": valid, "var": var.id,
        "kind": result.kind, "comps": len(comps0), "w": grid.ni, "h": grid.nj,
        "scale": var.scale, "offset": var.offset, "units": var.units,
        "min": round(vmin, 3), "max": round(vmax, 3), "grid": spec0, "lod": 0,
        "src": model.attribution, **{k: v for k, v in result.meta.items() if v is not None},
    }
    lod0 = encode(header, comps0)

    mode = var.lod
    if result.kind == "category":
        small = [downsample_ptype(a) for a in result.data]
        shift = 0.0
    else:
        small = [downsample(a, mode) for a in result.data]
        shift = 0.0 if mode == "nearest" else 0.5
    h1, w1 = small[0].shape
    grid1 = lod_grid(spec0, 2, shift)
    header1 = dict(header, w=w1, h=h1, lod=1, grid=grid1)
    lod1 = encode(header1, [quantize(a, var.scale, var.offset) for a in small])
    if result.kind == "category":
        tiny = [downsample_ptype(a) for a in small]
    else:
        tiny = [downsample(a, mode) for a in small]
    h2, w2 = tiny[0].shape
    header2 = dict(header, w=w2, h=h2, lod=2, grid=lod_grid(grid1, 2, shift))
    lod2 = encode(header2, [quantize(a, var.scale, var.offset) for a in tiny])
    return lod0, lod1, lod2
