"""Run Mammatus on synthetic weather, with no network access.

For UI work, screenshots and fuzz testing. Every API the web app uses is served through the real
FastAPI app, frame encoders and lightning chunk format; only the upstream data is invented:
a few cyclones drift east across a fixed timeline, with fronts, rain/snow bands, radar, satellite
clouds, lightning along the cold fronts, NWS warnings, meteograms and soundings to match.

    python tools/demo_server.py --port 8099          # sign in as demo / synthetic-weather-42

Set MAMMATUS_DATA_DIR to keep the generated cache somewhere specific (default /tmp/mammatus-demo).
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import io
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
UTC = timezone.utc
START = time.time()  # the synthetic weather is anchored to the server start, so a session is self-consistent

# lon0, lat0 (at START), dlon/h, dlat/h, depth (hPa, <0 low), radius (deg)
SYSTEMS = [
    (-97.0, 39.0, 0.55, 0.06, -19.0, 8.5),
    (-62.0, 47.0, 0.45, 0.03, -14.0, 11.0),
    (-128.0, 47.0, 0.50, -0.02, -11.0, 9.0),
    (-150.0, 52.0, 0.40, 0.01, -16.0, 12.0),
    (-30.0, 58.0, 0.35, 0.02, -15.0, 13.0),
    (10.0, 62.0, 0.30, 0.00, -10.0, 12.0),
    (120.0, 45.0, 0.45, 0.02, -12.0, 10.0),
    (160.0, -50.0, 0.50, 0.00, -18.0, 12.0),
    (-80.0, -55.0, 0.45, 0.00, -16.0, 12.0),
    (-82.0, 31.0, 0.25, 0.0, 9.0, 14.0),     # subtropical highs
    (-35.0, 33.0, 0.10, 0.0, 12.0, 20.0),
    (-140.0, 33.0, 0.10, 0.0, 10.0, 18.0),
    (65.0, 30.0, 0.15, 0.0, 6.0, 18.0),
]


def wrap(lon):
    return (np.asarray(lon) + 180.0) % 360.0 - 180.0


def systems_at(hours: float):
    out = []
    for lon0, lat0, vx, vy, amp, rad in SYSTEMS:
        out.append((float(wrap(lon0 + vx * hours)), lat0 + vy * hours, amp, rad))
    return out


def hours_at(t: float) -> float:
    return (t - START) / 3600.0


def noise(lat, lon, hours, seed=0, scale=1.0):
    """Smooth pseudo-noise in [-1, 1] that drifts slowly with time."""
    rng = np.random.default_rng(1234 + seed)
    acc = np.zeros(np.broadcast(lat, lon).shape, np.float32)
    lr, nr = np.radians(lat), np.radians(lon)
    for k in range(6):
        a, b = rng.uniform(2, 9) * scale, rng.uniform(2, 9) * scale
        ph, w = rng.uniform(0, 6.28), rng.uniform(-0.05, 0.05)
        acc += np.sin(a * nr + b * lr + ph + w * hours).astype(np.float32) * (0.7 ** k)
    return acc / 2.2


def offsets(lat, lon, clon, clat):
    dlon = wrap(lon - clon)
    return dlon * np.cos(np.radians((lat + clat) / 2.0)), lat - clat


def precip_intensity(lat, lon, hours):
    """0..1 rain/snow intensity: cold-front bands, comma heads near the lows."""
    out = np.zeros(np.broadcast(lat, lon).shape, np.float32)
    cells = 0.5 + 0.5 * noise(lat, lon, hours * 6, seed=3, scale=4.0)
    for clon, clat, amp, rad in systems_at(hours):
        if amp >= 0:
            continue
        dx, dy = offsets(lat, lon, clon, clat)
        depth = min(1.0, -amp / 16.0)
        fd = dx + 0.55 * (-dy)                               # cold front trails SSW of the low
        band = np.exp(-(fd / 1.1) ** 2) * (dy < 1.5) * np.exp(-((dy + 7) / 9.0) ** 2)
        head = np.exp(-(((dx - 1.5) / (rad * 0.55)) ** 2 + ((dy - 2.5) / (rad * 0.35)) ** 2))
        out = np.maximum(out, depth * (band * (0.35 + 0.9 * cells) + head * (0.55 + 0.4 * cells)))
    return np.clip(out, 0, 1)


def mslp(lat, lon, hours):
    p = 1013.0 + 6.0 * np.cos(np.radians(lat) * 3.0) ** 2 - 3.0
    for clon, clat, amp, rad in systems_at(hours):
        dx, dy = offsets(lat, lon, clon, clat)
        p = p + amp * np.exp(-(dx * dx + dy * dy) / (rad * rad))
    return (p + 1.5 * noise(lat, lon, hours, seed=1)).astype(np.float32)


def geostrophic(field_fn, lat, lon, hours, k=4.5, eps=0.25):
    """Wind (m/s) from finite differences of a pressure-like field; flips with hemisphere."""
    cl = np.maximum(np.cos(np.radians(lat)), 0.15)
    dpx = (field_fn(lat, lon + eps / cl, hours) - field_fn(lat, lon - eps / cl, hours)) / (2 * eps)
    dpy = (field_fn(lat + eps, lon, hours) - field_fn(lat - eps, lon, hours)) / (2 * eps)
    sgn = np.tanh(lat / 8.0)
    u, v = -k * dpy * sgn, k * dpx * sgn
    sp = np.hypot(u, v)
    f = np.minimum(1.0, 45.0 / np.maximum(sp, 1e-3))
    return (u * f).astype(np.float32), (v * f).astype(np.float32)


def t2m(lat, lon, hours, valid: datetime):
    base = 302.0 - 52.0 * np.sin(np.radians(lat)) ** 2
    solar = (valid.hour + valid.minute / 60.0 + lon / 15.0) % 24.0
    diurnal = 5.5 * np.cos((solar - 15.0) / 24.0 * 2 * np.pi)
    adv = np.zeros_like(base)
    for clon, clat, amp, rad in systems_at(hours):
        if amp >= 0:
            continue
        dx, dy = offsets(lat, lon, clon, clat)
        fd = dx + 0.55 * (-dy)
        adv += (-amp / 18.0) * 7.0 * np.tanh(fd / 2.5) * np.exp(-((dy + 3) / (rad * 1.4)) ** 2)
    return (base + diurnal + adv + 2.0 * noise(lat, lon, hours, seed=2)).astype(np.float32)


def hgt500(lat, lon, hours):
    z = 5880.0 - 640.0 * np.sin(np.radians(lat)) ** 2
    for clon, clat, amp, rad in systems_at(hours):
        dx, dy = offsets(lat, lon, clon - 7.0, clat + 2.0)
        z = z + amp * 9.0 * np.exp(-(dx * dx + dy * dy) / (rad * 1.6) ** 2)
    return (z + 25.0 * noise(lat, lon, hours, seed=5)).astype(np.float32)


def synth_var(var: str, lat, lon, hours: float, valid: datetime, fhr: int):
    """(kind, [arrays]) for one catalog variable in its canonical units."""
    if var in ("t2m",):
        return "scalar", [t2m(lat, lon, hours, valid)]
    if var == "d2m":
        t = t2m(lat, lon, hours, valid)
        return "scalar", [t - 2.0 - 9.0 * (0.5 + 0.5 * noise(lat, lon, hours, seed=7))]
    if var in ("rh2m", "rh700", "tcc"):
        p = precip_intensity(lat, lon, hours)
        v = np.clip(45 + 35 * noise(lat, lon, hours, seed=8 + len(var)) + 60 * p, 0, 100)
        return "scalar", [v.astype(np.float32)]
    if var in ("wind10", "wind850", "wind500", "wind250"):
        if var == "wind10":
            u, v = geostrophic(mslp, lat, lon, hours, k=3.2)
            u, v = u * 0.75, v * 0.75
        else:
            k = {"wind850": 0.06, "wind500": 0.11, "wind250": 0.17}[var]
            u, v = geostrophic(hgt500, lat, lon, hours, k=k)
            u = u + {"wind850": 3, "wind500": 9, "wind250": 18}[var] * np.cos(np.radians(lat - 40) * 2.2) ** 4
        return "vector", [u.astype(np.float32), v.astype(np.float32)]
    if var == "gust":
        u, v = geostrophic(mslp, lat, lon, hours, k=3.2)
        return "scalar", [(np.hypot(u, v) * 1.35 + 3).astype(np.float32)]
    if var == "mslp":
        return "scalar", [mslp(lat, lon, hours)]
    if var == "refc":
        p = precip_intensity(lat, lon, hours)
        r = -12 + 78 * p ** 0.8
        r[r < -5] = np.nan
        return "scalar", [r.astype(np.float32)]
    if var == "ptype":
        p = precip_intensity(lat, lon, hours)
        t = t2m(lat, lon, hours, valid)
        cat = np.where(t > 274.5, 1, np.where(t < 271.5, 2, np.where(t > 273.3, 3, np.where(t > 272.4, 4, 5))))
        rate = np.where(cat == 1, 28.0, 4.0) * p ** 1.6
        code = np.where(p > 0.05, cat * 4096 + np.minimum(4095, np.round(rate / 0.05)), 0)
        return "category", [code.astype(np.float32)]
    if var.startswith("apcp") or var in ("snow10", "snowku", "snownat", "frzr", "snod", "snow10_inc", "snowku_inc", "frzr_inc"):
        span = {"apcp_1h": 1, "apcp_6h": 6, "apcp_24h": 24}.get(var, max(1, min(fhr, 72)))
        acc = np.zeros(np.broadcast(lat, lon).shape, np.float32)
        steps = 4
        for k in range(steps):
            acc += precip_intensity(lat, lon, hours - span * (k + 0.5) / steps)
        acc *= span / steps * 3.5
        if "snow" in var or var == "snod":
            t = t2m(lat, lon, hours, valid)
            acc *= np.clip((275.0 - t) / 4.0, 0, 1) * (12 if "ku" in var else 10)
        if "frzr" in var:
            t = t2m(lat, lon, hours, valid)
            acc *= np.clip(1 - np.abs(t - 273.0) / 1.5, 0, 1) * 0.4
        return "scalar", [acc]
    if var.startswith("cape"):
        t = t2m(lat, lon, hours, valid)
        v = np.clip((t - 288.0) * 260.0, 0, None) * (0.5 + 0.5 * noise(lat, lon, hours, seed=11, scale=2.0))
        return "scalar", [v.astype(np.float32)]
    if var.startswith("srh"):
        u, v = geostrophic(mslp, lat, lon, hours, k=3.2)
        return "scalar", [(np.hypot(u, v) * 14 - 40).astype(np.float32)]
    if var == "uh25":
        p = precip_intensity(lat, lon, hours)
        v = np.clip(p - 0.55, 0, None) * 600 * (0.5 + 0.5 * noise(lat, lon, hours * 4, seed=12, scale=5.0))
        return "scalar", [v.astype(np.float32)]
    if var == "pwat":
        t = t2m(lat, lon, hours, valid)
        return "scalar", [np.clip((t - 255.0) * 1.4 + 8 * noise(lat, lon, hours, seed=13), 2, 75).astype(np.float32)]
    if var == "hgt500":
        return "scalar", [hgt500(lat, lon, hours)]
    if var in ("hgt700", "hgt850", "hgt1000"):
        base = {"hgt700": 3010.0, "hgt850": 1460.0, "hgt1000": 110.0}[var]
        return "scalar", [(base + (mslp(lat, lon, hours) - 1013.0) * 8.0).astype(np.float32)]
    if var == "thick":
        return "scalar", [(hgt500(lat, lon, hours) - (mslp(lat, lon, hours) - 1013.0) * 8.0 - 110.0).astype(np.float32)]
    if var == "absv500":
        f = 14.6 * np.sin(np.radians(lat))
        z = hgt500(lat, lon, hours)
        trough = (5700.0 - 640.0 * np.sin(np.radians(lat)) ** 2 + 180 - z) / 18.0
        return "scalar", [(f + np.sign(lat) * trough).astype(np.float32)]
    if var == "t850":
        return "scalar", [(t2m(lat, lon, hours, valid) - 13.0).astype(np.float32)]
    if var == "vis":
        p = precip_intensity(lat, lon, hours)
        return "scalar", [np.clip(16000 * (1 - p) ** 2, 200, 16000).astype(np.float32)]
    if var == "orog":
        v = np.clip(900 + 1400 * noise(lat, lon, 0, seed=21, scale=3.0), 0, 4000)
        return "scalar", [v.astype(np.float32)]
    # anything else: a smooth, positive field
    return "scalar", [np.clip(50 + 50 * noise(lat, lon, hours, seed=hash(var) % 97), 0, None).astype(np.float32)]


# --------------------------------------------------------------------------- grids

HRRR_SPEC = {"type": "lambert", "ni": 1799, "nj": 1059, "la1": 21.138123, "lo1": 237.280472, "lov": 262.5,
             "lad": 38.5, "latin1": 38.5, "latin2": 38.5, "dx": 3000.0, "dy": 3000.0, "jpos": 1}
GLOBAL_SPEC = {"type": "latlon", "ni": 1440, "nj": 721, "la1": 90.0, "lo1": 0.0, "dlon": 0.25, "dlat": -0.25}
MRMS_SPEC = {"type": "latlon", "ni": 3000, "nj": 1500, "la1": 54.99, "lo1": 230.01, "dlon": 0.02, "dlat": -0.02}


def demo_grid(model_id: str):
    from mammatus.data.grib import register_grid

    return register_grid(HRRR_SPEC if model_id in ("hrrr", "rrfs") else GLOBAL_SPEC)


# --------------------------------------------------------------------------- service patches

def patch() -> None:
    from mammatus.data import fronts as FR, frames as F, lightning as L, nws as N, openmeteo as OM, radar as R
    from mammatus.data import runs as RU, satellite as S
    from mammatus.data.catalog import VARS
    from mammatus.data.derive import Result
    from mammatus.data.models import REGISTRY

    # ---- runs: a fresh cycle per model, plus an older one
    def _load(self):
        self._runs = {m.id: [] for m in self.models}
        now = datetime.now(UTC)
        for m in self.models:
            cyc = m.cycle_hours
            latest = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=2 if cyc == 1 else 5)
            latest = latest.replace(hour=latest.hour - latest.hour % cyc)
            for i, run_dt in enumerate([latest, latest - timedelta(hours=cyc * (6 if cyc == 1 else 1))]):
                if m.id in ("hrrr", "rrfs"):
                    steps = list(range(0, 19 if i == 0 else 49))
                elif m.id == "gfs":
                    steps = list(range(0, 121, 3)) + list(range(132, 241, 12))
                else:
                    steps = list(range(0, 145, 3)) + list(range(150, 241, 6))
                self._runs[m.id].append(RU.RunInfo(m.id, run_dt.strftime("%Y%m%d%H"), steps, True, time.time()))

    RU.RunsService._load = _load

    # ---- model frames
    async def _compute(self, model_id, run, var_id, fhr):
        var, model = VARS[var_id], REGISTRY[model_id]
        grid = demo_grid(model_id)
        valid = F.parse_run(run) + timedelta(hours=fhr)
        loop = asyncio.get_running_loop()

        def work():
            lat, lon = grid.latlon()
            kind, data = synth_var(var_id, lat, lon, hours_at(valid.timestamp()), valid, fhr)
            if model_id in ("hrrr", "rrfs") and var.kind != "category":
                data = [a.astype(np.float32) for a in data]
            res = Result(kind, data, grid, {})
            return res, F._encode_result(res, var, model, run, fhr)

        result, lods = await loop.run_in_executor(self.pool, work)
        for lod in (2, 1, 0):
            self.cache.write(self.frame_path(model_id, run, var_id, fhr, lod), lods[lod])
        self._remember(model_id, run, var_id, fhr, [a.astype(np.float32) for a in result.data], result.grid)

    F.FrameService._compute = _compute

    # ---- radar (MRMS-like, CONUS, every 4 minutes)
    async def radar_times(self, hours=2.0, spacing_min=4.0):
        self.last_viewed = time.time()
        end = int((time.time() - 150) // 240 * 240)
        n = int(hours * 60 / 4)
        return [datetime.fromtimestamp(end - 240 * k, UTC).strftime("%Y%m%d-%H%M%S") for k in range(n)][::-1]

    async def radar_build(self, stamp):
        t = datetime.strptime(stamp, "%Y%m%d-%H%M%S").replace(tzinfo=UTC)
        loop = asyncio.get_running_loop()

        def work():
            from mammatus.data.grib import register_grid

            grid = register_grid(MRMS_SPEC)
            lat, lon = grid.latlon()
            p = precip_intensity(lat, lon, hours_at(t.timestamp()))
            vals = -12 + 80 * p ** 0.8
            vals[vals < -2] = np.nan
            base = grid.client()
            header = {"v": 1, "model": "mrms", "run": stamp, "fhr": 0, "valid": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                      "var": "mrms", "kind": "scalar", "comps": 1, "scale": R.SCALE, "offset": R.OFFSET, "units": "dBZ",
                      "src": "synthetic", "lod": 0}
            out, arr = [], vals.astype(np.float32)
            grids = [base, F.lod_grid(base, 2, 0.5), F.lod_grid(F.lod_grid(base, 2, 0.5), 2, 0.5)]
            for lod in range(3):
                if lod:
                    arr = F.downsample(arr, "max")
                h_, w_ = arr.shape
                out.append(F.encode(dict(header, w=w_, h=h_, lod=lod, grid=dict(grids[lod], id=f"mrms{lod}")),
                                    [F.quantize(arr, R.SCALE, R.OFFSET)]))
            return out

        lods = await loop.run_in_executor(self.pool, work)
        for lod in (2, 1, 0):
            self.cache.write(self.path(stamp, lod), lods[lod])

    R.RadarService.times = radar_times
    R.RadarService._build = radar_build
    R.RadarService.start = lambda self: None

    # ---- satellite (2048 x 1024 equirectangular, every 10 minutes)
    async def sat_times(self, product, count=12):
        if product not in S.PRODUCTS:
            raise ValueError(product)
        end = int((time.time() - 600) // 600 * 600)
        return [datetime.fromtimestamp(end - 600 * k, UTC).strftime("%Y%m%d.%H%M%S") for k in range(count)][::-1]

    async def sat_build(self, product, stamp):
        t = datetime.strptime(stamp, "%Y%m%d.%H%M%S").replace(tzinfo=UTC)
        loop = asyncio.get_running_loop()

        def work():
            from PIL import Image

            lat = np.linspace(89.9, -89.9, 1024, dtype=np.float32)[:, None]
            lon = np.linspace(-179.9, 179.9, 2048, dtype=np.float32)[None, :]
            h = hours_at(t.timestamp())
            p = precip_intensity(lat, lon, h)
            c = np.clip(0.45 * p ** 0.5 + 0.35 * (0.5 + 0.5 * noise(lat, lon, h, seed=31, scale=3.0)) - 0.12, 0, 1)
            v = np.clip(c * 255 * (1.1 if product == "globalir" else 1.0), 0, 255).astype(np.uint8)
            rgba = np.dstack([v, v, v, np.clip(c * 330, 0, 255).astype(np.uint8)])
            buf = io.BytesIO()
            Image.fromarray(rgba, "RGBA").save(buf, "WEBP", quality=70)
            return buf.getvalue()

        data = await loop.run_in_executor(self.pool, work)
        self.cache.write(self.path(product, stamp), data)

    S.SatelliteService.times = sat_times
    S.SatelliteService._build = sat_build

    # ---- lightning along the cold fronts, true rhythm, ~45 s behind real time
    busy = float(os.environ.get("DEMO_LIGHTNING_RATE", "1"))  # >1 to stress-test a raging storm

    def strikes(t0: int) -> np.ndarray:
        rng = np.random.default_rng(t0)
        rows = []
        for clon, clat, amp, rad in systems_at(hours_at(t0 + 300)):
            if amp >= -9 or not (-175 < clon < -5):  # lows inside the GOES-East/West view
                continue
            for k in range(7):  # cells strung along the front
                dy = -1.5 - k * 1.6
                cx, cy = clon + (0.55 * dy + 0.35 * math.sin(k * 2.1)) / math.cos(math.radians(clat + dy)), clat + dy
                rate = busy * (0.08 + 0.7 * abs(math.sin(k * 1.7 + t0 / 1800.0)) ** 2)   # flashes per second
                n = rng.poisson(rate * 600)
                t = t0 + np.sort(rng.uniform(0, 600, n))
                drift = (t - t0 - 300) / 3600.0 * 0.5
                rows.append(np.rec.fromarrays([t, cy + rng.normal(0, 0.16, n), wrap(cx + drift + rng.normal(0, 0.2, n)),
                                               rng.integers(30, 255, n)], dtype=L.DTYPE))
        arr = np.concatenate(rows) if rows else np.zeros(0, L.DTYPE)
        return np.sort(arr, order="t")

    def l_status(self):
        now = time.time()
        return {"enabled": True, "now": round(now, 2), "latest": now - 45, "start": now - 3 * 3600, "chunk": L.CHUNK,
                "ingesting": True, "warming": False,
                "sources": [{"id": "east", "label": "GOES-East", "satellite": "GOES-19", "ok": True},
                            {"id": "west", "label": "GOES-West", "satellite": "GOES-18", "ok": True}]}

    def l_chunk(self, t0, after=None):
        if t0 % L.CHUNK:
            raise ValueError("chunk start must be a multiple of 600 s")
        now = time.time()
        latest = now - 45
        arr = strikes(t0)
        arr = arr[arr["t"] <= latest]
        if after is not None:
            arr = arr[arr["t"] > after]
        final = t0 + L.CHUNK + L.LEAD < latest
        return gzip.compress(L.encode_chunk(t0, arr, final=final, latest=latest, now=now), mtime=0), final

    L.LightningService.status = l_status
    L.LightningService.chunk = l_chunk
    L.LightningService.start = lambda self: None

    async def l_stop(self):
        return None

    L.LightningService.stop = l_stop

    # ---- WPC-style fronts every 3 hours, forecasts to 48 h
    def front_set(kind, hours_ahead, valid):
        h = hours_at(valid.timestamp())
        fronts, highs, lows = [], [], []
        for clon, clat, amp, rad in systems_at(h):
            if not (-170 < clon < -40 and 20 < clat < 65):
                continue
            if amp > 0:
                highs.append([round(clon, 1), round(clat, 1), int(1013 + amp)])
                continue
            lows.append([round(clon, 1), round(clat, 1), int(1013 + amp)])
            cold = [[clon - 0.55 * k / math.cos(math.radians(clat - k)) + 0.4 * math.sin(k / 2.0), clat - k] for k in range(0, 15)]
            warm = [[clon + k * 1.1, clat - 0.25 * k - 0.05 * k * k] for k in range(0, 10)]
            occl = [[clon - 0.6 * k, clat + 0.5 * k] for k in range(0, 5)][::-1]
            fronts += [{"type": "cold", "coords": cold, "strength": "strong" if amp < -15 else "moderate"},
                       {"type": "warm", "coords": warm}, {"type": "occluded", "coords": occl},
                       {"type": "trough", "coords": [[clon - 9, clat - 4], [clon - 6, clat - 12], [clon - 5, clat - 18]]}]
        return {"kind": kind, "hours": hours_ahead, "valid": valid.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "issued": (valid - timedelta(minutes=90) if kind == "analysis" else datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "highs": highs, "lows": lows, "fronts": fronts}

    async def f_sets(self):
        now = datetime.now(UTC)
        an = (now - timedelta(minutes=90)).replace(minute=0, second=0, microsecond=0)
        an = an.replace(hour=an.hour - an.hour % 3)
        sets = [front_set("analysis", 0, an - timedelta(hours=3 * k)) for k in range(4)][::-1]
        sets += [front_set("forecast", hh, an + timedelta(hours=hh)) for hh in (12, 24, 36, 48)]
        return {"sets": sets, "updated": round(time.time()), "attribution": "synthetic"}

    FR.FrontsService.sets = f_sets

    # ---- NWS: warning polygons on the cells, zone alerts by county
    async def nws_active(self, max_age=120):
        out = []
        for i, (clon, clat, amp, rad) in enumerate(systems_at(hours_at(time.time()))):
            if amp >= -9 or not (-130 < clon < -65):
                continue
            for k in (2, 4):
                cx, cy = clon - 0.55 * (1.5 + k * 1.6) / math.cos(math.radians(clat)), clat - 1.5 - k * 1.6
                ring = [[round(cx + 0.6 * math.cos(a), 3), round(cy + 0.4 * math.sin(a), 3)] for a in np.linspace(0, 6.283, 7)]
                event = "Tornado Warning" if k == 2 else "Severe Thunderstorm Warning"
                out.append({"id": f"demo-{i}-{k}", "event": event, "severity": "Extreme" if k == 2 else "Severe",
                            "urgency": "Immediate", "certainty": "Observed", "headline": f"{event} (demo)", "area": "Demo County",
                            "sent": datetime.now(UTC).isoformat(), "onset": None, "ends": None, "sender": "NWS Demo",
                            "color": N.COLORS.get(event, "#E0E0E0"), "polys": [[ring]], "fips": [], "msgType": "Alert"})
        out.append({"id": "demo-winter", "event": "Winter Storm Warning", "severity": "Moderate", "urgency": "Expected",
                    "certainty": "Likely", "headline": "Winter Storm Warning (demo)", "area": "Demo", "sent": None,
                    "onset": None, "ends": None, "sender": "NWS Demo", "color": N.COLORS.get("Winter Storm Warning", "#FF69B4"),
                    "polys": None, "fips": ["08013", "08059", "08031", "08005", "08001", "08069", "08123"], "msgType": "Alert"})
        return out

    async def nws_point(self, lat, lon, max_age=110):
        return [a for a in await nws_active(self) if a["polys"] and abs(a["polys"][0][0][0][1] - lat) < 1.5
                and abs(a["polys"][0][0][0][0] - lon) < 1.5]

    N.NWSService.active = nws_active
    N.NWSService.at_point = nws_point

    # ---- point forecasts
    async def om_meteogram(self, lat, lon, models, elevation=None, days=16):
        t0 = int(time.time() // 3600 * 3600) - 6 * 3600
        times = [t0 + 3600 * k for k in range(24 * 10)]
        out = {}
        for mi, m in enumerate(models):
            series = {}
            hrs = np.array([hours_at(t) for t in times])
            la, lo = np.full(len(times), lat, np.float32), np.full(len(times), lon, np.float32)
            temp = np.array([float(t2m(np.float32(lat), np.float32(lon), h, datetime.fromtimestamp(t, UTC))) for h, t in zip(hrs, times)]) - 273.15 + mi * 0.6
            p = np.array([float(precip_intensity(np.float32(lat), np.float32(lon), h)) for h in hrs])
            series["temperature_2m"] = np.round(temp, 1).tolist()
            series["dew_point_2m"] = np.round(temp - 4 - 2 * np.sin(hrs / 7), 1).tolist()
            series["apparent_temperature"] = np.round(temp - 1.5, 1).tolist()
            series["relative_humidity_2m"] = np.round(np.clip(60 + 30 * p, 0, 100)).tolist()
            series["precipitation"] = np.round(p * 6, 2).tolist()
            series["rain"] = np.round(p * 6 * (temp > 0), 2).tolist()
            series["showers"] = [0.0] * len(times)
            series["snowfall"] = np.round(p * 4 * (temp <= 0), 2).tolist()
            series["weather_code"] = [61 if x > 0.2 else 3 for x in p]
            series["cloud_cover"] = np.round(np.clip(30 + 70 * p, 0, 100)).tolist()
            series["pressure_msl"] = np.round([float(mslp(np.float32(lat), np.float32(lon), h)) for h in hrs], 1).tolist()
            series["wind_speed_10m"] = np.round(4 + 3 * np.sin(hrs / 5 + mi), 1).tolist()
            series["wind_direction_10m"] = np.round((200 + 60 * np.sin(hrs / 9)) % 360).tolist()
            series["wind_gusts_10m"] = np.round(7 + 4 * np.sin(hrs / 5 + mi), 1).tolist()
            series["freezing_level_height"] = np.round(2000 + 600 * np.sin(hrs / 11)).tolist()
            series["cape"] = np.round(np.clip(800 * np.sin(hrs / 6), 0, None)).tolist()
            series["visibility"] = np.round(24000 * (1 - p)).tolist()
            limit = int(len(times) * min(1.0, (2 + mi) / 6))
            out[m] = {k: v[:limit] + [None] * (len(times) - limit) for k, v in series.items()}
        return {"lat": lat, "lon": lon, "elevation": 300.0, "time": times, "models": out}

    async def om_sounding(self, lat, lon, model, days=4):
        t0 = int(time.time() // 3600 * 3600) - 3 * 3600
        times = [t0 + 3600 * k for k in range(24 * days)]
        n = len(times)
        levels = {}
        for p in OM.LEVELS:
            z = 44330.8 * (1 - (p / 1013.25) ** 0.190263)
            t = 18 - 6.5 * z / 1000 if z < 11000 else -56.5
            levels[str(p)] = {
                "temperature": [round(t + math.sin(k / 6), 1) for k in range(n)],
                "dew_point": [round(t - 3 - z / 900, 1) for k in range(n)],
                "relative_humidity": [max(5, round(85 - z / 200)) for _ in range(n)],
                "wind_speed": [round(5 + z / 600, 1) for _ in range(n)],
                "wind_direction": [round((180 + z / 120) % 360) for _ in range(n)],
                "geopotential_height": [round(z) for _ in range(n)],
            }
        surface = {"temperature_2m": [20.0] * n, "dew_point_2m": [15.0] * n, "surface_pressure": [1005.0] * n,
                   "wind_speed_10m": [4.0] * n, "wind_direction_10m": [170] * n, "cape": [1200] * n,
                   "convective_inhibition": [-30] * n, "freezing_level_height": [3800] * n}
        return {"lat": lat, "lon": lon, "elevation": 100.0, "model": model, "time": times, "levels": levels, "surface": surface}

    async def om_elevation(self, lat, lon):
        return 250.0

    async def om_search(self, name, count=8):
        return [{"name": f"{name.title()} (demo)", "admin1": "Demo", "country": "US", "lat": 35.6, "lon": -82.55,
                 "elevation": 650.0, "population": 95000}]

    # ---- sky view: a made-up sky of each kind. The scene follows the place (one per 1.5-degree tile) and
    # drifts with the forecast hour; MAMMATUS_DEMO_SKY (or the file <data dir>/sky_scene) picks one.
    from mammatus.data import sky as SK

    def scene_for(lat, lon):
        override = os.environ.get("MAMMATUS_DEMO_SKY")
        try:
            override = (Path(os.environ.get("MAMMATUS_DATA_DIR", "/tmp/mammatus-demo")) / "sky_scene").read_text().strip() or override
        except OSError:
            pass
        if override in SK.SCENES:
            return override
        return SK.SCENES[int(abs(math.floor(lat / 1.5) * 7 + math.floor(lon / 1.5) * 3)) % len(SK.SCENES)]

    async def sky_frame(self, model_id, run, fhr, lat, lon, detail=1):
        scene = scene_for(lat, lon)
        valid = F.parse_run(run) + timedelta(hours=fhr)
        drift = hours_at(valid.timestamp())
        model = REGISTRY[model_id]
        header = {"model": model_id, "source": model.short, "attribution": model.attribution, "run": run, "fhr": fhr,
                  "valid": valid.strftime("%Y-%m-%dT%H:%M:%SZ"), "estimated": False, "detail": detail,
                  "lat": round(lat, 3), "lon": round(lon, 3), "demo": scene}
        loop = asyncio.get_running_loop()
        await asyncio.sleep(0.15 if detail == 0 else 0.5)
        return await loop.run_in_executor(None, lambda: SK.pack(SK.synth_box(scene, drift, lat), header))

    async def sky_estimated(self, om_model, when, lat, lon):
        scene = scene_for(lat, lon)
        header = {"model": om_model, "source": SK.ESTIMATED_MODELS.get(om_model, om_model), "attribution": "Open-Meteo (CC BY 4.0)",
                  "run": None, "fhr": None, "valid": time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(when)),
                  "estimated": True, "detail": 1, "lat": round(lat, 3), "lon": round(lon, 3), "demo": scene}
        return SK.pack(SK.synth_box(scene, hours_at(when), lat), header)

    async def sky_observed(self, lat, lon):
        scene = scene_for(lat, lon)
        layers = {"fair": [("FEW", 4200)], "towers": [("SCT", 3700)], "storm": [("SCT", 3300), ("BKN", 9000)],
                  "cirro": [("SCT", 13500)], "stratus": [("OVC", 1100)], "front": [("BKN", 1500), ("OVC", 4000)],
                  "decks": [("BKN", 5000), ("BKN", 13000)], "snow": [("OVC", 1500)], "fog": [("VV", 100)]}.get(scene, [])
        return [{"id": "KDEM", "name": "Demo Regional", "km": 14.2, "time": int(time.time()) - 900, "sky": layers[-1][0] if layers else "CLR",
                 "layers": [{"cover": c, "frac": SK._OKTAS[c], "base": round(b * 0.3048)} for c, b in layers],
                 "elev": 250, "raw": "METAR KDEM (demo data)"}]

    SK.SkyService.frame = sky_frame
    SK.SkyService.estimated = sky_estimated
    SK.SkyService.observed = sky_observed

    OM.OpenMeteo.meteogram = om_meteogram
    OM.OpenMeteo.sounding = om_sounding
    OM.OpenMeteo.elevation = om_elevation
    OM.OpenMeteo.search = om_search


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--static", help="serve this static directory (e.g. mammatus/static-dist) instead of the sources")
    args = ap.parse_args()
    os.environ.setdefault("MAMMATUS_DATA_DIR", "/tmp/mammatus-demo")
    os.environ["MAMMATUS_BACKGROUND"] = "0"
    os.environ.setdefault("MAMMATUS_ADMIN_USER", "demo")
    os.environ.setdefault("MAMMATUS_ADMIN_PASSWORD", "synthetic-weather-42")
    os.environ.setdefault("MAMMATUS_MODELS", "hrrr,gfs,ecmwf")
    os.environ.setdefault("MAMMATUS_LOG_LEVEL", "WARNING")
    if args.static:
        os.environ["MAMMATUS_STATIC_DIR"] = str(Path(args.static).resolve())
    sys.path.insert(0, str(ROOT))
    patch()
    import uvicorn

    from mammatus.app import create_app

    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
