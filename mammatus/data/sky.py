"""Sky view: the box of atmosphere above a point, ready to draw in 3D.

For one model hour this fetches the model's own cloud water, cloud ice, rain, snow and graupel on
pressure levels (plus a handful of 2D diagnostics), crops them to the region around the point and
resamples them onto a small box: N x N columns CELL_KM apart and NZ levels DZ metres tall, measured
from the ground at the point. The box is classified into named cloud layers and packed into two
RGBA8 volumes the browser uploads as 3D textures.

GRIB messages are whole-domain, so the expensive part (download + decode) is cached per region:
every other point within a few hundred kilometres reuses it.

The same box can be built without model cloud water, from layer cloud fractions alone (the quick
first sketch, and the Open-Meteo fallback, which is marked ``estimated``).
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import math
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path

import numpy as np

from .derive import NotAvailable
from .grib import Grid, Record, W, lambert_constants, lambert_forward, register_grid, select
from .http import FetchError, fetch_ranges
from .models import REGISTRY, parse_run

log = logging.getLogger("mammatus.sky")

N = 40            # columns per side
NZ = 64           # levels
DZ = 250.0        # metres per level
CELL_KM = 3.0     # column spacing
ZTOP = NZ * DZ    # 16 km
ZC = (np.arange(NZ, dtype=np.float32) + 0.5) * DZ   # level centres, metres above the point's ground

RD, G0 = 287.04, 9.80665
MAGIC = b"MMS1"
SPECIES = ("cw", "ci", "rw", "sn", "gr")
EA = ("entire atmosphere", "entire atmosphere (considered as a single layer)")

GENERA = {
    "Fg": "Fog", "St": "Stratus", "Sc": "Stratocumulus", "Cu": "Cumulus", "TCu": "Towering cumulus",
    "Cb": "Cumulonimbus", "Ns": "Nimbostratus", "Ac": "Altocumulus", "As": "Altostratus",
    "Ci": "Cirrus", "Cs": "Cirrostratus", "Cc": "Cirrocumulus",
}

_F2D = {
    "psfc": W("PRES", "surface"), "orog": W("HGT", "surface"),
    "t2m": W("TMP", "2 m above ground"), "d2m": W("DPT", "2 m above ground"),
    "cape": W("CAPE", "surface"), "pbl": W("HPBL", "surface"),
    "refc": W("REFC", EA), "vis": W("VIS", "surface"),
    "lcc": W("LCDC", "low cloud layer"), "mcc": W("MCDC", "middle cloud layer"),
    "hcc": W("HCDC", "high cloud layer"), "tcc": W("TCDC", EA),
    "blcc": W("TCDC", "boundary layer cloud layer", "any"),
}
_F2D_CAM = {
    **_F2D, "cbase": W("HGT", "cloud base"), "ctop": W("HGT", "cloud top"), "ltng": W("LTNG", "entire atmosphere"),
}
_NEAREST = {"cbase", "ctop"}     # fields with holes: never blend across them
T_LEVELS = (1000, 925, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100)
W_LEVELS = (925, 850, 700, 500, 300)


@dataclass(frozen=True)
class SkyModel:
    id: str
    product3d: str | None            # file holding the pressure-level fields (None: the default file)
    species: dict                    # cw/ci/rw/sn/gr -> GRIB variable
    fields2d: dict
    core: int                        # region size in grid cells
    halo: int
    frac3d: str | None = None        # cloud fraction on pressure levels, where the model has it
    resolved: bool = True            # convection-allowing: cloud water is either there or not


SKY_MODELS = {
    "hrrr": SkyModel("hrrr", "prs", {"cw": "CLMR", "ci": "CIMIXR", "rw": "RWMR", "sn": "SNMR", "gr": "GRLE"},
                     _F2D_CAM, 128, 28),
    "rrfs": SkyModel("rrfs", "prslev", {"cw": "CLMR", "ci": "ICMR", "rw": "RWMR", "sn": "SNMR", "gr": "GRLE"},
                     _F2D_CAM, 128, 28),
    "gfs": SkyModel("gfs", None, {"cw": "CLMR", "ci": "ICMR", "rw": "RWMR", "sn": "SNMR", "gr": "GRLE"},
                    _F2D, 16, 6, frac3d="TCDC", resolved=False),
}


# --------------------------------------------------------------------------- small maths

def smoothstep(a: float, b: float, x):
    t = np.clip((np.asarray(x, dtype=np.float32) - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def std_temperature(z_m, t_sfc: float = 288.15):
    """Standard-atmosphere temperature (K) at height z above the surface, from a surface value."""
    return np.maximum(t_sfc - 0.0065 * np.asarray(z_m, dtype=np.float32), 216.65)


def grid_index(grid: Grid, lat, lon):
    """Fractional (i, j) array indices of lat/lon on a model grid."""
    s = grid.spec
    if s["type"] == "latlon":
        i = ((np.asarray(lon, dtype=np.float64) - s["lo1"]) % 360.0) / abs(s["dlon"])
        if s["dlon"] < 0:
            i = (s["ni"] - i) % s["ni"]
        j = (np.asarray(lat, dtype=np.float64) - s["la1"]) / s["dlat"]
        return i, j
    c = _lambert(grid)
    return lambert_forward(lat, lon, s, c)


_LAMBERT: dict[str, dict] = {}


def _lambert(grid: Grid) -> dict:
    c = _LAMBERT.get(grid.id)
    if c is None:
        c = _LAMBERT[grid.id] = lambert_constants(grid.spec)
    return c


def _wraps(grid: Grid) -> bool:
    s = grid.spec
    return s["type"] == "latlon" and abs(abs(s["dlon"]) * s["ni"] - 360.0) < 1e-6


@dataclass
class Region:
    """A rectangle of model grid cells around a tile, with a halo wide enough for any box inside the tile."""

    key: str
    i0: int
    j0: int
    ii: np.ndarray
    jj: np.ndarray
    ni: int
    wrap: bool


def region_for(grid: Grid, lat: float, lon: float, core: int, halo: int) -> Region:
    fi, fj = grid_index(grid, lat, lon)
    fi, fj = float(fi), float(fj)
    ni, nj = grid.ni, grid.nj
    wrap = _wraps(grid)
    # the box must sit inside a limited-area grid; a global grid only runs out at the poles
    margin = 4 if wrap else halo - 6
    inside_i = wrap or margin <= fi <= ni - 1 - margin
    if not inside_i or not (margin <= fj <= nj - 1 - margin):
        raise NotAvailable("This point is outside the model's domain")
    ti, tj = int(fi // core), int(fj // core)
    i0, i1 = ti * core - halo, (ti + 1) * core + halo
    j0, j1 = max(0, tj * core - halo), min(nj, (tj + 1) * core + halo)
    if wrap:
        ii = np.arange(i0, i1) % ni
    else:
        i0, i1 = max(0, i0), min(ni, i1)
        ii = np.arange(i0, i1)
    return Region(f"{ti}_{tj}", i0, j0, ii, np.arange(j0, j1), ni, wrap)


def box_targets(grid: Grid, reg: Region, lat: float, lon: float):
    """Fractional region indices of the N x N box columns (row = north, column = east)."""
    off = (np.arange(N, dtype=np.float64) - (N - 1) / 2.0) * CELL_KM
    east, north = np.meshgrid(off, off)
    lats = lat + north / 111.195
    lons = lon + east / (111.195 * max(0.05, math.cos(math.radians(lat))))
    fi, fj = grid_index(grid, lats, lons)
    ri = (fi - reg.i0) % reg.ni if reg.wrap else fi - reg.i0
    return ri.astype(np.float32), (fj - reg.j0).astype(np.float32)


def bilinear(a: np.ndarray, ri: np.ndarray, rj: np.ndarray, nearest: bool = False) -> np.ndarray:
    """Sample a[..., h, w] at fractional (rj, ri)."""
    h, w = a.shape[-2:]
    if nearest:
        i = np.clip(np.rint(ri).astype(np.intp), 0, w - 1)
        j = np.clip(np.rint(rj).astype(np.intp), 0, h - 1)
        return a[..., j, i]
    i0 = np.clip(np.floor(ri).astype(np.intp), 0, w - 2)
    j0 = np.clip(np.floor(rj).astype(np.intp), 0, h - 2)
    fx = np.clip(ri - i0, 0.0, 1.0).astype(np.float32)
    fy = np.clip(rj - j0, 0.0, 1.0).astype(np.float32)
    top = a[..., j0, i0] * (1 - fx) + a[..., j0, i0 + 1] * fx
    bot = a[..., j0 + 1, i0] * (1 - fx) + a[..., j0 + 1, i0 + 1] * fx
    return (top * (1 - fy) + bot * fy).astype(np.float32)


# --------------------------------------------------------------------------- the box

@dataclass
class Box:
    """Everything known about the air above the point, on the N x N x NZ box."""

    liq: np.ndarray      # cloud liquid water, g/m3            [NZ, N, N]
    ice: np.ndarray      # cloud ice (incl. cold snow aloft)
    rain: np.ndarray
    snow: np.ndarray     # falling snow and graupel
    frac: np.ndarray     # cloud fraction 0..1
    cum: np.ndarray      # 0 = stratiform sheet, 1 = cumuliform heaps
    t: np.ndarray        # temperature at the point, K          [NZ]
    u: np.ndarray        # wind at the point, m/s (east, north) [NZ]
    v: np.ndarray
    terrain: np.ndarray  # ground height relative to the point, m [N, N]
    elev: float = 0.0    # ground height at the point, m above sea level
    sfc: dict = field(default_factory=dict)        # point diagnostics
    maps: dict = field(default_factory=dict)       # [N, N] diagnostics (cape, refc, ltng, cbase, ctop ...)


def empty_box(t_sfc: float = 288.15, elev: float = 0.0) -> Box:
    z = lambda: np.zeros((NZ, N, N), np.float32)  # noqa: E731
    return Box(z(), z(), z(), z(), z(), z(), std_temperature(ZC, t_sfc).astype(np.float32),
               np.zeros(NZ, np.float32), np.zeros(NZ, np.float32), np.zeros((N, N), np.float32), elev)


def add_slab(box: Box, base: float, top: float, frac, *, liq: float = 0.0, ice: float = 0.0, cum: float = 0.0,
             ramp: bool = False) -> None:
    """Fill a cloud layer between two heights. ``frac`` is a number or an [N, N] map."""
    if top - base < 60:
        return
    frac = np.broadcast_to(np.asarray(frac, np.float32), (N, N))
    for k in range(NZ):
        lo, hi = ZC[k] - DZ / 2, ZC[k] + DZ / 2
        cover = (min(hi, top) - max(lo, base)) / DZ
        if cover <= 0.2:
            continue
        hf = np.clip((ZC[k] - base) / max(top - base, 1.0), 0.0, 1.0)
        gain = (0.35 + 0.65 * hf) if ramp else 1.0
        new = frac > box.frac[k]
        box.frac[k] = np.maximum(box.frac[k], frac)
        box.liq[k] = np.where(new, liq * gain, box.liq[k])
        box.ice[k] = np.where(new, ice, box.ice[k])
        box.cum[k] = np.where(new, cum, box.cum[k])


def add_precip(box: Box, top: float, rate_mmh, *, snow: bool = False, floor: float = 0.0) -> None:
    """Fill a shaft of falling rain or snow from ``top`` down to ``floor`` (0 = reaches the ground)."""
    rate = np.broadcast_to(np.asarray(rate_mmh, np.float32), (N, N))
    wc = 0.072 * np.power(np.maximum(rate, 0.0), 0.88)   # Marshall-Palmer water content, g/m3
    if snow:
        wc = wc * 2.2                                    # snow falls slower: more of it in the air
    target = box.snow if snow else box.rain
    for k in range(NZ):
        if ZC[k] > top or ZC[k] < floor:
            continue
        fade = 1.0 if floor <= 0 else float(np.clip((ZC[k] - floor) / max(top - floor, 1.0) * 2.0, 0.0, 1.0))
        target[k] = np.maximum(target[k], wc * fade)


# --------------------------------------------------------------------------- cloud layers

def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    out, start = [], None
    for k, m in enumerate(mask):
        if m and start is None:
            start = k
        elif not m and start is not None:
            out.append((start, k - 1))
            start = None
    if start is not None:
        out.append((start, len(mask) - 1))
    return out


def classify(cover, liq, ice, rain, snow, cum, t, sfc: dict, base0: float | None = None,
             top1: float | None = None) -> list[dict]:
    """Name the cloud layers in one column.

    ``cover`` is the fraction of sky covered at each level; ``liq``/``ice`` the in-cloud water there
    (g/m3); ``cum`` how cumuliform the cloud is; ``t`` temperature (K). ``base0``/``top1`` are the
    model's own lowest cloud base and highest cloud top (m above ground), which are finer than the
    level spacing. Returns layers from the ground up.
    """
    cover = np.asarray(cover, np.float32)
    wc = np.asarray(liq, np.float32) + np.asarray(ice, np.float32)
    runs = _runs((cover > 0.06) & (wc > 1e-4))
    # a one-level gap inside deep cloud is noise, not two clouds
    merged: list[list[int]] = []
    for a, b in runs:
        if merged and a - merged[-1][1] <= 2 and (merged[-1][1] - merged[-1][0] >= 4 or b - a >= 4):
            merged[-1][1] = b
        else:
            merged.append([a, b])
    # a deep shield spanning the middle and high levels reads as two layers: altostratus under cirrostratus
    split: list[list[int]] = []
    for a, b in merged:
        if 2000 <= ZC[a] < 6000 and t[a] > 243.0 and (b - a) * DZ >= 4500:
            cold = [k for k in range(a, b + 1) if t[k] <= 238.0]
            k = min(max(cold[0] if cold else (a + b) // 2, a + 6), b - 5)
            split += [[a, k - 1], [k, b]]
        else:
            split.append([a, b])
    merged = split
    cape = float(sfc.get("cape") or 0.0)
    refc = float(sfc.get("refc") if sfc.get("refc") is not None else -99.0)
    ltng = float(sfc.get("ltng") or 0.0)
    vis = sfc.get("vis")
    layers = []
    for n, (a, b) in enumerate(merged):
        sl = slice(a, b + 1)
        base = float(ZC[a] - DZ / 2)
        top = float(ZC[b] + DZ / 2)
        if n == 0 and base0 is not None and math.isfinite(base0) and abs(base0 - base) <= 450:
            base = max(0.0, float(base0))
        if n == len(merged) - 1 and top1 is not None and math.isfinite(top1) and abs(top1 - top) <= 450:
            top = float(top1)
        top = max(top, base + 100.0)
        depth = top - base
        cov = float(np.max(cover[sl]))
        w = cover[sl] + 1e-6
        # share of the layer's depth that is ice cloud (by mass, liquid low down would always win)
        icef = float(np.sum((ice[sl] >= liq[sl]) * w) / np.sum(w))
        conv = float(np.sum(cum[sl] * w) / np.sum(w))
        t_base, t_top = float(t[a]), float(t[b])
        top_ice = float(ice[b] / (ice[b] + liq[b] + 1e-9))
        rain_g, snow_g = float(rain[0]), float(snow[0])
        below = slice(max(0, a - 6), a) if a > 0 else slice(0, 1)   # the 1.5 km under this layer
        fall = float(np.max(rain[below]) + np.max(snow[below])) if a > 0 else rain_g + snow_g
        if n == 0 and rain_g + snow_g > 3e-3:
            precip = "snow" if snow_g > rain_g else "rain"
        elif fall > 3e-3 and a > 0:
            precip = "virga"
        else:
            precip = "none"

        species = None
        deep = depth >= 4500 and base < 3000 and top >= 6000
        # a stratiform rain shield can be deep and reflective too: it needs lightning or convection
        if deep and (ltng > 0.25 or (refc >= 45 and conv > 0.4) or (conv > 0.6 and cape > 800 and t_top < 243)):
            genus = "Cb"
            species = "with anvil" if (top_ice > 0.8 and top >= 8000) else None
        elif base < 2500 and depth >= 2500 and conv >= 0.55:
            genus, species = "TCu", "congestus"
        elif depth >= 2500 and base < 3000 and (cov >= 0.8 or (precip in ("rain", "snow") and cov >= 0.5)):
            genus = "Ns"
        elif base < 70 and top < 1500 and ((vis is not None and vis < 1000) or (vis is None and depth <= 500)):
            genus = "Fg"
        elif base < 2000:
            if conv >= 0.5:
                if cov < 0.7:
                    genus = "Cu"
                    species = "humilis" if depth < 600 else "mediocris" if depth < 1500 else "congestus"
                else:
                    genus = "Sc"
            else:
                genus = "St" if (conv < 0.3 and cov >= 0.85) else "Sc"
        elif icef > 0.75 or base >= 7000 or (base >= 5000 and icef > 0.5):
            if cov >= 0.8 and depth >= 700:
                genus = "Cs"
            elif conv >= 0.65 and depth < 700:
                genus = "Cc"
            else:
                genus = "Ci"
        else:
            genus = "As" if (cov >= 0.8 and conv < 0.5 and depth >= 450) else "Ac"
        layers.append({
            "genus": genus, "name": GENERA[genus], "species": species,
            "base": round(base), "top": round(top), "cover": round(cov, 2),
            "phase": "ice" if icef > 0.75 else "mixed" if icef > 0.2 else "liquid",
            "tBase": round(t_base, 1), "tTop": round(t_top, 1), "precip": precip, "conv": round(conv, 2),
        })
    return layers


# --------------------------------------------------------------------------- packing

def _fill_nearest_h(vals: np.ndarray, valid: np.ndarray, passes: int = 6) -> tuple[np.ndarray, np.ndarray]:
    """Spread values sideways into invalid cells ([..., N, N])."""
    vals, valid = vals.copy(), valid.copy()
    for _ in range(passes):
        if valid.all():
            break
        acc = np.zeros_like(vals)
        cnt = np.zeros(vals.shape, np.float32)
        for ax, sh in ((-1, 1), (-1, -1), (-2, 1), (-2, -1)):
            v = np.roll(valid, sh, axis=ax)
            x = np.roll(vals, sh, axis=ax)
            # no wrap-around: the rolled-in edge is not a neighbour
            edge = [slice(None)] * vals.ndim
            edge[ax] = 0 if sh == 1 else -1
            v[tuple(edge)] = False
            acc += np.where(v, x, 0.0)
            cnt += v
        new = ~valid & (cnt > 0)
        vals = np.where(new, acc / np.maximum(cnt, 1.0), vals)
        valid = valid | new
    return vals, valid


def cloud_bounds(box: Box) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per voxel: base and top (m) of the cloud layer it belongs to, and whether it is in cloud.

    The model's own lowest base and highest top replace the level-quantized ones where they agree.
    """
    cloud = (box.frac > 0.06) & ((box.liq + box.ice) > 1e-4)
    base = np.zeros((NZ, N, N), np.float32)
    top = np.zeros((NZ, N, N), np.float32)
    cur = np.zeros((N, N), np.float32)
    prev = np.zeros((N, N), bool)
    first = np.ones((N, N), bool)          # still looking for the lowest layer
    cb = box.maps.get("cbase")
    for k in range(NZ):
        c = cloud[k]
        start = c & ~prev
        b = np.full((N, N), ZC[k] - DZ / 2, np.float32)
        if cb is not None:
            ok = start & first & np.isfinite(cb) & (np.abs(cb - b) <= 450)
            b = np.where(ok, np.maximum(cb, 0.0), b)
        cur = np.where(start, b, cur)
        first &= ~start
        base[k] = np.where(c, cur, 0.0)
        prev = c
    ct = box.maps.get("ctop")
    prev[:] = False
    first[:] = True
    for k in range(NZ - 1, -1, -1):
        c = cloud[k]
        start = c & ~prev
        tp = np.full((N, N), ZC[k] + DZ / 2, np.float32)
        if ct is not None:
            ok = start & first & np.isfinite(ct) & (np.abs(ct - tp) <= 450)
            tp = np.where(ok, ct, tp)
        cur = np.where(start, tp, cur)
        first &= ~start
        top[k] = np.where(c, cur, 0.0)
        prev = c
    top = np.where(cloud, np.maximum(top, base + 120.0), 0.0)
    return base, top, cloud


def _encode_wc(a: np.ndarray) -> np.ndarray:
    """g/m3 -> one byte, logarithmic over 1e-4 .. 3.2 (0 = none)."""
    with np.errstate(divide="ignore"):
        x = (np.log10(np.maximum(a, 1e-9)) + 4.0) / 4.5
    code = 1.0 + np.rint(253.0 * np.clip(x, 0.0, 1.0))
    return np.where(a >= 1e-4, code, 0.0).astype(np.uint8)


def decode_wc(code: np.ndarray) -> np.ndarray:
    c = code.astype(np.float32)
    return np.where(c > 0, np.power(10.0, (c - 1.0) / 253.0 * 4.5 - 4.0), 0.0).astype(np.float32)


def pack(box: Box, header: dict) -> bytes:
    """Classify the box and encode it for the browser."""
    base, top, cloud = cloud_bounds(box)

    # ---- named layers, from the sky within ~13 km of the point
    c0, c1 = N // 2 - 4, N // 2 + 5
    near = (slice(None), slice(c0, c1), slice(c0, c1))
    cm = cloud[near]
    wsum = np.maximum(cm.sum(axis=(1, 2)), 1)
    cover = (box.frac[near] * cm).mean(axis=(1, 2))
    mean_in = lambda a: (a[near] * cm).sum(axis=(1, 2)) / wsum  # noqa: E731
    mid = N // 2
    cb, ct = box.maps.get("cbase"), box.maps.get("ctop")
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            base0 = float(np.nanmedian(cb[c0:c1, c0:c1])) if cb is not None else None
            top1 = float(np.nanmedian(ct[c0:c1, c0:c1])) if ct is not None else None
    sfc = dict(box.sfc)
    for k in ("cape", "refc", "ltng"):
        m = box.maps.get(k)
        if m is not None:
            sfc[k] = round(float(np.nanmax(m[c0:c1, c0:c1])), 2)
    layers = classify(cover, mean_in(box.liq), mean_in(box.ice), box.rain[near].mean(axis=(1, 2)),
                      box.snow[near].mean(axis=(1, 2)), mean_in(box.cum), box.t, sfc, base0, top1)

    # ---- storm cells in the box (for lightning) and how strongly mammatus should show
    cells = []
    refc, ltng = box.maps.get("refc"), box.maps.get("ltng")
    deep = (cloud.sum(axis=0) * DZ >= 5000) & (cloud[: int(3000 / DZ)].any(axis=0))
    score = np.zeros((N, N), np.float32)
    low = slice(0, int(6000 / DZ))
    col_conv = (box.cum[low] * cloud[low]).sum(axis=0) / np.maximum(cloud[low].sum(axis=0), 1)
    capem = box.maps.get("cape")
    convective = np.maximum(smoothstep(0.35, 0.6, col_conv), smoothstep(200.0, 1200.0, np.nan_to_num(capem)) if capem is not None else 0.0)
    if refc is not None:
        score += smoothstep(40.0, 58.0, np.nan_to_num(refc, nan=-99.0)) * convective
    if ltng is not None:
        score += smoothstep(0.15, 3.0, np.nan_to_num(ltng))
    score *= deep
    s = score.copy()
    while len(cells) < 10:
        j, i = np.unravel_index(int(np.argmax(s)), s.shape)
        if s[j, i] < 0.08:
            break
        col = np.nonzero(cloud[:, j, i])[0]
        cells.append({"x": round((i - (N - 1) / 2) * CELL_KM, 1), "y": round((j - (N - 1) / 2) * CELL_KM, 1),
                      "base": round(float(base[col[0], j, i])), "top": round(float(top[col[-1], j, i])),
                      "w": round(float(s[j, i]), 2)})
        s[max(0, j - 2):j + 3, max(0, i - 2):i + 3] = 0
    anvil = any(ly["genus"] == "Cb" for ly in layers) or bool(cells)
    mammatus = 0.0
    if anvil:
        # ice overhanging clear air below it: the underside of an anvil
        hi = slice(int(5000 / DZ), NZ)
        over = (cloud[hi] & (box.ice[hi] > box.liq[hi])).any(axis=0) & ~cloud[int(2000 / DZ):int(4500 / DZ)].any(axis=0)
        jj, ii = np.mgrid[0:N, 0:N]
        near_cell = np.zeros((N, N), bool)
        for c in cells:
            ci, cj = c["x"] / CELL_KM + (N - 1) / 2, c["y"] / CELL_KM + (N - 1) / 2
            near_cell |= (ii - ci) ** 2 + (jj - cj) ** 2 <= (30.0 / CELL_KM) ** 2
        share = float((over & near_cell).sum()) / max(1.0, float(near_cell.sum()))
        mammatus = float(np.clip(share * 3.0, 0.0, 1.0)) * float(smoothstep(0.25, 0.8, float(score.max())))

    # ---- spread cloud properties past the cloud's own edge, so the texture filter never blends
    # them with "no cloud"; the fraction (and the base/top cut-offs) decide where cloud really is
    def spread(a, valid):
        up = np.roll(a, 1, axis=0); up[0] = 0
        dn = np.roll(a, -1, axis=0); dn[-1] = 0
        vu = np.roll(valid, 1, axis=0); vu[0] = False
        vd = np.roll(valid, -1, axis=0); vd[-1] = False
        out = np.where(valid, a, np.where(vu, up, np.where(vd, dn, 0.0)))
        return _fill_nearest_h(out, valid | vu | vd)

    liq, _ = spread(box.liq, cloud)
    ice, _ = spread(box.ice, cloud)
    cum, _ = spread(box.cum, cloud)
    base_f, ok = spread(base, cloud)
    top_f, _ = spread(top, cloud)
    frac = np.where(cloud, box.frac, 0.0)
    fz = np.maximum(frac, np.maximum(np.roll(frac, 1, axis=0) * (np.arange(NZ) > 0)[:, None, None],
                                     np.roll(frac, -1, axis=0) * (np.arange(NZ) < NZ - 1)[:, None, None]))
    below_ground = (ZC[:, None, None] + DZ / 2) < box.terrain[None]
    fz = np.where(below_ground, 0.0, fz)

    vol = np.stack([_encode_wc(liq), _encode_wc(ice), _encode_wc(np.where(below_ground, 0, box.rain)),
                    _encode_wc(np.where(below_ground, 0, box.snow))], axis=-1)
    aux = np.stack([
        np.rint(np.clip(fz, 0, 1) * 255), np.rint(np.clip(cum, 0, 1) * 255),
        np.rint(np.clip(base_f / ZTOP, 0, 1) * 255), np.rint(np.clip(top_f / ZTOP, 0, 1) * 255),
    ], axis=-1).astype(np.uint8)

    occ = np.maximum(fz.max(axis=(1, 2)), np.minimum(1.0, (box.rain + box.snow).max(axis=(1, 2)) * 40.0))
    rain_g = float(box.rain[0, mid - 1:mid + 1, mid - 1:mid + 1].mean())
    snow_g = float(box.snow[0, mid - 1:mid + 1, mid - 1:mid + 1].mean())
    head = {
        "v": 1, **header, "n": N, "nz": NZ, "dz": DZ, "cell": CELL_KM * 1000, "elev": round(float(box.elev)),
        "layers": layers, "sfc": {k: (None if v is None or not math.isfinite(v) else round(float(v), 2)) for k, v in sfc.items()},
        "profile": {"t": [round(float(x), 1) for x in box.t], "u": [round(float(x), 1) for x in box.u],
                    "v": [round(float(x), 1) for x in box.v]},
        "terrain": [int(x) for x in np.rint(np.clip(box.terrain, -3000, 6000)).ravel()],
        "cells": cells, "mammatus": round(mammatus, 2),
        "precip": {"kind": "none" if rain_g + snow_g < 3e-3 else "snow" if snow_g > rain_g else "rain",
                   "wc": round(rain_g + snow_g, 3)},
        "occ": [round(float(x), 2) for x in occ],
    }
    hjson = json.dumps(head, separators=(",", ":")).encode()
    hjson += b" " * (-len(hjson) % 4)
    raw = b"".join([MAGIC, len(hjson).to_bytes(4, "little"), hjson, vol.tobytes(), aux.tobytes()])
    return gzip.compress(raw, compresslevel=6, mtime=0)


def unpack(blob: bytes) -> tuple[dict, np.ndarray, np.ndarray]:
    raw = gzip.decompress(blob) if blob[:2] == b"\x1f\x8b" else blob
    if raw[:4] != MAGIC:
        raise ValueError("not a sky frame")
    hlen = int.from_bytes(raw[4:8], "little")
    head = json.loads(raw[8:8 + hlen])
    n, nz = head["n"], head["nz"]
    off = 8 + hlen
    size = nz * n * n * 4
    vol = np.frombuffer(raw, np.uint8, size, off).reshape(nz, n, n, 4)
    aux = np.frombuffer(raw, np.uint8, size, off + size).reshape(nz, n, n, 4)
    return head, vol, aux


# --------------------------------------------------------------------------- boxes from layer cloud cover

def _cum_from_cape(cape) -> np.ndarray:
    return 0.2 + 0.7 * smoothstep(60.0, 900.0, cape)


def box_from_fractions(lcc, mcc, hcc, *, t2m: float = 288.15, elev: float = 0.0, cbase=None, ctop=None,
                       cape=0.0, pbl=None) -> Box:
    """A first sketch from low/middle/high cloud cover alone (fractions 0..1, numbers or [N, N] maps)."""
    box = empty_box(t2m, elev)
    cum = _cum_from_cape(cape)
    lcc, mcc, hcc = (np.broadcast_to(np.nan_to_num(np.asarray(x, np.float32)), (N, N)) for x in (lcc, mcc, hcc))
    if float(lcc.max()) > 0.04:
        b = float(np.nanmedian(cbase)) if cbase is not None and np.isfinite(cbase).any() else 900.0
        b = float(np.clip(b, 0.0, 2400.0))
        depth = 500.0 if pbl is None else float(np.clip(np.nanmedian(pbl) - b + 250.0, 300.0, 1400.0))
        add_slab(box, b, b + depth, lcc, liq=0.28, cum=cum, ramp=True)
    if float(mcc.max()) > 0.04:
        add_slab(box, 3600.0, 4500.0, mcc, liq=0.12, ice=0.01, cum=np.minimum(cum, 0.6))
    if float(hcc.max()) > 0.04:
        t = float(np.nanmedian(ctop)) if ctop is not None and np.isfinite(ctop).any() else 0.0
        t = float(np.clip(t if t > 7000 else 9800.0, 8000.0, 13500.0))
        add_slab(box, t - 1200.0, t, hcc, ice=0.02, cum=0.15)
    return box


def box_from_profile(z_m, cover, t_k, *, u=None, v=None, elev: float = 0.0, cape: float = 0.0,
                     rain_mmh: float = 0.0, snow_mmh: float = 0.0, sfc: dict | None = None) -> Box:
    """A horizontally uniform box from one column of cloud cover by height (the Open-Meteo fallback).

    ``z_m`` are heights above sea level of the profile levels, ``cover`` cloud cover there (0..1).
    """
    z = np.asarray(z_m, np.float64) - elev
    order = np.argsort(z)
    z = z[order]

    def on_grid(a, fill=None):
        a = np.asarray(a, np.float64)[order]
        ok = np.isfinite(a) & np.isfinite(z)
        if ok.sum() < 2:
            return None
        return np.interp(ZC, z[ok], a[ok], left=a[ok][0] if fill is None else fill, right=a[ok][-1] if fill is None else fill).astype(np.float32)

    t = on_grid(t_k)
    box = empty_box(float(t[0]) if t is not None else 288.15, elev)
    if t is not None:
        box.t = t
    for name, a in (("u", u), ("v", v)):
        if a is not None:
            g = on_grid(a)
            if g is not None:
                setattr(box, name, g)
    cov = on_grid(cover, fill=0.0)
    if cov is None:
        cov = np.zeros(NZ, np.float32)
    cov = np.clip(cov, 0.0, 1.0)
    cum_low = float(_cum_from_cape(cape))
    for k in range(NZ):
        c = float(cov[k])
        if c < 0.06:
            continue
        tk = float(box.t[k])
        icef = float(np.clip((258.0 - tk) / 18.0, 0.0, 1.0))
        box.frac[k] = c
        box.liq[k] = (1 - icef) * (0.25 if ZC[k] < 2500 else 0.12)
        box.ice[k] = icef * 0.025
        # low cloud heaps up when the air is unstable; the lapse rate decides aloft
        if ZC[k] < 3000:
            cum = cum_low
        else:
            gamma = (float(box.t[max(k - 2, 0)]) - float(box.t[min(k + 2, NZ - 1)])) / (4 * DZ / 1000.0)
            cum = float(0.1 + 0.6 * smoothstep(6.2, 8.2, gamma))
        box.cum[k] = cum * (1.0 - 0.7 * icef)
    cloudy = np.nonzero(cov >= 0.06)[0]
    if len(cloudy) and (rain_mmh > 0.02 or snow_mmh > 0.02):
        # precipitation falls from the lowest deep layer
        add_precip(box, float(ZC[cloudy[0]]) + DZ, max(rain_mmh, 0.0))
        if snow_mmh > 0.02:
            add_precip(box, float(ZC[cloudy[0]]) + DZ, snow_mmh, snow=True)
    box.sfc = dict(sfc or {})
    box.sfc.setdefault("cape", cape)
    return box


# --------------------------------------------------------------------------- synthetic skies (demo server, tests)

SCENES = ("fair", "storm", "cirro", "stratus", "front", "decks", "towers", "snow", "clear", "fog")


def _fbm2(seed: int, scale: float, shift=(0.0, 0.0)) -> np.ndarray:
    """Smooth [N, N] noise in 0..1."""
    rng = np.random.default_rng(seed)
    j, i = np.mgrid[0:N, 0:N].astype(np.float32)
    acc = np.zeros((N, N), np.float32)
    for o in range(4):
        a, b, ph = rng.uniform(0.6, 1.4, 2) * scale * 2 ** o, rng.uniform(0.6, 1.4, 2) * scale * 2 ** o, rng.uniform(0, 6.28, 2)
        acc += (np.sin(a[0] * (i + shift[0]) + b[0] * (j + shift[1]) + ph[0]) * np.cos(a[1] * (j + shift[1]) - b[1] * (i + shift[0]) + ph[1])) * 0.55 ** o
    return np.clip(acc * 0.5 + 0.5, 0.0, 1.0)


def synth_box(scene: str, drift: float = 0.0, lat: float = 35.0) -> Box:
    """A made-up but physically laid-out sky of each kind. ``drift`` (hours) moves the weather east."""
    warm = scene not in ("snow", "front")
    box = empty_box(296.0 if scene in ("storm", "towers", "fair") else 271.0 if scene == "snow" else 284.0, 250.0)
    j, i = np.mgrid[0:N, 0:N].astype(np.float32)
    x, y = (i - (N - 1) / 2) * CELL_KM, (j - (N - 1) / 2) * CELL_KM
    box.terrain = (140.0 * (_fbm2(7, 0.09) - 0.45) + 380.0 * np.clip(_fbm2(11, 0.045) - 0.55, 0, 1) * np.clip((y + 20) / 40, 0, 1)).astype(np.float32)
    box.terrain -= box.terrain[N // 2, N // 2]
    box.u = (6.0 + 26.0 * smoothstep(0.0, 11000.0, ZC)).astype(np.float32)
    box.v = (2.0 + 6.0 * np.sin(ZC / 4000.0)).astype(np.float32)
    sh = (drift * 6.0, drift * 1.5)
    sfc = {"t2m": float(box.t[0]) + 1.5, "d2m": float(box.t[0]) - 3.0, "psfc": 985.0, "vis": 24000.0, "cape": 0.0, "pbl": 900.0}
    maps: dict = {}
    if scene == "fair":
        add_slab(box, 1250.0, 2100.0, 0.16 + 0.34 * _fbm2(3, 0.11, sh), liq=0.45, cum=1.0, ramp=True)
        add_slab(box, 9500.0, 10300.0, 0.6 * smoothstep(0.35, 0.8, _fbm2(5, 0.05, sh)), ice=0.018, cum=0.15)
        sfc.update(cape=450.0, pbl=1500.0)
        maps["cbase"] = np.full((N, N), 1250.0, np.float32)
    elif scene == "towers":
        add_slab(box, 1100.0, 2000.0, 0.2 + 0.3 * _fbm2(3, 0.11, sh), liq=0.5, cum=1.0, ramp=True)
        for cx, cy, r, top in ((-14.0, 6.0, 5.0, 6500.0), (12.0, -10.0, 4.0, 5200.0), (30.0, 18.0, 6.0, 7400.0)):
            d = np.exp(-(((x - cx - sh[0]) ** 2 + (y - cy) ** 2) / (2 * r * r)))
            add_slab(box, 1100.0, top, np.clip(d * 1.4, 0, 1) * (d > 0.25), liq=0.9, cum=1.0, ramp=True)
        sfc.update(cape=1400.0, pbl=1400.0)
        maps["cbase"] = np.full((N, N), 1100.0, np.float32)
    elif scene == "storm":
        cx, cy = -8.0 + sh[0] * 0.5, 4.0
        r2 = (x - cx) ** 2 + (y - cy) ** 2
        tower = np.exp(-r2 / (2 * 7.0 ** 2))
        add_slab(box, 1000.0, 1900.0, 0.18 + 0.3 * _fbm2(3, 0.11, sh), liq=0.5, cum=1.0, ramp=True)
        add_slab(box, 900.0, 9800.0, np.clip(tower * 1.6, 0, 1) * (tower > 0.2), liq=1.4, cum=1.0, ramp=True)
        # glaciated top and an anvil streaming downwind (east)
        ax = (x - cx) / 44.0
        anvil = np.clip(np.exp(-((y - cy) / (9.0 + 16.0 * np.clip(ax, 0, 1))) ** 2) * smoothstep(-0.22, 0.05, ax) * (1 - smoothstep(0.75, 1.15, ax)), 0, 1)
        add_slab(box, 9000.0, 13000.0, np.maximum(anvil, np.clip(tower * 1.6, 0, 1) * (tower > 0.2)), ice=0.35, cum=0.1)
        for k in range(NZ):
            if 6500.0 < ZC[k] < 9800.0:
                core = box.frac[k] * (tower > 0.2)
                box.ice[k] = np.where(core > 0, 0.5, box.ice[k])
        add_precip(box, 5000.0, 38.0 * np.clip(tower * 1.3 - 0.25, 0, 1))
        refc = 62.0 * np.clip(tower * 1.25, 0, 1) - 5.0
        maps.update(refc=refc.astype(np.float32), ltng=(4.0 * np.clip(tower - 0.4, 0, 1)).astype(np.float32),
                    cbase=np.full((N, N), 1000.0, np.float32))
        sfc.update(cape=2800.0, refc=float(refc[N // 2, N // 2]), pbl=1300.0, vis=9000.0)
    elif scene == "cirro":
        add_slab(box, 8600.0, 10100.0, 0.86 + 0.14 * _fbm2(5, 0.04, sh), ice=0.012, cum=0.08)
        add_slab(box, 4100.0, 4600.0, 0.55 * smoothstep(0.4, 0.75, _fbm2(9, 0.08, sh)), liq=0.1, cum=0.85)
    elif scene == "stratus":
        add_slab(box, 320.0, 820.0, 0.9 + 0.1 * _fbm2(3, 0.05, sh), liq=0.3, cum=0.1)
        add_precip(box, 500.0, 0.25)
        sfc.update(vis=6000.0, pbl=500.0)
        maps["cbase"] = np.full((N, N), 320.0, np.float32)
    elif scene in ("front", "snow"):
        add_slab(box, 450.0, 9200.0, 0.92 + 0.08 * _fbm2(3, 0.05, sh), liq=0.35, cum=0.12)
        frz = 0.0 if scene == "snow" else 2300.0
        for k in range(NZ):
            cold = float(np.clip((ZC[k] - frz) / 2500.0, 0.0, 1.0))
            box.ice[k] = np.where(box.frac[k] > 0, 0.12 * cold, 0.0)
            box.liq[k] = box.liq[k] * (1 - 0.85 * cold)
        rate = 2.5 + 5.0 * _fbm2(13, 0.06, sh)
        if scene == "snow":
            add_precip(box, 6000.0, rate * 0.6, snow=True)
        else:
            add_precip(box, frz, rate)
            add_precip(box, 6500.0, rate * 0.5, snow=True, floor=frz)
        sfc.update(vis=4000.0, pbl=600.0)
        maps["cbase"] = np.full((N, N), 450.0, np.float32)
    elif scene == "decks":
        add_slab(box, 1500.0, 2000.0, 0.72 + 0.28 * _fbm2(3, 0.09, sh), liq=0.3, cum=0.75)
        add_slab(box, 3900.0, 4500.0, 0.5 + 0.4 * _fbm2(9, 0.08, sh), liq=0.12, ice=0.005, cum=0.8)
        add_slab(box, 7800.0, 8400.0, 0.4 * smoothstep(0.3, 0.8, _fbm2(5, 0.06, sh)), ice=0.012, cum=0.7)
        add_precip(box, 3900.0, 0.5 * smoothstep(0.6, 0.9, _fbm2(21, 0.07, sh)), floor=2300.0)
    elif scene == "fog":
        add_slab(box, 0.0, 260.0, 0.95, liq=0.18, cum=0.05)
        add_slab(box, 9200.0, 9900.0, 0.35 * smoothstep(0.4, 0.8, _fbm2(5, 0.05, sh)), ice=0.012, cum=0.15)
        sfc.update(vis=350.0, pbl=200.0)
        maps["cbase"] = np.zeros((N, N), np.float32)
    if not warm and scene == "snow":
        sfc.update(t2m=270.5, d2m=269.5)
    under = (ZC[:, None, None] + DZ / 2) < box.terrain[None]
    for a in (box.liq, box.ice, box.rain, box.snow, box.frac):
        a[under] = 0.0
    maps.setdefault("cape", np.full((N, N), sfc.get("cape", 0.0), np.float32))
    box.sfc, box.maps = sfc, maps
    return box


# --------------------------------------------------------------------------- boxes from model cloud water

@dataclass
class Block:
    """One model hour cropped to a region: the cached, expensive part."""

    grid: Grid
    region: Region
    f2: dict                                  # name -> [h, w]
    levels: np.ndarray | None = None          # hPa, descending pressure
    q: dict | None = None                     # species -> [L, h, w] kg/kg
    frac3: np.ndarray | None = None           # [L, h, w] 0..1
    tlev: np.ndarray | None = None
    t: np.ndarray | None = None               # [Lt, h, w] K
    wlev: np.ndarray | None = None
    u: np.ndarray | None = None
    v: np.ndarray | None = None


def box_from_block(blk: Block, lat: float, lon: float, sm: SkyModel) -> Box:
    ri, rj = box_targets(blk.grid, blk.region, lat, lon)
    f2 = {k: bilinear(a, ri, rj, nearest=k in _NEAREST) for k, a in blk.f2.items()}
    mid = N // 2
    c4 = (slice(mid - 1, mid + 1), slice(mid - 1, mid + 1))
    orog = f2["orog"]
    elev = float(orog[c4].mean())
    t2m = float(f2["t2m"][c4].mean())
    pct = lambda k: np.clip(np.nan_to_num(f2[k]) / 100.0, 0.0, 1.0) if k in f2 else np.zeros((N, N), np.float32)  # noqa: E731
    rel = lambda k: (f2[k] - elev) if k in f2 else None  # noqa: E731
    cbase, ctop = rel("cbase"), rel("ctop")
    cape = np.nan_to_num(f2["cape"]) if "cape" in f2 else np.zeros((N, N), np.float32)
    lcc = pct("lcc")
    if "blcc" in f2:
        lcc = np.maximum(lcc, pct("blcc"))

    if blk.q is None:
        box = box_from_fractions(lcc, pct("mcc"), pct("hcc"), t2m=t2m, elev=elev, cbase=cbase, ctop=ctop,
                                 cape=cape, pbl=f2.get("pbl"))
    else:
        box = _box_from_levels(blk, sm, ri, rj, f2, elev, lcc, cbase, cape, lon)
    box.terrain = (orog - elev).astype(np.float32)
    box.elev = elev
    box.maps = {"cape": cape, "cbase": cbase, "ctop": ctop}
    for k in ("refc", "ltng"):
        if k in f2:
            box.maps[k] = f2[k]
    point = lambda k, d=None: (float(np.nanmean(f2[k][c4])) if k in f2 and np.isfinite(f2[k][c4]).any() else d)  # noqa: E731
    box.sfc = {
        "t2m": t2m, "d2m": point("d2m"), "psfc": (point("psfc") or 101325.0) / 100.0, "vis": point("vis"),
        "cape": point("cape", 0.0), "pbl": point("pbl"), "refc": point("refc"),
        "ltng": point("ltng"), "lcc": point("lcc"), "mcc": point("mcc"), "hcc": point("hcc"), "tcc": point("tcc"),
    }
    cb = point("cbase")
    box.sfc["ceil"] = None if cb is None else cb - elev
    return box


def _box_from_levels(blk: Block, sm: SkyModel, ri, rj, f2, elev, lcc, cbase, cape, lon: float) -> Box:
    L = len(blk.levels)
    p = blk.levels.astype(np.float32) * 100.0            # Pa, descending
    lnp = np.log(p)
    q = {sp: np.maximum(bilinear(a.astype(np.float32), ri, rj), 0.0) for sp, a in blk.q.items()}
    # temperature on every hydrometeor level (it is fetched on fewer)
    tl = bilinear(blk.t.astype(np.float32), ri, rj)
    lnpt = np.log(blk.tlev.astype(np.float32) * 100.0)
    order = np.argsort(lnpt)
    t = np.empty((L, N, N), np.float32)
    for lev in range(L):
        idx = np.clip(np.searchsorted(lnpt[order], lnp[lev]), 1, len(order) - 1)
        a, b = order[idx - 1], order[idx]
        w = np.clip((lnp[lev] - lnpt[a]) / (lnpt[b] - lnpt[a]), 0.0, 1.0)
        t[lev] = tl[a] * (1 - w) + tl[b] * w
    # heights of the pressure levels: hypsometric equation, anchored at the surface
    psfc = np.nan_to_num(f2["psfc"], nan=101325.0)
    orog = f2["orog"]
    z = np.empty((L, N, N), np.float32)
    z[0] = orog + RD / G0 * 0.5 * (t[0] + f2["t2m"]) * np.log(psfc / p[0])
    for lev in range(1, L):
        z[lev] = z[lev - 1] + RD / G0 * 0.5 * (t[lev] + t[lev - 1]) * (lnp[lev - 1] - lnp[lev])
    zr = z - elev                                         # relative to the ground at the point

    def to_grid(a, edge=False):
        out = np.zeros((NZ, N, N), np.float32)
        zk = ZC[:, None, None]
        for lev in range(L - 1):
            lo, hi = zr[lev][None], zr[lev + 1][None]
            w = (zk - lo) / np.maximum(hi - lo, 1.0)
            m = (w >= 0) & (w < 1)
            out = np.where(m, a[lev][None] * (1 - w) + a[lev + 1][None] * w, out)
        if edge:
            out = np.where(zk < zr[0][None], a[0][None], out)
            out = np.where(zk >= zr[-1][None], a[-1][None], out)
        return out

    # cloudiness is decided on the model's own levels, then interpolated and sharpened, so a cloud
    # edge sits halfway between a cloudy level and a clear one instead of smearing across the gap
    cold_l = np.clip((268.0 - t) / 15.0, 0.0, 1.0)
    frac_l = smoothstep(4e-7, 4e-6, q["cw"] + q["ci"] + 0.35 * q["sn"] * cold_l)
    frac_i = to_grid(frac_l)
    tg = to_grid(t, edge=True)
    pg = np.exp(to_grid(np.broadcast_to(lnp[:, None, None], (L, N, N)), edge=True))
    rho = pg / (RD * np.maximum(tg, 150.0)) * 1000.0      # g of air per m3 ... times kg/kg = g/m3
    # Thompson microphysics files most ice aloft under "snow": where it is cold that is cloud to the eye
    cold = np.clip((268.0 - tg) / 15.0, 0.0, 1.0)
    qc, qi, qs = to_grid(q["cw"]), to_grid(q["ci"]), to_grid(q["sn"])
    qcloud_i = qi + 0.35 * qs * cold
    box = empty_box(float(f2["t2m"][N // 2, N // 2]), elev)
    inc_l = np.maximum(frac_i, 0.1)                     # interpolation toward a clear level dilutes the water
    box.liq = qc * rho / inc_l
    box.ice = qcloud_i * rho / inc_l
    box.rain = to_grid(q["rw"]) * rho
    box.snow = (qs * (1.0 - cold) + to_grid(q["gr"])) * rho
    qcl = qc + qcloud_i
    frac = smoothstep(0.3, 0.7, frac_i)
    if blk.frac3 is not None:
        f3 = np.clip(to_grid(bilinear(blk.frac3.astype(np.float32), ri, rj)), 0.0, 1.0)
        frac = np.maximum(f3, 0.6 * smoothstep(1e-6, 1e-5, qcl))
        inc = np.maximum(frac, 0.12)                      # grid mean -> in-cloud water
        box.liq, box.ice = box.liq / inc, box.ice / inc
    box.frac = frac.astype(np.float32)

    mid = N // 2
    box.t = tg[:, mid - 1:mid + 1, mid - 1:mid + 1].mean(axis=(1, 2)).astype(np.float32)
    if blk.u is not None:
        uu, vv = bilinear(blk.u.astype(np.float32), ri, rj)[:, mid, mid], bilinear(blk.v.astype(np.float32), ri, rj)[:, mid, mid]
        s = blk.grid.spec
        if s["type"] == "lambert":                        # grid-relative -> earth-relative (NCEP convention)
            alpha = _lambert(blk.grid)["n"] * math.radians(((lon - s["lov"] + 180.0) % 360.0) - 180.0)
            ca, sa = math.cos(alpha), math.sin(alpha)
            uu, vv = ca * uu + sa * vv, -sa * uu + ca * vv
        zc = zr[:, mid, mid]
        zw = np.interp(np.log(blk.wlev.astype(np.float32) * 100.0)[::-1], lnp[::-1], zc[::-1])[::-1]
        o = np.argsort(zw)
        box.u = np.interp(ZC, zw[o], uu[o]).astype(np.float32)
        box.v = np.interp(ZC, zw[o], vv[o]).astype(np.float32)

    # ---- how cumuliform: instability near the ground, lapse rate aloft, broken fields over sheets
    cum_low = _cum_from_cape(cape)[None]
    gamma = np.zeros((NZ, N, N), np.float32)
    gamma[2:-2] = (tg[:-4] - tg[4:]) / (4 * DZ / 1000.0)
    cum_hi = 0.1 + 0.6 * smoothstep(6.2, 8.2, gamma)
    zk = ZC[:, None, None]
    # cloud that grows unbroken out of the low levels (a tower) keeps its low-level character aloft
    started = np.logical_or.accumulate((box.frac > 0.3) & (zk < 2500.0), axis=0)
    broken = np.logical_or.accumulate(started & (box.frac < 0.1), axis=0)
    rooted = (started & ~broken).astype(np.float32)
    low_w = np.clip(np.maximum(1.0 - (zk - 2500.0) / 1500.0, 0.0) + 0.7 * rooted * (cum_low > 0.5), 0.0, 1.0)
    cum = cum_low * low_w + cum_hi * (1 - low_w)
    pad = np.pad(box.frac, ((0, 0), (2, 2), (2, 2)), mode="edge")
    blur = sum(pad[:, a:a + N, b:b + N] for a in range(5) for b in range(5)) / 25.0
    cum = np.clip(cum + 0.35 * np.clip(1.0 - blur, 0.0, 1.0) * (box.frac > 0.06), 0.0, 1.0)
    ice_share = box.ice / (box.ice + box.liq + 1e-9)
    box.cum = (cum * (1.0 - 0.75 * ice_share * (tg < 243.0))).astype(np.float32)

    # ---- fair-weather cumulus the model keeps sub-grid: cover in the low-cloud field, nothing resolved
    k3 = int(3000 / DZ)
    resolved_low = box.frac[:k3].max(axis=0)
    sub = np.where(resolved_low < 0.3, lcc, 0.0)
    if float(sub.max()) > 0.03:
        t2, d2 = f2["t2m"], f2.get("d2m", f2["t2m"] - 5.0)
        lcl = np.clip(125.0 * (t2 - d2), 150.0, 3000.0) + (f2["orog"] - elev)
        b = np.where(np.isfinite(cbase), cbase, lcl) if cbase is not None else lcl
        b = np.clip(b, 100.0, 2800.0)
        pbl = f2.get("pbl")
        depth = np.clip((pbl + (f2["orog"] - elev) - b + 350.0) if pbl is not None else 500.0, 300.0, 1500.0)
        for k in range(k3 + 6):
            inside = (ZC[k] + DZ / 2 > b) & (ZC[k] - DZ / 2 < b + depth) & (sub > 0.03)
            hf = np.clip((ZC[k] - b) / depth, 0.0, 1.0)
            box.frac[k] = np.where(inside, np.maximum(box.frac[k], sub), box.frac[k])
            box.liq[k] = np.where(inside, np.maximum(box.liq[k], 0.12 + 0.35 * hf), box.liq[k])
            box.cum[k] = np.where(inside, 1.0, box.cum[k])
    # nothing below the ground
    under = (zk + DZ / 2) < (f2["orog"] - elev)[None]
    for a in (box.liq, box.ice, box.rain, box.snow, box.frac):
        a[under] = 0.0
    return box


# --------------------------------------------------------------------------- observed cloud bases (METAR)

_OKTAS = {"FEW": 0.2, "SCT": 0.45, "BKN": 0.75, "OVC": 1.0, "VV": 1.0}
_metar_cache: dict = {}


async def metar_near(lat: float, lon: float, max_km: float = 70.0) -> list[dict]:
    """Cloud layers measured at the nearest airports (ceilometers see up to about 12,000 ft)."""
    from .http import get_json

    key = (round(lat * 2) / 2, round(lon * 2) / 2)
    hit = _metar_cache.get(key)
    if hit is None or time.time() - hit[0] > 300:
        box = f"{key[0] - 1.0:.2f},{key[1] - 1.3:.2f},{key[0] + 1.0:.2f},{key[1] + 1.3:.2f}"
        data = await get_json("https://aviationweather.gov/api/data/metar", params={"bbox": box, "format": "json"},
                              retries=1, timeout=15)
        hit = (time.time(), data if isinstance(data, list) else [])
        _metar_cache[key] = hit
        if len(_metar_cache) > 200:
            _metar_cache.pop(next(iter(_metar_cache)))
    out = []
    for m in hit[1]:
        try:
            mlat, mlon = float(m["lat"]), float(m["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        dy, dx = (mlat - lat) * 111.195, (mlon - lon) * 111.195 * math.cos(math.radians(lat))
        km = math.hypot(dx, dy)
        if km > max_km:
            continue
        layers = []
        for c in m.get("clouds") or []:
            cover, base = str(c.get("cover") or ""), c.get("base")
            if cover in _OKTAS and isinstance(base, (int, float)):
                layers.append({"cover": cover, "frac": _OKTAS[cover], "base": round(base * 0.3048)})
        out.append({"id": m.get("icaoId"), "name": (m.get("name") or "").split(",")[0], "km": round(km, 1),
                    "time": m.get("obsTime"), "sky": m.get("cover"), "layers": layers,
                    "elev": m.get("elev"), "raw": (m.get("rawOb") or "")[:200]})
    out.sort(key=lambda s: s["km"])
    return out[:3]


# --------------------------------------------------------------------------- service

# Open-Meteo models offered for the estimated fallback: id -> name shown in the app
ESTIMATED_MODELS = {"ecmwf_ifs025": "ECMWF", "icon_seamless": "ICON", "gem_seamless": "GEM", "best_match": "Open-Meteo"}


def _level(rec: Record) -> int | None:
    m = re.fullmatch(r"(\d+) mb", rec.level)
    return int(m.group(1)) if m else None


def _decode_crop(blob: bytes, lat: float, lon: float, core: int, halo: int):
    from .frames import _decode_locked

    d = _decode_locked(blob)
    grid = register_grid(d.grid)
    reg = region_for(grid, lat, lon, core, halo)
    return grid, reg, np.ascontiguousarray(d.values[np.ix_(reg.jj, reg.ii)])


class SkyService:
    """Builds and caches sky frames. Shares the frame service's GRIB indexes and decode pool."""

    def __init__(self, frames, runs, om, cache_dir: Path, cap_bytes: int = 2 * 1024**3):
        self.frames = frames
        self.runs = runs
        self.om = om
        self.root = Path(cache_dir) / "sky"
        self.cap = cap_bytes
        self._blocks: OrderedDict = OrderedDict()
        self._out: OrderedDict = OrderedDict()
        self._inflight: dict = {}
        self._sem = asyncio.Semaphore(3)
        self._lock = threading.Lock()
        self.stats = {"frames": 0, "blocks": 0, "bytes_downloaded": 0}

    # -- public ---------------------------------------------------------------
    async def frame(self, model_id: str, run: str, fhr: int, lat: float, lon: float, detail: int = 1) -> bytes:
        sm = SKY_MODELS.get(model_id)
        if sm is None:
            raise NotAvailable("No sky data from this model")
        lat, lon = round(lat, 3), round(lon, 3)
        key = (model_id, run, fhr, lat, lon, detail)
        hit = self._out.get(key)
        if hit is not None:
            self._out.move_to_end(key)
            return hit
        blk = await self._block(sm, run, fhr, lat, lon, detail)
        loop = asyncio.get_running_loop()
        model = REGISTRY[model_id]
        valid = (parse_run(run) + timedelta(hours=fhr)).strftime("%Y-%m-%dT%H:%M:%SZ")
        header = {"model": model_id, "source": model.short, "attribution": model.attribution, "run": run, "fhr": fhr,
                  "valid": valid, "estimated": False, "detail": detail, "lat": lat, "lon": lon}

        def build() -> bytes:
            return pack(box_from_block(blk, lat, lon, sm), header)

        out = await loop.run_in_executor(self.frames.pool, build)
        self._remember(self._out, key, out, 96)
        self.stats["frames"] += 1
        return out

    async def estimated(self, om_model: str, when: float, lat: float, lon: float) -> bytes:
        """The Open-Meteo fallback: cloud cover by height, derived from humidity rather than cloud water."""
        lat, lon = round(lat, 3), round(lon, 3)
        prof = await self.om.sky(lat, lon, om_model)
        times = prof.get("time") or []
        if not times:
            raise NotAvailable("No profile for this point")
        i = int(np.argmin(np.abs(np.asarray(times, dtype=np.float64) - when)))
        key = ("om", om_model, times[i], lat, lon)
        hit = self._out.get(key)
        if hit is not None:
            return hit
        g = lambda name: [(prof["levels"][p][name][i] if i < len(prof["levels"][p][name]) else None) for p in prof["plevels"]]  # noqa: E731
        s = lambda name: (prof["surface"][name][i] if i < len(prof["surface"].get(name, [])) else None)  # noqa: E731
        num = lambda a: np.array([np.nan if x is None else x for x in a], np.float64)  # noqa: E731
        spd, drn = num(g("wind_speed")), np.radians(num(g("wind_direction")))
        elev = float(prof.get("elevation") or 0.0)
        rain = float((s("rain") or 0.0) + (s("showers") or 0.0))
        snow_cm = float(s("snowfall") or 0.0)
        t2 = s("temperature_2m")
        sfc = {"t2m": None if t2 is None else t2 + 273.15, "d2m": None if s("dew_point_2m") is None else s("dew_point_2m") + 273.15,
               "psfc": s("surface_pressure"), "vis": s("visibility"), "cape": s("cape") or 0.0,
               "lcc": s("cloud_cover_low"), "mcc": s("cloud_cover_mid"), "hcc": s("cloud_cover_high"), "tcc": s("cloud_cover")}
        box = box_from_profile(num(g("geopotential_height")), num(g("cloud_cover")) / 100.0, num(g("temperature")) + 273.15,
                               u=-spd * np.sin(drn), v=-spd * np.cos(drn), elev=elev, cape=float(s("cape") or 0.0),
                               rain_mmh=rain, snow_mmh=snow_cm * 1.43, sfc=sfc)
        valid = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(times[i]))
        header = {"model": om_model, "source": ESTIMATED_MODELS.get(om_model, om_model), "attribution": "Open-Meteo (CC BY 4.0)",
                  "run": None, "fhr": None, "valid": valid, "estimated": True, "detail": 1, "lat": lat, "lon": lon}
        out = pack(box, header)
        self._remember(self._out, key, out, 96)
        return out

    async def observed(self, lat: float, lon: float) -> list[dict]:
        return await metar_near(lat, lon)

    def cleanup(self, max_age_h: float = 30.0) -> int:
        """Drop old region blocks, then the oldest until under the cap."""
        if not self.root.is_dir():
            return 0
        now, files, removed = time.time(), [], 0
        for f in self.root.rglob("*.npz"):
            try:
                st = f.stat()
            except OSError:
                continue
            if now - st.st_mtime > max_age_h * 3600:
                f.unlink(missing_ok=True)
                removed += st.st_size
            else:
                files.append((st.st_mtime, st.st_size, f))
        total = sum(s for _, s, _ in files)
        for _, size, f in sorted(files):
            if total <= self.cap:
                break
            f.unlink(missing_ok=True)
            total -= size
            removed += size
        return removed

    def clear(self) -> None:
        import shutil

        shutil.rmtree(self.root, ignore_errors=True)
        self._blocks.clear()
        self._out.clear()

    # -- blocks ---------------------------------------------------------------
    def _remember(self, store: OrderedDict, key, value, cap: int) -> None:
        store[key] = value
        store.move_to_end(key)
        while len(store) > cap:
            store.popitem(last=False)

    def _reg_key(self, sm: SkyModel, lat: float, lon: float) -> str:
        grid = self.frames.model_grids.get(sm.id)
        if grid is None:
            return f"~{round(lat)}_{round(lon)}"     # first request for this model: grid not known yet
        return region_for(grid, lat, lon, sm.core, sm.halo).key

    async def _once(self, key, factory):
        """Run ``factory`` once for everyone asking for ``key`` at the same time."""
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

    def _path(self, sm: SkyModel, run: str, fhr: int, reg: str, part: str) -> Path:
        return self.root / sm.id / run / f"{fhr:03d}_{reg}_{part}.npz"

    async def _block(self, sm: SkyModel, run: str, fhr: int, lat: float, lon: float, detail: int) -> Block:
        rk = self._reg_key(sm, lat, lon)
        full = self._blocks.get((sm.id, run, fhr, rk))
        if full is not None:
            self._blocks.move_to_end((sm.id, run, fhr, rk))
            return full
        async with self._sem:
            grid, reg, f2 = await self._once(("2d", sm.id, run, fhr, rk), lambda: self._part2d(sm, run, fhr, lat, lon))
            blk = Block(grid, reg, f2)
            if detail == 0:
                return blk
            d3 = await self._once(("3d", sm.id, run, fhr, reg.key), lambda: self._part3d(sm, run, fhr, lat, lon, reg))
        blk.levels = d3["levels"].astype(np.int32)
        blk.q = {sp: d3[f"q_{sp}"] for sp in SPECIES}
        blk.frac3 = d3.get("frac3")
        blk.tlev, blk.t = d3["tlev"].astype(np.int32), d3["t"]
        if "u" in d3 and len(d3["wlev"]):
            blk.wlev, blk.u, blk.v = d3["wlev"].astype(np.int32), d3["u"], d3["v"]
        self._remember(self._blocks, (sm.id, run, fhr, reg.key), blk, 6)
        return blk

    async def _part2d(self, sm: SkyModel, run: str, fhr: int, lat: float, lon: float):
        loop = asyncio.get_running_loop()
        model = REGISTRY[sm.id]
        grid = self.frames.model_grids.get(sm.id)
        if grid is not None:
            reg = region_for(grid, lat, lon, sm.core, sm.halo)
            f2 = await loop.run_in_executor(None, _load_npz, self._path(sm, run, fhr, reg.key, "2d"))
            if f2 is not None:
                return grid, reg, {k: v.astype(np.float32) for k, v in f2.items()}
        recs, urls = await self.frames.records(model, _default_product(sm.id), parse_run(run), fhr)
        picks = {name: select(recs, sel, fhr) for name, sel in sm.fields2d.items()}
        picks = {k: r for k, r in picks.items() if r is not None}
        for need in ("psfc", "orog", "t2m"):
            if need not in picks:
                raise NotAvailable(f"{model.short} f{fhr:03d} has no {need} field")
        names = list(picks)
        arrs, grid, reg = await self._planes(urls, [picks[n] for n in names], lat, lon, sm)
        self.frames.model_grids.setdefault(sm.id, grid)
        f2 = {n: a.astype(np.float32) for n, a in zip(names, arrs)}
        await loop.run_in_executor(None, _save_npz, self._path(sm, run, fhr, reg.key, "2d"), f2)
        return grid, reg, f2

    async def _part3d(self, sm: SkyModel, run: str, fhr: int, lat: float, lon: float, reg: Region) -> dict:
        loop = asyncio.get_running_loop()
        path = self._path(sm, run, fhr, reg.key, "3d")
        d3 = await loop.run_in_executor(None, _load_npz, path)
        if d3 is not None:
            return d3
        t0 = time.perf_counter()
        model = REGISTRY[sm.id]
        recs3, urls3 = await self.frames.records(model, sm.product3d or _default_product(sm.id), parse_run(run), fhr)
        by: dict = {}
        for r in recs3:
            lev = _level(r)
            if lev is not None and r.tkind == "instant":
                by.setdefault(r.var, {}).setdefault(lev, r)
        levels = sorted((lv for lv in by.get(sm.species["cw"], {}) if 100 <= lv <= 1000), reverse=True)
        levels = [lv for lv in levels if all(lv in by.get(sm.species[sp], {}) for sp in SPECIES)]
        if len(levels) < 8 or "TMP" not in by:
            raise NotAvailable(f"{model.short} f{fhr:03d} has no cloud water on pressure levels")

        def near(want, have):
            return sorted({min(have, key=lambda x: abs(x - w)) for w in want}, reverse=True) if have else []

        tlev = near(T_LEVELS, list(by["TMP"]))
        wlev = [lv for lv in near(W_LEVELS, list(by.get("UGRD", {}))) if lv in by.get("VGRD", {})]
        want: list[tuple[str, Record]] = []
        for sp in SPECIES:
            want += [(f"q_{sp}", by[sm.species[sp]][lv]) for lv in levels]
        if sm.frac3d and all(lv in by.get(sm.frac3d, {}) for lv in levels):
            want += [("frac3", by[sm.frac3d][lv]) for lv in levels]
        want += [("t", by["TMP"][lv]) for lv in tlev]
        want += [("u", by["UGRD"][lv]) for lv in wlev] + [("v", by["VGRD"][lv]) for lv in wlev]
        arrs, _, _ = await self._planes(urls3, [r for _, r in want], lat, lon, sm)
        d3 = {"levels": np.array(levels, np.int16), "tlev": np.array(tlev, np.int16), "wlev": np.array(wlev, np.int16)}
        for name in dict.fromkeys(n for n, _ in want):
            stack = np.stack([a for (n, _), a in zip(want, arrs) if n == name])
            if name == "frac3":
                stack = stack / 100.0
            d3[name] = stack.astype(np.float16) if name[0] in "qf" else stack.astype(np.float32)
        await loop.run_in_executor(None, _save_npz, path, d3)
        self.stats["blocks"] += 1
        log.info("sky block %s %s f%03d %s in %.1fs", sm.id, run, fhr, reg.key, time.perf_counter() - t0)
        return d3

    async def _planes(self, urls: list[str], recs: list[Record], lat, lon, sm: SkyModel):
        """Fetch + decode messages a few at a time, keeping only the region (whole fields never pile up)."""
        loop = asyncio.get_running_loop()
        out: list = [None] * len(recs)
        meta: list = [None, None]
        order = sorted(range(len(recs)), key=lambda i: recs[i].start)
        chunks = [order[i:i + 10] for i in range(0, len(order), 10)]
        sem = asyncio.Semaphore(3)

        async def run(chunk: list[int]) -> None:
            async with sem:
                blobs, last = None, None
                for url in urls:
                    try:
                        blobs = await fetch_ranges(url, [(recs[i].start, recs[i].end) for i in chunk])
                        break
                    except FetchError as exc:
                        last = exc
                if blobs is None:
                    raise last or FetchError("no mirror available")
                self.stats["bytes_downloaded"] += sum(len(b) for b in blobs)
                for i, blob in zip(chunk, blobs):
                    grid, reg, a = await loop.run_in_executor(self.frames.pool, _decode_crop, blob, lat, lon, sm.core, sm.halo)
                    out[i] = a
                    meta[0], meta[1] = grid, reg

        await asyncio.gather(*(run(c) for c in chunks))
        return out, meta[0], meta[1]


def _default_product(model_id: str) -> str:
    from .catalog import DEFAULT_PRODUCT

    return DEFAULT_PRODUCT[model_id]


def _save_npz(path: Path, arrays: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with open(tmp, "wb") as f:
        np.savez_compressed(f, **arrays)
    os.replace(tmp, path)


def _load_npz(path: Path) -> dict | None:
    try:
        with np.load(path) as z:
            return {k: z[k] for k in z.files}
    except (OSError, ValueError, EOFError):
        return None
