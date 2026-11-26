"""Variables (what the server computes), colormaps and products (what users pick).

Values are stored in canonical units (K, mm, m/s, hPa, m, dBZ, J/kg, %).
The client converts to the user's display units.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .derive import (
    AbsVortLatLon, AccPeriod, AccTotal, Column, Combine, Cumulative, Direct, NativeSnowNCEP,
    PtypeECMWF, PtypeNCEP, RelToAbsVort, SnowDepthECMWF, SnowIncECMWF, SnowIncNCEP, Vector,
    frac_to_pct, geopot_to_m, kgm2s_to_mmh, m_to_mm, pa_to_hpa, rh_from_t_q, rh_from_t_td, thickness,
)
from .grib import E, W

NCEP = ("hrrr", "rrfs", "gfs")
CAM = ("hrrr", "rrfs")
EC = ("ecmwf", "aifs")

DEFAULT_PRODUCT = {"hrrr": "sfc", "rrfs": "2dfld", "gfs": "pgrb2", "ecmwf": "fc", "aifs": "fc"}
REF_SELECTOR = {
    "hrrr": W("TMP", "2 m above ground"), "rrfs": W("TMP", "2 m above ground"),
    "gfs": W("TMP", "2 m above ground"), "ecmwf": E("2t"), "aifs": E("2t"),
}

EA = ("entire atmosphere", "entire atmosphere (considered as a single layer)")


@dataclass
class Var:
    id: str
    name: str
    units: str
    kind: str  # scalar | vector | category
    scale: float
    offset: float
    recipes: dict
    lod: str = "mean"  # mean | max | nearest
    static: bool = False
    internal: bool = False
    method: str | None = None


def _pl(var: str, level: int, product: str | None = None) -> W:
    return W(var, f"{level} mb", product=product)


COLUMNS = {
    "hrrr": Column([(p, _pl("TMP", p)) for p in (1000, 925, 850, 700, 500)], W("PRES", "surface"), W("TMP", "2 m above ground")),
    "rrfs": Column([(p, _pl("TMP", p, "prslev")) for p in (1000, 925, 850, 700, 600, 500)], W("PRES", "surface"), W("TMP", "2 m above ground")),
    "gfs": Column([(p, _pl("TMP", p)) for p in (1000, 925, 850, 700, 600, 500)], W("PRES", "surface"), W("TMP", "2 m above ground")),
    "ecmwf": Column([(p, E("t", "pl", str(p))) for p in (1000, 925, 850, 700, 600, 500)], E("sp"), E("2t")),
    "aifs": Column([(p, E("t", "pl", str(p))) for p in (1000, 925, 850, 700, 600, 500)], E("sp"), E("2t")),
}


def _ncep_upper(var: str, level: int) -> dict:
    """Upper-air message for each NCEP model (RRFS keeps these in the prslev file)."""
    return {
        "hrrr": _pl(var, level), "rrfs": _pl(var, level, "prslev"), "gfs": _pl(var, level),
    }


def _wind(level: int) -> dict:
    recipes = {
        m: Vector(_ncep_upper("UGRD", level)[m], _ncep_upper("VGRD", level)[m]) for m in NCEP
    }
    recipes.update({m: Vector(E("u", "pl", str(level)), E("v", "pl", str(level))) for m in EC})
    return recipes


def _hgt(level: int) -> dict:
    r = {m: Direct(_ncep_upper("HGT", level)[m]) for m in NCEP}
    r.update({m: Direct(E("gh", "pl", str(level))) for m in EC})
    return r


SNOW10_METHOD = "10:1 ratio from model precipitation where snow is the precipitation type"
KUCHERA_METHOD = "Kuchera ratio (warmest temperature in the column sets the snow-to-liquid ratio)"
EC_SNOW_METHOD = "Model snowfall water equivalent x 10"

VARS: dict[str, Var] = {}


def _add(v: Var) -> None:
    VARS[v.id] = v


_add(Var("t2m", "2 m temperature", "K", "scalar", 0.1, 150.0, {
    **{m: Direct(W("TMP", "2 m above ground")) for m in NCEP}, **{m: Direct(E("2t")) for m in EC},
}))
_add(Var("d2m", "2 m dewpoint", "K", "scalar", 0.1, 150.0, {
    **{m: Direct(W("DPT", "2 m above ground")) for m in NCEP}, **{m: Direct(E("2d")) for m in EC},
}))
_add(Var("rh2m", "2 m relative humidity", "%", "scalar", 0.5, 0.0, {
    **{m: Direct(W("RH", "2 m above ground")) for m in NCEP},
    **{m: Combine([E("2t"), E("2d")], rh_from_t_td) for m in EC},
}))
_add(Var("wind10", "10 m wind", "m/s", "vector", 0.1, -320.0, {
    **{m: Vector(W("UGRD", "10 m above ground"), W("VGRD", "10 m above ground")) for m in NCEP},
    **{m: Vector(E("10u"), E("10v")) for m in EC},
}))
_add(Var("gust", "Wind gust", "m/s", "scalar", 0.1, 0.0, {
    **{m: Direct(W("GUST", "surface")) for m in NCEP}, "ecmwf": Direct(E("10fg")),
}))
_add(Var("mslp", "Sea-level pressure", "hPa", "scalar", 0.05, 850.0, {
    "hrrr": Direct(W("MSLMA", "mean sea level"), pa_to_hpa),
    "rrfs": Direct(W("MSLET", "mean sea level"), pa_to_hpa),
    "gfs": Direct(W("PRMSL", "mean sea level"), pa_to_hpa),
    **{m: Direct(E("msl"), pa_to_hpa) for m in EC},
}))
_add(Var("ptype", "Precipitation type", "code", "category", 1.0, 0.0, {
    **{m: PtypeNCEP() for m in NCEP}, "ecmwf": PtypeECMWF(),
}, lod="nearest"))
_add(Var("tcc", "Total cloud cover", "%", "scalar", 1.0, 0.0, {
    "hrrr": Direct(W("TCDC", "entire atmosphere")),
    "rrfs": Direct(W("TCDC", EA)),
    "gfs": Direct(W("TCDC", "entire atmosphere")),
    **{m: Direct(E("tcc"), frac_to_pct) for m in EC},
}))
_add(Var("vis", "Visibility", "m", "scalar", 10.0, 0.0, {m: Direct(W("VIS", "surface")) for m in NCEP}))
_add(Var("refc", "Composite reflectivity", "dBZ", "scalar", 0.5, -40.0, {
    m: Direct(W("REFC", EA)) for m in NCEP
}, lod="max"))

APCP = W("APCP", "surface", "acc")
_add(Var("apcp_total", "Total precipitation", "mm", "scalar", 0.05, 0.0, {
    **{m: AccTotal(APCP) for m in NCEP}, **{m: AccTotal(E("tp")) for m in EC},
}))
for hours in (1, 3, 6, 24):
    _add(Var(f"apcp_{hours}h", f"{hours}-hour precipitation", "mm", "scalar", 0.05, 0.0, {
        **{m: AccPeriod(APCP, hours) for m in NCEP}, **{m: AccPeriod(E("tp"), hours) for m in EC},
    }))

_add(Var("snow10_inc", "Snowfall increment (10:1)", "mm", "scalar", 0.05, 0.0, {
    **{m: SnowIncNCEP("10to1") for m in NCEP}, **{m: SnowIncECMWF("10to1") for m in EC},
}, internal=True))
_add(Var("snow10", "Snowfall (10:1)", "mm", "scalar", 0.2, 0.0, {
    **{m: Cumulative("snow10_inc", SNOW10_METHOD) for m in NCEP},
    **{m: Cumulative("snow10_inc", EC_SNOW_METHOD) for m in EC},
}, method=SNOW10_METHOD))
_add(Var("snowku_inc", "Snowfall increment (Kuchera)", "mm", "scalar", 0.05, 0.0, {
    **{m: SnowIncNCEP("kuchera", COLUMNS[m]) for m in NCEP},
    **{m: SnowIncECMWF("kuchera", COLUMNS[m]) for m in EC},
}, internal=True))
_add(Var("snowku", "Snowfall (Kuchera)", "mm", "scalar", 0.2, 0.0, {
    m: Cumulative("snowku_inc", KUCHERA_METHOD) for m in NCEP + EC
}, method=KUCHERA_METHOD))
_add(Var("snownat", "Snowfall (model)", "mm", "scalar", 0.2, 0.0, {
    **{m: NativeSnowNCEP() for m in CAM}, **{m: Cumulative("snow10_inc", EC_SNOW_METHOD) for m in EC},
}))
_add(Var("frzr_inc", "Freezing rain increment", "mm", "scalar", 0.01, 0.0, {
    **{m: SnowIncNCEP("frzr", flag="CFRZR") for m in NCEP}, "ecmwf": SnowIncECMWF("frzr"),
}, internal=True))
_add(Var("frzr", "Freezing rain", "mm", "scalar", 0.01, 0.0, {
    m: Cumulative("frzr_inc", "Liquid precipitation where freezing rain is the precipitation type")
    for m in ("hrrr", "rrfs", "gfs", "ecmwf")
}))
_add(Var("snod", "Snow depth", "mm", "scalar", 2.0, 0.0, {
    **{m: Direct(W("SNOD", "surface"), m_to_mm) for m in NCEP}, "ecmwf": SnowDepthECMWF(),
}))
_add(Var("cape_sb", "Surface-based CAPE", "J/kg", "scalar", 2.0, 0.0, {
    m: Direct(W("CAPE", "surface")) for m in NCEP
}))
_add(Var("cape_ml", "Mixed-layer CAPE", "J/kg", "scalar", 2.0, 0.0, {
    m: Direct(W("CAPE", "90-0 mb above ground")) for m in NCEP
}))
_add(Var("cape_mu", "Most-unstable CAPE", "J/kg", "scalar", 2.0, 0.0, {
    **{m: Direct(W("CAPE", "255-0 mb above ground")) for m in NCEP}, "ecmwf": Direct(E("mucape")),
}))
_add(Var("srh03", "0-3 km storm-relative helicity", "m2/s2", "scalar", 1.0, -2000.0, {
    m: Direct(W("HLCY", "3000-0 m above ground")) for m in NCEP
}))
_add(Var("srh01", "0-1 km storm-relative helicity", "m2/s2", "scalar", 1.0, -2000.0, {
    m: Direct(W("HLCY", "1000-0 m above ground")) for m in CAM
}))
_add(Var("uh25", "2-5 km updraft helicity (hourly max)", "m2/s2", "scalar", 0.5, 0.0, {
    m: Direct(W("MXUPHL", "5000-2000 m above ground", "max")) for m in CAM
}, lod="max"))
_add(Var("pwat", "Precipitable water", "mm", "scalar", 0.1, 0.0, {
    **{m: Direct(W("PWAT", "entire atmosphere (considered as a single layer)")) for m in NCEP},
    "ecmwf": Direct(E("tcwv")),
}))
_add(Var("hgt500", "500 mb height", "m", "scalar", 1.0, 0.0, _hgt(500)))
_add(Var("hgt700", "700 mb height", "m", "scalar", 1.0, 0.0, _hgt(700)))
_add(Var("hgt850", "850 mb height", "m", "scalar", 1.0, 0.0, _hgt(850)))
_add(Var("hgt1000", "1000 mb height", "m", "scalar", 0.5, -1000.0, _hgt(1000), internal=True))
_add(Var("thick", "1000-500 mb thickness", "m", "scalar", 1.0, 4000.0, {
    **{m: Combine([_ncep_upper("HGT", 500)[m], _ncep_upper("HGT", 1000)[m]], thickness) for m in NCEP},
    **{m: Combine([E("gh", "pl", "500"), E("gh", "pl", "1000")], thickness) for m in EC},
}))
_add(Var("absv500", "500 mb absolute vorticity", "1e-5/s", "scalar", 0.1, -200.0, {
    "hrrr": Direct(_pl("ABSV", 500, "prs"), lambda a: a * 1e5),
    "rrfs": Direct(_pl("ABSV", 500, "prslev"), lambda a: a * 1e5),
    "gfs": Direct(_pl("ABSV", 500), lambda a: a * 1e5),
    "ecmwf": RelToAbsVort(E("vo", "pl", "500")),
    "aifs": AbsVortLatLon("500"),
}))
_add(Var("wind250", "250 mb wind", "m/s", "vector", 0.1, -320.0, _wind(250)))
_add(Var("wind500", "500 mb wind", "m/s", "vector", 0.1, -320.0, _wind(500)))
_add(Var("wind850", "850 mb wind", "m/s", "vector", 0.1, -320.0, _wind(850)))
_add(Var("t850", "850 mb temperature", "K", "scalar", 0.1, 150.0, {
    **{m: Direct(_ncep_upper("TMP", 850)[m]) for m in NCEP}, **{m: Direct(E("t", "pl", "850")) for m in EC},
}))
_add(Var("rh700", "700 mb relative humidity", "%", "scalar", 0.5, 0.0, {
    "hrrr": Combine([_pl("TMP", 700), _pl("DPT", 700)], rh_from_t_td),
    "rrfs": Direct(_pl("RH", 700, "prslev")),
    "gfs": Direct(_pl("RH", 700)),
    "ecmwf": Direct(E("r", "pl", "700")),
    "aifs": Combine([E("t", "pl", "700"), E("q", "pl", "700")], lambda t, q: rh_from_t_q(t, q, 700.0)),
}))
_add(Var("orog", "Model terrain height", "m", "scalar", 0.5, -500.0, {
    m: Direct(W("HGT", "surface")) for m in NCEP
}, static=True, internal=True))


def var_models(var_id: str) -> tuple[str, ...]:
    v = VARS.get(var_id)
    return tuple(v.recipes) if v else ()


# --------------------------------------------------------------------------- colormaps

def f2k(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0 + 273.15


def c2k(c: float) -> float:
    return c + 273.15


def inch(x: float) -> float:
    return x * 25.4


def mph(x: float) -> float:
    return x * 0.44704


def kt(x: float) -> float:
    return x * 0.514444


def _stops(conv, pairs):
    out = []
    for p in pairs:
        value, color = p[0], p[1]
        alpha = p[2] if len(p) > 2 else 1.0
        out.append([round(conv(value), 4), color, alpha])
    return out


COLORMAPS: dict[str, dict] = {
    "temp": {"unit": "temp", "mode": "smooth", "stops": _stops(f2k, [
        (-40, "#f7e6ff"), (-25, "#e0b3ff"), (-10, "#b388eb"), (0, "#7b6fd6"), (10, "#4f6fe0"),
        (20, "#3d9be9"), (28, "#5ec8f2"), (32, "#a5e8f7"), (32.01, "#3bb273"), (40, "#6cc56b"),
        (50, "#b6d957"), (60, "#f2df4f"), (70, "#f6b240"), (80, "#f07a2f"), (90, "#e2432d"),
        (100, "#c11f4f"), (110, "#951a74"), (120, "#5b1a6b"),
    ]), "ticks": [-20, 0, 20, 32, 50, 70, 90, 110]},
    "dewpoint": {"unit": "temp", "mode": "smooth", "stops": _stops(f2k, [
        (-20, "#5d4637"), (0, "#7b5e46"), (15, "#9b7a5b"), (25, "#bf9e76"), (32, "#d9c39a"),
        (40, "#e2e3b4"), (48, "#b7d58a"), (55, "#73b865"), (60, "#3d9a50"), (65, "#21867c"),
        (70, "#1c8fc1"), (75, "#2a62c4"), (80, "#5a3fb3"),
    ]), "ticks": [0, 20, 32, 40, 50, 60, 70, 80]},
    "rh": {"unit": "pct", "mode": "smooth", "stops": _stops(lambda x: x, [
        (0, "#7a4f2c"), (20, "#b07a4a"), (40, "#d9b98a"), (60, "#9fd0a0"), (80, "#3ea47b"),
        (90, "#2475a8"), (100, "#2c4aa0"),
    ]), "ticks": [10, 30, 50, 70, 90]},
    "rh700": {"unit": "pct", "mode": "smooth", "stops": _stops(lambda x: x, [
        (0, "#000000", 0.0), (50, "#2a9d55", 0.0), (70, "#3fb46a", 0.55), (80, "#2fa05e", 0.7),
        (90, "#1e8a53", 0.8), (100, "#156b43", 0.85),
    ]), "ticks": [70, 80, 90, 100]},
    "wind": {"unit": "wind", "mode": "smooth", "stops": _stops(mph, [
        (0, "#13294b"), (5, "#1f4e79"), (10, "#2a7ab0"), (15, "#2aa198"), (20, "#6cc04a"),
        (25, "#d6c931"), (30, "#f29c33"), (40, "#e8553d"), (50, "#c2185b"), (60, "#9c3fd1"),
        (75, "#d9a7ff"), (100, "#ffffff"),
    ]), "ticks": [5, 10, 20, 30, 40, 50, 60, 75]},
    "jet": {"unit": "wind", "mode": "smooth", "stops": _stops(kt, [
        (40, "#2a6fb0", 0.0), (50, "#2a6fb0", 0.35), (70, "#2fa3d5", 0.75), (90, "#4bc4a3", 0.85),
        (110, "#c7d64b", 0.9), (130, "#f2a33a", 0.92), (150, "#e2523b", 0.95), (170, "#c2185b", 1.0),
        (200, "#ead4ff", 1.0),
    ]), "ticks": [50, 70, 90, 110, 130, 150, 170]},
    "precip": {"unit": "precip", "mode": "smooth", "stops": _stops(inch, [
        (0.0, "#9be3a4", 0.0), (0.009, "#9be3a4", 0.0), (0.01, "#b8f0b0", 0.55), (0.1, "#7fd38b", 0.85),
        (0.25, "#3fae5c", 0.92), (0.5, "#207f45", 0.95), (0.75, "#f2d64b"), (1.0, "#f4a83a"),
        (1.5, "#ea6a2f"), (2.0, "#d73a2f"), (3.0, "#a3123a"), (4.0, "#c3248f"), (6.0, "#8a2fc2"),
        (8.0, "#5a3fc0"), (10.0, "#c9c5f2"), (15.0, "#ffffff"),
    ]), "ticks": [0.1, 0.25, 0.5, 1, 2, 4, 8, 15]},
    "snow": {"unit": "snow", "mode": "smooth", "stops": _stops(inch, [
        (0.0, "#cfe5ff", 0.0), (0.09, "#cfe5ff", 0.0), (0.1, "#d6ebff", 0.45), (1, "#a7cdf0", 0.85),
        (2, "#74aee0", 0.95), (3, "#4b8fd1"), (4, "#2d6fbf"), (6, "#2b4fa3"), (8, "#5a3fa8"),
        (10, "#7d43b5"), (12, "#a54bb8"), (15, "#d04aa0"), (18, "#ef6aa6"), (24, "#f7b2d3"),
        (36, "#fff0f7"),
    ]), "ticks": [1, 2, 4, 6, 8, 12, 18, 24]},
    "ice": {"unit": "precip", "mode": "smooth", "stops": _stops(inch, [
        (0.0, "#ffd1ec", 0.0), (0.009, "#ffd1ec", 0.0), (0.01, "#ffc2e5", 0.6), (0.05, "#f59bd0", 0.85),
        (0.1, "#e86fbf"), (0.25, "#cf3fa8"), (0.5, "#a3218a"), (0.75, "#7a1470"), (1.0, "#4f0d4f"),
    ]), "ticks": [0.05, 0.1, 0.25, 0.5, 0.75, 1]},
    "refl": {"unit": "refl", "mode": "step", "stops": _stops(lambda x: x, [
        (0, "#000000", 0.0), (4.99, "#000000", 0.0), (5, "#5fd3e8", 0.45), (10, "#3a9ff0", 0.7),
        (15, "#2f5fe0", 0.85), (20, "#35d64a"), (25, "#24ac34"), (30, "#16821f"), (35, "#f4e842"),
        (40, "#e6b62a"), (45, "#f08a22"), (50, "#ea2a24"), (55, "#c4191b"), (60, "#a2141f"),
        (65, "#f03ce6"), (70, "#9b57d4"), (75, "#ffffff"),
    ]), "ticks": [10, 20, 30, 40, 50, 60, 70]},
    "cape": {"unit": "cape", "mode": "smooth", "stops": _stops(lambda x: x, [
        (0, "#fff3b0", 0.0), (100, "#fff3b0", 0.0), (250, "#ffe9a3", 0.5), (500, "#ffd166", 0.75),
        (1000, "#f8a13a", 0.9), (1500, "#f3722c"), (2000, "#ea4335"), (3000, "#c1121f"),
        (4000, "#8f0f45"), (5000, "#7a1c8c"), (6500, "#c79bff"),
    ]), "ticks": [250, 500, 1000, 2000, 3000, 4000, 5000]},
    "srh": {"unit": "srh", "mode": "smooth", "stops": _stops(lambda x: x, [
        (0, "#d9f2ec", 0.0), (50, "#d9f2ec", 0.0), (75, "#bfe7dd", 0.55), (100, "#7cccb8", 0.8),
        (150, "#2fae98"), (200, "#f3d34a"), (300, "#f39a35"), (400, "#e2523b"), (500, "#b3297a"),
        (700, "#7a3cc2"),
    ]), "ticks": [100, 150, 200, 300, 400, 500]},
    "uh": {"unit": "srh", "mode": "smooth", "stops": _stops(lambda x: x, [
        (0, "#f3d34a", 0.0), (24.9, "#f3d34a", 0.0), (25, "#f3d34a", 0.8), (50, "#f39a35"),
        (75, "#e2523b"), (100, "#c1121f"), (150, "#9b1d8a"), (200, "#d6a6ff"),
    ]), "ticks": [25, 50, 75, 100, 150, 200]},
    "pwat": {"unit": "pwat", "mode": "smooth", "stops": _stops(inch, [
        (0.1, "#7b5e46"), (0.4, "#b08b63"), (0.7, "#d9c39a"), (1.0, "#a6d6b8"), (1.25, "#4fb39a"),
        (1.5, "#1f8f8a"), (1.75, "#1f6fb0"), (2.0, "#3a4fc0"), (2.25, "#6a3fc2"), (2.5, "#a43fb5"),
        (3.0, "#e05aa0"),
    ]), "ticks": [0.5, 1, 1.5, 2, 2.5, 3]},
    "cloud": {"unit": "pct", "mode": "smooth", "stops": _stops(lambda x: x, [
        (0, "#ffffff", 0.0), (10, "#ffffff", 0.0), (30, "#e9eef7", 0.25), (60, "#f1f4fb", 0.55),
        (85, "#f8f9fd", 0.78), (100, "#ffffff", 0.9),
    ]), "ticks": [25, 50, 75, 100]},
    "vis": {"unit": "vis", "mode": "smooth", "stops": _stops(lambda mi: mi * 1609.34, [
        (0, "#8e24aa"), (0.25, "#c2185b"), (0.5, "#e2523b"), (1, "#f39a35"), (3, "#f3d34a", 0.9),
        (5, "#b7d34a", 0.5), (7, "#b7d34a", 0.0), (100, "#b7d34a", 0.0),
    ]), "ticks": [0.25, 0.5, 1, 3, 5]},
    "vort": {"unit": "vort", "mode": "smooth", "hemi": True, "stops": _stops(lambda x: x, [
        (-50, "#000000", 0.0), (11.9, "#000000", 0.0), (12, "#f6e05e", 0.55), (16, "#f6ad55", 0.8),
        (20, "#ed8936", 0.9), (24, "#e53e3e"), (28, "#c53071"), (34, "#9f3fbf"), (44, "#e9d8fd"),
    ]), "ticks": [12, 16, 20, 24, 28, 34, 44]},
    "t850": {"unit": "temp", "mode": "smooth", "stops": _stops(c2k, [
        (-40, "#f0e0ff"), (-30, "#b391e8"), (-20, "#6f6fd8"), (-10, "#3d8fe0"), (-2, "#8fd8f2"),
        (0, "#e9f5f2"), (2, "#bfe3a8"), (8, "#e8d65a"), (14, "#f1a03a"), (20, "#e2552f"),
        (26, "#b51d4a"), (32, "#7a1a6b"),
    ]), "ticks": [-30, -20, -10, 0, 10, 20, 30]},
    "thick": {"unit": "thick", "mode": "smooth", "stops": _stops(lambda x: x, [
        (4800, "#3b2a8f", 0.6), (5100, "#3d6fd0", 0.55), (5340, "#6fb7e8", 0.45), (5400, "#e8f1f5", 0.3),
        (5460, "#f6c69a", 0.45), (5700, "#e46a3a", 0.55), (5940, "#a3123a", 0.6),
    ]), "ticks": [5100, 5280, 5400, 5520, 5700]},
    "ptype": {"unit": "rate", "mode": "category", "categories": [
        {"id": 1, "name": "Rain", "stops": [[0.05, "#a6f0a0", 0.55], [1, "#4fcf5c", 0.85], [4, "#1e9e3b"], [10, "#f2d64b"], [25, "#e8553d"], [60, "#b0184f"]]},
        {"id": 2, "name": "Snow", "stops": [[0.05, "#cfe8ff", 0.55], [0.5, "#8ec3f5", 0.85], [1.5, "#4f94e6"], [3, "#2c5fd0"], [6, "#2a35a8"], [12, "#4a1e8c"]]},
        {"id": 3, "name": "Freezing rain", "stops": [[0.05, "#ffc8e6", 0.6], [0.5, "#f58bc8", 0.9], [2, "#e04fae"], [5, "#b51f8c"], [10, "#7a0f63"]]},
        {"id": 4, "name": "Sleet", "stops": [[0.05, "#ffe1b8", 0.6], [0.5, "#ffbf6e", 0.9], [2, "#f5952f"], [5, "#d9661a"], [10, "#a8420c"]]},
        {"id": 5, "name": "Mix", "stops": [[0.05, "#e6d4ff", 0.6], [0.5, "#c3a1f5", 0.9], [2, "#9b6ee6"], [5, "#7444c9"], [10, "#4f2a9e"]]},
    ]},
    "mrms": {"unit": "refl", "mode": "step", "stops": _stops(lambda x: x, [
        (-30, "#000000", 0.0), (4.99, "#000000", 0.0), (5, "#5fd3e8", 0.5), (10, "#3a9ff0", 0.75),
        (15, "#2f5fe0", 0.9), (20, "#35d64a"), (25, "#24ac34"), (30, "#16821f"), (35, "#f4e842"),
        (40, "#e6b62a"), (45, "#f08a22"), (50, "#ea2a24"), (55, "#c4191b"), (60, "#a2141f"),
        (65, "#f03ce6"), (70, "#9b57d4"), (75, "#ffffff"),
    ]), "ticks": [10, 20, 30, 40, 50, 60, 70]},
}


# --------------------------------------------------------------------------- products

@dataclass
class Product:
    id: str
    name: str
    category: str
    fill: str | None
    cmap: str
    contours: list = field(default_factory=list)
    particles: str | None = None
    desc: str = ""

    def available(self, model: str) -> bool:
        return model in var_models(self.fill) if self.fill else False

    def client(self, enabled: tuple[str, ...]) -> dict:
        contours = []
        for c in self.contours:
            contours.append({**c, "models": [m for m in var_models(c["var"]) if m in enabled]})
        return {
            "id": self.id, "name": self.name, "category": self.category, "fill": self.fill,
            "cmap": self.cmap, "contours": contours, "particles": self.particles,
            "particleModels": [m for m in var_models(self.particles) if m in enabled] if self.particles else [],
            "desc": self.desc, "models": [m for m in var_models(self.fill) if m in enabled] if self.fill else [],
            "method": VARS[self.fill].method if self.fill and self.fill in VARS else None,
        }


MSLP_CONTOUR = {"var": "mslp", "interval": 4, "base": 1000, "color": "#f4f6fb", "width": 1.15, "label": True, "hilo": True, "smooth": 2}
H500_CONTOUR = {"var": "hgt500", "interval": 60, "base": 5400, "color": "#f4f6fb", "width": 1.25, "label": True, "unit": "dam", "smooth": 2}

PRODUCTS: list[Product] = [
    Product("t2m", "Temperature", "Surface", "t2m", "temp",
            [{"var": "t2m", "levels": [273.15], "color": "#ffffff", "width": 1.6, "label": False, "smooth": 1}],
            desc="2 m air temperature. The white line marks freezing."),
    Product("d2m", "Dewpoint", "Surface", "d2m", "dewpoint", desc="2 m dewpoint temperature."),
    Product("rh2m", "Humidity", "Surface", "rh2m", "rh", desc="2 m relative humidity."),
    Product("wind10", "Wind", "Surface", "wind10", "wind", particles="wind10", desc="10 m sustained wind with animated flow."),
    Product("gust", "Wind gusts", "Surface", "gust", "wind", particles="wind10", desc="Surface wind gusts."),
    Product("mslp", "Pressure & precip", "Surface", "ptype", "ptype", [MSLP_CONTOUR],
            desc="Precipitation type and rate with sea-level isobars every 4 mb."),
    Product("tcc", "Cloud cover", "Surface", "tcc", "cloud", desc="Total cloud cover."),
    Product("vis", "Visibility", "Surface", "vis", "vis", desc="Surface visibility."),
    Product("refc", "Simulated radar", "Precipitation", "refc", "refl", desc="Composite reflectivity."),
    Product("ptype", "Precip type", "Precipitation", "ptype", "ptype", desc="Precipitation type, shaded by rate."),
    Product("qpf", "Total precip", "Precipitation", "apcp_total", "precip", desc="Liquid-equivalent precipitation since the start of the run."),
    Product("qpf1", "1-hr precip", "Precipitation", "apcp_1h", "precip", desc="Precipitation in the hour ending at the valid time."),
    Product("qpf6", "6-hr precip", "Precipitation", "apcp_6h", "precip", desc="Precipitation in the 6 hours ending at the valid time."),
    Product("qpf24", "24-hr precip", "Precipitation", "apcp_24h", "precip", desc="Precipitation in the 24 hours ending at the valid time."),
    Product("snow10", "Snowfall 10:1", "Winter", "snow10", "snow", desc="Accumulated snowfall at a 10:1 snow-to-liquid ratio."),
    Product("snowku", "Snowfall Kuchera", "Winter", "snowku", "snow", desc="Accumulated snowfall using the Kuchera ratio (fluffier when the column is colder)."),
    Product("snownat", "Snowfall (model)", "Winter", "snownat", "snow", desc="The model's own snowfall field."),
    Product("frzr", "Freezing rain", "Winter", "frzr", "ice", desc="Accumulated freezing rain (liquid)."),
    Product("snod", "Snow depth", "Winter", "snod", "snow", desc="Snow on the ground."),
    Product("sbcape", "Surface CAPE", "Severe", "cape_sb", "cape", desc="Surface-based convective available potential energy."),
    Product("mlcape", "Mixed-layer CAPE", "Severe", "cape_ml", "cape", desc="Mixed-layer CAPE (lowest 90 mb)."),
    Product("mucape", "Most-unstable CAPE", "Severe", "cape_mu", "cape", desc="Most-unstable CAPE."),
    Product("srh03", "0-3 km helicity", "Severe", "srh03", "srh", desc="0-3 km storm-relative helicity."),
    Product("srh01", "0-1 km helicity", "Severe", "srh01", "srh", desc="0-1 km storm-relative helicity."),
    Product("uh", "Updraft helicity", "Severe", "uh25", "uh", desc="Hourly maximum 2-5 km updraft helicity (rotating storms)."),
    Product("pwat", "Precipitable water", "Severe", "pwat", "pwat", desc="Total column water vapor."),
    Product("h500", "500 mb vorticity", "Upper air", "absv500", "vort", [H500_CONTOUR],
            desc="500 mb absolute vorticity with heights every 6 dam."),
    Product("w500", "500 mb wind", "Upper air", "wind500", "jet", [H500_CONTOUR], particles="wind500",
            desc="500 mb wind speed and heights."),
    Product("t850", "850 mb temperature", "Upper air", "t850", "t850",
            [{"var": "hgt850", "interval": 30, "base": 1500, "color": "#f4f6fb", "width": 1.1, "label": True, "unit": "dam", "smooth": 2},
             {"var": "t850", "levels": [273.15], "color": "#ffffff", "width": 1.8, "dash": True, "label": False, "smooth": 1}],
            particles="wind850", desc="850 mb temperature, heights and wind. Dashed line is 0 °C."),
    Product("jet250", "250 mb jet", "Upper air", "wind250", "jet", particles="wind250", desc="250 mb jet stream."),
    Product("rh700", "700 mb humidity", "Upper air", "rh700", "rh700",
            [{"var": "hgt700", "interval": 30, "base": 3000, "color": "#f4f6fb", "width": 1.05, "label": True, "unit": "dam", "smooth": 2}],
            desc="700 mb relative humidity and heights."),
    Product("thick", "Thickness & pressure", "Upper air", "thick", "thick",
            [MSLP_CONTOUR, {"var": "thick", "interval": 60, "base": 5400, "width": 1.3, "label": True, "unit": "dam", "dash": True,
                            "split": {"value": 5400, "below": "#7fb2ff", "above": "#ff8f70", "at": "#ffffff"}, "smooth": 2}],
            desc="1000-500 mb thickness (dashed; blue below 540 dam) and sea-level pressure."),
]
PRODUCT_INDEX = {p.id: p for p in PRODUCTS}

REGIONS = [
    {"id": "wnc", "name": "Western NC & TN line", "bbox": [-84.6, 34.75, -80.9, 36.65]},
    {"id": "cfl", "name": "Central Florida", "bbox": [-83.0, 27.4, -80.0, 30.0]},
    {"id": "se", "name": "Southeast", "bbox": [-92.0, 24.5, -75.0, 37.5]},
    {"id": "ne", "name": "Northeast", "bbox": [-81.0, 38.0, -66.5, 47.8]},
    {"id": "mw", "name": "Midwest", "bbox": [-98.0, 36.0, -80.0, 49.0]},
    {"id": "sp", "name": "Southern Plains", "bbox": [-107.0, 25.5, -90.0, 38.5]},
    {"id": "west", "name": "West", "bbox": [-125.5, 31.0, -102.0, 49.5]},
    {"id": "conus", "name": "CONUS", "bbox": [-126.0, 23.0, -66.0, 50.0]},
    {"id": "atl", "name": "Atlantic tropics", "bbox": [-100.0, 5.0, -10.0, 40.0]},
    {"id": "na", "name": "North America", "bbox": [-170.0, 10.0, -50.0, 72.0]},
    {"id": "eu", "name": "Europe", "bbox": [-25.0, 34.0, 45.0, 72.0]},
]

METEOGRAM_MODELS = [
    {"id": "ncep_hrrr_conus", "name": "HRRR", "color": "#ff8a5b", "days": 2, "region": "conus"},
    {"id": "ncep_rrfs_conus", "name": "RRFS", "color": "#c084fc", "days": 4, "region": "conus"},
    {"id": "ncep_nbm_conus", "name": "NBM", "color": "#fbbf24", "days": 10, "region": "conus"},
    {"id": "ncep_gfs_seamless", "name": "GFS", "color": "#4fd1c5", "days": 16},
    {"id": "ecmwf_ifs", "name": "ECMWF", "color": "#60a5fa", "days": 15},
    {"id": "ecmwf_aifs025_single", "name": "AIFS", "color": "#f472b6", "days": 15},
    {"id": "icon_seamless", "name": "ICON", "color": "#a3e635", "days": 7.5},
    {"id": "gem_seamless", "name": "GEM", "color": "#f87171", "days": 10},
    {"id": "ukmo_seamless", "name": "UKMO", "color": "#e2e8f0", "days": 7},
]
SOUNDING_MODELS = [
    {"id": "ncep_rrfs_conus", "name": "RRFS", "days": 3.5, "region": "conus"},
    {"id": "ncep_hrrr_conus", "name": "HRRR", "days": 2, "region": "conus"},
    {"id": "ncep_gfs025", "name": "GFS", "days": 16},
    {"id": "ecmwf_ifs025", "name": "ECMWF", "days": 15},
    {"id": "ecmwf_aifs025_single", "name": "AIFS", "days": 15},
]
