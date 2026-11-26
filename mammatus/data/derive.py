"""Recipes that turn GRIB messages into display variables.

A recipe computes one variable for one (model, run, forecast hour). Recipes can
read raw messages through the RunContext, or other variables (which are cached
as frames), so cumulative products like snowfall build incrementally.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass, field
from typing import Callable, Iterable

import numpy as np

from .grib import E, Grid, W, abs_vorticity_latlon, coriolis, rotate_to_earth

G0 = 9.80665


@dataclass
class Result:
    kind: str  # scalar | vector | category
    data: list[np.ndarray]
    grid: Grid
    meta: dict = field(default_factory=dict)


class NotAvailable(Exception):
    """The variable can't be produced for this step (e.g. 1-h precip on a 3-h step)."""


class Recipe:
    kind = "scalar"
    method: str | None = None

    async def compute(self, ctx, fhr: int) -> Result:  # pragma: no cover - interface
        raise NotImplementedError


def _conv(arr: np.ndarray, conv: Callable | None) -> np.ndarray:
    return arr if conv is None else conv(arr).astype(np.float32, copy=False)


# --------------------------------------------------------------------- conversions

def k_to_k(a):
    return a


def m_to_mm(a):
    return a * 1000.0


def pa_to_hpa(a):
    return a / 100.0


def kgm2s_to_mmh(a):
    return a * 3600.0


def frac_to_pct(a):
    return a * 100.0


def to_1e5(a):
    return a * 1e5


def geopot_to_m(a):
    return a / G0


def rh_from_t_td(t_k, td_k):
    t = t_k - 273.15
    td = td_k - 273.15
    es = np.exp(17.625 * t / (243.04 + t))
    e = np.exp(17.625 * td / (243.04 + td))
    return np.clip(100.0 * e / es, 0, 100).astype(np.float32)


def rh_from_t_q(t_k, q, p_hpa):
    t = t_k - 273.15
    es = 6.112 * np.exp(17.67 * t / (t + 243.5))
    e = q * p_hpa / (0.622 + 0.378 * q)
    return np.clip(100.0 * e / es, 0, 100).astype(np.float32)


# --------------------------------------------------------------------- basic recipes

class Direct(Recipe):
    def __init__(self, sel, conv: Callable | None = None, kind: str = "scalar", method: str | None = None):
        self.sel, self.conv, self.kind, self.method = sel, conv, kind, method

    async def compute(self, ctx, fhr: int) -> Result:
        d = await ctx.get(self.sel, fhr)
        return Result(self.kind, [_conv(d.values, self.conv)], d.grid, {"method": self.method} if self.method else {})


class Vector(Recipe):
    kind = "vector"

    def __init__(self, usel, vsel, conv: Callable | None = None):
        self.usel, self.vsel, self.conv = usel, vsel, conv

    async def compute(self, ctx, fhr: int) -> Result:
        u, v = await ctx.get_many([self.usel, self.vsel], fhr)
        uu, vv = u.values, v.values
        if u.uv_grid_relative:
            uu, vv = rotate_to_earth(uu, vv, u.grid)
        return Result("vector", [_conv(uu, self.conv), _conv(vv, self.conv)], u.grid)


class Combine(Recipe):
    """Combine several messages valid at the same hour with ``fn``."""

    def __init__(self, sels: list, fn: Callable, kind: str = "scalar", method: str | None = None,
                 needs_grid: bool = False):
        self.sels, self.fn, self.kind, self.method, self.needs_grid = sels, fn, kind, method, needs_grid

    async def compute(self, ctx, fhr: int) -> Result:
        ds = await ctx.get_many(self.sels, fhr)
        arrays = [d.values for d in ds]
        if self.needs_grid:
            out = self.fn(*arrays, grid=ds[0].grid)
        else:
            out = self.fn(*arrays)
        data = list(out) if isinstance(out, tuple) else [out]
        return Result(self.kind, [a.astype(np.float32, copy=False) for a in data], ds[0].grid,
                      {"method": self.method} if self.method else {})


class AccTotal(Recipe):
    """Accumulation from the start of the run to ``fhr``."""

    def __init__(self, sel, conv: Callable | None = None, method: str | None = None):
        self.sel, self.conv, self.method = sel, conv, method

    async def compute(self, ctx, fhr: int) -> Result:
        if fhr == 0:
            grid = await ctx.grid()
            return Result("scalar", [np.zeros((grid.nj, grid.ni), np.float32)], grid)
        arr, grid = await ctx.integral(self.sel, 0, fhr)
        return Result("scalar", [_conv(np.maximum(arr, 0), self.conv)], grid)


class AccPeriod(Recipe):
    """Accumulation over the ``hours`` ending at ``fhr``."""

    def __init__(self, sel, hours: int, conv: Callable | None = None):
        self.sel, self.hours, self.conv = sel, hours, conv

    async def compute(self, ctx, fhr: int) -> Result:
        start = max(0, fhr - self.hours)
        if fhr == 0:
            raise NotAvailable("no accumulation at analysis time")
        steps = ctx.steps
        if start != 0 and start not in steps:
            raise NotAvailable(f"{self.hours}-h period not available at f{fhr:03d}")
        if steps:
            prev = [s for s in steps if s < fhr]
            if prev and fhr - prev[-1] > self.hours:
                raise NotAvailable(f"model step is longer than {self.hours} h here")
        arr, grid = await ctx.integral(self.sel, start, fhr)
        return Result("scalar", [_conv(np.maximum(arr, 0), self.conv)], grid,
                      {"period": [start, fhr]})


# --------------------------------------------------------------------- precipitation type

PTYPE_NONE, PTYPE_RAIN, PTYPE_SNOW, PTYPE_FRZR, PTYPE_SLEET, PTYPE_MIX = range(6)
RATE_STEP = 0.05  # mm/h per unit in the packed value


def _pack_ptype(cat: np.ndarray, rate_mmh: np.ndarray) -> np.ndarray:
    rate_q = np.clip(np.round(rate_mmh / RATE_STEP), 0, 4095)
    cat = np.where(rate_mmh < 0.02, PTYPE_NONE, cat)
    rate_q = np.where(cat == PTYPE_NONE, 0, rate_q)
    return (cat * 4096 + rate_q).astype(np.float32)


class PtypeNCEP(Recipe):
    kind = "category"

    def __init__(self, product: str | None = None):
        self.product = product

    async def compute(self, ctx, fhr: int) -> Result:
        p = self.product
        sels = [W("CRAIN", "surface", product=p), W("CSNOW", "surface", product=p),
                W("CFRZR", "surface", product=p), W("CICEP", "surface", product=p),
                W("PRATE", "surface", product=p)]
        crain, csnow, cfrzr, cicep, prate = await ctx.get_many(sels, fhr)
        r, s, z, ip = (np.nan_to_num(x.values) > 0.5 for x in (crain, csnow, cfrzr, cicep))
        cat = np.full(r.shape, PTYPE_RAIN, np.int32)
        cat[s] = PTYPE_SNOW
        cat[s & r] = PTYPE_MIX
        cat[ip] = PTYPE_SLEET
        cat[z] = PTYPE_FRZR
        rate = np.nan_to_num(prate.values) * 3600.0
        return Result("category", [_pack_ptype(cat, rate)], crain.grid)


class PtypeECMWF(Recipe):
    kind = "category"
    MAP = {1: PTYPE_RAIN, 3: PTYPE_FRZR, 5: PTYPE_SNOW, 6: PTYPE_SNOW, 7: PTYPE_MIX, 8: PTYPE_SLEET, 12: PTYPE_FRZR}

    async def compute(self, ctx, fhr: int) -> Result:
        ptype, rate = await ctx.get_many([E("ptype"), E("tprate")], fhr)
        code = np.nan_to_num(ptype.values).round().astype(np.int32)
        cat = np.zeros(code.shape, np.int32)
        for k, v in self.MAP.items():
            cat[code == k] = v
        cat[(cat == 0) & (np.nan_to_num(rate.values) > 0)] = PTYPE_RAIN
        return Result("category", [_pack_ptype(cat, np.nan_to_num(rate.values) * 3600.0)], ptype.grid)


# --------------------------------------------------------------------- snowfall & ice

def kuchera_ratio(tmax_k: np.ndarray) -> np.ndarray:
    t = 271.16
    ratio = np.where(tmax_k > t, 12.0 + 2.0 * (t - tmax_k), 12.0 + (t - tmax_k))
    return np.clip(ratio, 0.0, 30.0).astype(np.float32)


@dataclass
class Column:
    """Selectors for the temperature column used by the Kuchera ratio."""

    temps: list  # list of (pressure_hpa, selector)
    sfc_pressure: object  # selector (Pa)
    t2m: object


class SnowIncNCEP(Recipe):
    """Snowfall (mm depth) over the step ending at ``fhr`` from categorical snow."""

    def __init__(self, method: str, column: Column | None = None, flag: str = "CSNOW", product: str | None = None):
        self.method, self.column, self.flag, self.product = method, column, flag, product

    async def compute(self, ctx, fhr: int) -> Result:
        prev = ctx.prev_step(fhr)
        if prev is None:
            grid = await ctx.grid()
            return Result("scalar", [np.zeros((grid.nj, grid.ni), np.float32)], grid)
        dp, grid = await ctx.integral(W("APCP", "surface", "acc", self.product), prev, fhr)
        dp = np.maximum(np.nan_to_num(dp), 0)
        frac = await ctx.fraction(W(self.flag, "surface", product=self.product), prev, fhr)
        inc = dp * frac
        if self.method == "frzr":
            return Result("scalar", [inc.astype(np.float32)], grid)
        if self.method == "kuchera" and self.column is not None:
            tmax = await ctx.column_tmax(self.column, fhr)
            inc = inc * kuchera_ratio(tmax)
        else:
            inc = inc * 10.0
        return Result("scalar", [inc.astype(np.float32)], grid)


class SnowIncECMWF(Recipe):
    def __init__(self, method: str, column: Column | None = None):
        self.method, self.column = method, column

    async def compute(self, ctx, fhr: int) -> Result:
        prev = ctx.prev_step(fhr)
        if prev is None:
            grid = await ctx.grid()
            return Result("scalar", [np.zeros((grid.nj, grid.ni), np.float32)], grid)
        if self.method == "frzr":
            dp, grid = await ctx.integral(E("tp"), prev, fhr)
            ptype = await ctx.get(E("ptype"), fhr)
            code = np.nan_to_num(ptype.values).round()
            mask = (code == 3) | (code == 12)
            return Result("scalar", [(np.maximum(dp, 0) * mask).astype(np.float32)], grid)
        sf, grid = await ctx.integral(E("sf"), prev, fhr)  # mm water equivalent
        swe_mm = np.maximum(np.nan_to_num(sf), 0)
        if self.method == "kuchera" and self.column is not None:
            tmax = await ctx.column_tmax(self.column, fhr)
            return Result("scalar", [(swe_mm * kuchera_ratio(tmax)).astype(np.float32)], grid)
        return Result("scalar", [(swe_mm * 10.0).astype(np.float32)], grid)


class Cumulative(Recipe):
    """Running total of an increment variable, built on cached earlier totals."""

    def __init__(self, inc_var: str, method: str):
        self.inc_var, self.method = inc_var, method

    async def compute(self, ctx, fhr: int) -> Result:
        steps = [s for s in ctx.steps if s <= fhr] or [fhr]
        if fhr not in steps:
            steps.append(fhr)
        base_step, base, grid = None, None, None
        for s in reversed(steps[:-1]):
            if ctx.has_var(ctx.var_id, s):
                data, grid = await ctx.var_values(ctx.var_id, s)
                base_step, base = s, data[0]
                break
        todo = [s for s in steps if (base_step is None or s > base_step) and s > 0]
        results = await asyncio.gather(*(ctx.var_values(self.inc_var, s) for s in todo))
        total = None if base is None else base.astype(np.float32).copy()
        for data, g in results:
            grid = g
            arr = np.nan_to_num(data[0])
            total = arr.copy() if total is None else total + arr
        if total is None:
            grid = await ctx.grid()
            total = np.zeros((grid.nj, grid.ni), np.float32)
        return Result("scalar", [total.astype(np.float32)], grid, {"method": self.method})


class NativeSnowNCEP(Recipe):
    method = "Model snowfall (ASNOW, variable snow density)"

    def __init__(self, product: str | None = None):
        self.product = product

    async def compute(self, ctx, fhr: int) -> Result:
        if fhr == 0:
            grid = await ctx.grid()
            return Result("scalar", [np.zeros((grid.nj, grid.ni), np.float32)], grid, {"method": self.method})
        arr, grid = await ctx.integral(W("ASNOW", "surface", "acc", self.product), 0, fhr)
        return Result("scalar", [(np.maximum(arr, 0) * 1000.0).astype(np.float32)], grid, {"method": self.method})


class SnowDepthECMWF(Recipe):
    async def compute(self, ctx, fhr: int) -> Result:
        sd, rsn = await ctx.get_many([E("sd"), E("rsn")], fhr)
        depth_m = np.nan_to_num(sd.values) * 1000.0 / np.maximum(np.nan_to_num(rsn.values), 50.0)
        return Result("scalar", [(depth_m * 1000.0).astype(np.float32)], sd.grid)


class AbsVortLatLon(Recipe):
    def __init__(self, level: str):
        self.level = level

    async def compute(self, ctx, fhr: int) -> Result:
        u, v = await ctx.get_many([E("u", "pl", self.level), E("v", "pl", self.level)], fhr)
        av = abs_vorticity_latlon(u.values.astype(np.float64), v.values.astype(np.float64), u.grid)
        return Result("scalar", [(av * 1e5).astype(np.float32)], u.grid)


class RelToAbsVort(Recipe):
    def __init__(self, sel):
        self.sel = sel

    async def compute(self, ctx, fhr: int) -> Result:
        d = await ctx.get(self.sel, fhr)
        return Result("scalar", [((d.values + coriolis(d.grid)) * 1e5).astype(np.float32)], d.grid)


def thickness(h500, h1000):
    return h500 - h1000


def mixed(*sels):
    return list(sels)
