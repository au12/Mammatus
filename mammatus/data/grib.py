"""GRIB2 index parsing, message selection, decoding and grid geometry."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field

import numpy as np

EARTH_R = 6371229.0  # shapeOfTheEarth=6 (all NCEP/ECMWF products used here)
ECMWF_ACCUM = {"tp", "sf", "cp", "ro", "ssr", "ssrd", "str", "strd", "ttr", "ewss", "nsss", "lsp"}


@dataclass
class Record:
    start: int
    end: int | None  # inclusive; None = to end of file
    var: str = ""
    level: str = ""
    time: str = ""
    extra: str = ""
    tkind: str = "instant"  # instant | acc | ave | max | min
    t0: int = 0
    t1: int = 0
    # ECMWF index fields
    param: str = ""
    levtype: str = ""
    levelist: str = ""


_INTERVAL = re.compile(r"^(\d+)-(\d+) (hour|day|min) (acc|ave|max|min)")
_INSTANT = re.compile(r"^(\d+) (hour|day|min) fcst")


def _hours(value: int, unit: str) -> int:
    return value * 24 if unit == "day" else (value // 60 if unit == "min" else value)


def parse_wgrib_idx(text: str) -> list[Record]:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    rows = []
    for ln in lines:
        parts = ln.split(":")
        if len(parts) < 6:
            continue
        try:
            start = int(parts[1])
        except ValueError:
            continue
        rows.append((start, parts))
    records: list[Record] = []
    for i, (start, parts) in enumerate(rows):
        end = rows[i + 1][0] - 1 if i + 1 < len(rows) else None
        var, level, time = parts[3], parts[4], parts[5]
        extra = ":".join(parts[6:]).strip(":")
        rec = Record(start=start, end=end, var=var, level=level, time=time, extra=extra)
        m = _INTERVAL.match(time)
        if m:
            rec.t0 = _hours(int(m.group(1)), m.group(3))
            rec.t1 = _hours(int(m.group(2)), m.group(3))
            rec.tkind = m.group(4)
        else:
            m = _INSTANT.match(time)
            if m:
                rec.t0 = rec.t1 = _hours(int(m.group(1)), m.group(2))
            rec.tkind = "instant"
        records.append(rec)
    return records


def parse_ecmwf_index(text: str) -> list[Record]:
    records: list[Record] = []
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            d = json.loads(ln)
        except json.JSONDecodeError:
            continue
        off, length = int(d["_offset"]), int(d["_length"])
        param = d.get("param", "")
        step = str(d.get("step", "0"))
        if "-" in step:
            a, b = (int(x) for x in step.split("-", 1))
        else:
            a = b = int(step)
        rec = Record(
            start=off, end=off + length - 1, param=param, levtype=d.get("levtype", ""),
            levelist=str(d.get("levelist", "")), t0=a, t1=b,
        )
        if param in ECMWF_ACCUM:
            rec.tkind, rec.t0 = "acc", 0
        records.append(rec)
    return records


@dataclass(frozen=True)
class W:
    """Selector for an NCEP (wgrib-style) index record."""

    var: str
    levels: tuple[str, ...] | str
    kind: str = "instant"
    product: str | None = None
    extra: str | None = None

    def lv(self) -> tuple[str, ...]:
        return (self.levels,) if isinstance(self.levels, str) else self.levels

    def matches(self, r: Record) -> bool:
        if r.var != self.var or r.level not in self.lv():
            return False
        if self.extra is not None and self.extra not in r.extra:
            return False
        if self.extra is None and r.extra and ("prob" in r.extra or "aerosol" in r.extra):
            return False
        if self.kind == "any":
            return True
        return r.tkind == self.kind


@dataclass(frozen=True)
class E:
    """Selector for an ECMWF open-data index record."""

    param: str
    levtype: str = "sfc"
    level: str | None = None
    product: str | None = None

    def matches(self, r: Record) -> bool:
        return (
            r.param == self.param
            and r.levtype == self.levtype
            and (self.level is None or r.levelist == self.level)
        )


def select(records: list[Record], sel, fhr: int) -> Record | None:
    """Pick the record for ``sel`` valid at ``fhr``."""
    hits = [r for r in records if sel.matches(r)]
    if not hits:
        return None
    if isinstance(sel, W) and sel.kind in ("max", "min", "ave"):
        ending = [r for r in hits if r.t1 == fhr]
        if ending:
            # prefer the shortest interval ending now (e.g. hourly max)
            return max(ending, key=lambda r: r.t0)
    return hits[0]


def interval_records(records: list[Record], sel, end: int) -> list[Record]:
    """All accumulation/average records for ``sel`` ending at ``end``."""
    if isinstance(sel, W):
        base = W(sel.var, sel.levels, "any", sel.product, sel.extra)
        return [r for r in records if base.matches(r) and r.tkind in ("acc", "ave") and r.t1 == end]
    return [r for r in records if sel.matches(r)]


# --------------------------------------------------------------------------- decoding

@dataclass
class Decoded:
    values: np.ndarray  # float32 (nj, ni), NaN = missing
    grid: dict
    uv_grid_relative: bool = False
    short_name: str = ""
    units: str = ""


def decode_message(data: bytes) -> Decoded:
    import eccodes

    h = eccodes.codes_new_from_message(data)
    try:
        get = eccodes.codes_get
        grid_type = get(h, "gridType")
        ni = int(get(h, "Ni") if grid_type != "lambert" else get(h, "Nx"))
        nj = int(get(h, "Nj") if grid_type != "lambert" else get(h, "Ny"))
        values = eccodes.codes_get_values(h).astype(np.float32, copy=False)
        if get(h, "bitmapPresent"):
            missing = get(h, "missingValue")
            values[values == missing] = np.nan
        if grid_type == "regular_ll":
            grid = {
                "type": "latlon", "ni": ni, "nj": nj,
                "la1": float(get(h, "latitudeOfFirstGridPointInDegrees")),
                "lo1": float(get(h, "longitudeOfFirstGridPointInDegrees")),
                "dlon": float(get(h, "iDirectionIncrementInDegrees")) * (-1 if get(h, "iScansNegatively") else 1),
                "dlat": float(get(h, "jDirectionIncrementInDegrees")) * (1 if get(h, "jScansPositively") else -1),
            }
        elif grid_type == "lambert":
            grid = {
                "type": "lambert", "ni": ni, "nj": nj,
                "la1": float(get(h, "latitudeOfFirstGridPointInDegrees")),
                "lo1": float(get(h, "longitudeOfFirstGridPointInDegrees")),
                "lov": float(get(h, "LoVInDegrees")),
                "lad": float(get(h, "LaDInDegrees")),
                "latin1": float(get(h, "Latin1InDegrees")),
                "latin2": float(get(h, "Latin2InDegrees")),
                "dx": float(get(h, "DxInMetres")),
                "dy": float(get(h, "DyInMetres")),
                "jpos": int(get(h, "jScansPositively")),
            }
        else:
            raise ValueError(f"unsupported grid type {grid_type}")
        try:
            uv_rel = bool(get(h, "uvRelativeToGrid"))
        except Exception:
            uv_rel = False
        short = units = ""
        try:
            short = get(h, "shortName")
            units = get(h, "units")
        except Exception:
            pass
        return Decoded(values.reshape(nj, ni), grid, uv_rel, short, units)
    finally:
        eccodes.codes_release(h)


# --------------------------------------------------------------------------- grids

@dataclass
class Grid:
    id: str
    spec: dict
    _latlon: tuple[np.ndarray, np.ndarray] | None = field(default=None, repr=False)

    @property
    def ni(self) -> int:
        return self.spec["ni"]

    @property
    def nj(self) -> int:
        return self.spec["nj"]

    def client(self) -> dict:
        s = dict(self.spec)
        s["id"] = self.id
        if s["type"] == "latlon":
            s["wrap"] = abs(abs(s["dlon"]) * s["ni"] - 360.0) < 1e-6
        else:
            s.update(lambert_constants(s))
        s["bbox"] = self.bbox()
        return s

    def latlon(self) -> tuple[np.ndarray, np.ndarray]:
        """Latitude/longitude arrays (float32, shape (nj, ni)), longitudes in [-180, 180)."""
        if self._latlon is None:
            s = self.spec
            if s["type"] == "latlon":
                lats = s["la1"] + s["dlat"] * np.arange(s["nj"], dtype=np.float64)
                lons = s["lo1"] + s["dlon"] * np.arange(s["ni"], dtype=np.float64)
                lons = (lons + 180.0) % 360.0 - 180.0
                lat2, lon2 = np.meshgrid(lats, lons, indexing="ij")
            else:
                c = lambert_constants(s)
                i = np.arange(s["ni"], dtype=np.float64)
                j = np.arange(s["nj"], dtype=np.float64)
                jj, ii = np.meshgrid(j, i, indexing="ij")
                x = c["x1"] + ii * s["dx"]
                y = c["y1"] + jj * s["dy"] * (1 if s.get("jpos", 1) else -1)
                lat2, lon2 = lambert_inverse(x, y, s, c)
            self._latlon = (lat2.astype(np.float32), lon2.astype(np.float32))
        return self._latlon

    def bbox(self) -> list[float]:
        s = self.spec
        if s["type"] == "latlon":
            if abs(abs(s["dlon"]) * s["ni"] - 360.0) < 1e-6:
                lat_a, lat_b = s["la1"], s["la1"] + s["dlat"] * (s["nj"] - 1)
                return [-180.0, min(lat_a, lat_b), 180.0, max(lat_a, lat_b)]
        lat, lon = self.latlon()
        return [float(np.nanmin(lon)), float(np.nanmin(lat)), float(np.nanmax(lon)), float(np.nanmax(lat))]


def lambert_constants(s: dict) -> dict:
    phi1, phi2 = math.radians(s["latin1"]), math.radians(s["latin2"])
    if abs(phi1 - phi2) < 1e-10:
        n = math.sin(phi1)
    else:
        n = math.log(math.cos(phi1) / math.cos(phi2)) / math.log(
            math.tan(math.pi / 4 + phi2 / 2) / math.tan(math.pi / 4 + phi1 / 2)
        )
    F = math.cos(phi1) * math.tan(math.pi / 4 + phi1 / 2) ** n / n
    RF = EARTH_R * F

    def rho(lat_deg: float) -> float:
        return RF / math.tan(math.pi / 4 + math.radians(lat_deg) / 2) ** n

    rho0 = rho(s["lad"])
    dl = math.radians(((s["lo1"] - s["lov"] + 180.0) % 360.0) - 180.0)
    r1 = rho(s["la1"])
    x1 = r1 * math.sin(n * dl)
    y1 = rho0 - r1 * math.cos(n * dl)
    return {"n": n, "RF": RF, "rho0": rho0, "x1": x1, "y1": y1}


def lambert_forward(lat, lon, s: dict, c: dict | None = None):
    c = c or lambert_constants(s)
    n, RF, rho0 = c["n"], c["RF"], c["rho0"]
    lat = np.radians(np.asarray(lat, dtype=np.float64))
    dl = np.radians(((np.asarray(lon, dtype=np.float64) - s["lov"] + 180.0) % 360.0) - 180.0)
    rho = RF / np.tan(np.pi / 4 + lat / 2) ** n
    x = rho * np.sin(n * dl)
    y = rho0 - rho * np.cos(n * dl)
    i = (x - c["x1"]) / s["dx"]
    j = (y - c["y1"]) / s["dy"] * (1 if s.get("jpos", 1) else -1)
    return i, j


def lambert_inverse(x, y, s: dict, c: dict):
    n, RF, rho0 = c["n"], c["RF"], c["rho0"]
    dy = rho0 - y
    rho = np.sign(n) * np.sqrt(x * x + dy * dy)
    theta = np.arctan2(np.sign(n) * x, np.sign(n) * dy)
    lat = 2.0 * np.arctan((RF / rho) ** (1.0 / n)) - np.pi / 2
    lon = s["lov"] + np.degrees(theta / n)
    lon = (lon + 180.0) % 360.0 - 180.0
    return np.degrees(lat), lon


def grid_id(spec: dict) -> str:
    if spec["type"] == "lambert" and spec["ni"] == 1799 and spec["nj"] == 1059 and abs(spec["lov"] - 262.5) < 1e-6:
        return "conus3km"
    if spec["type"] == "latlon" and spec["ni"] == 1440 and spec["nj"] == 721:
        return "ll0p25" if abs(spec["lo1"]) < 1e-6 else "ll0p25e"
    key = json.dumps(spec, sort_keys=True)
    return f"{spec['type']}-{spec['ni']}x{spec['nj']}-{hashlib.sha1(key.encode()).hexdigest()[:8]}"


_GRIDS: dict[str, Grid] = {}


def register_grid(spec: dict) -> Grid:
    gid = grid_id(spec)
    g = _GRIDS.get(gid)
    if g is None:
        spec = dict(spec)
        if spec["type"] == "lambert":
            spec["lov"] = ((spec["lov"] + 180.0) % 360.0) - 180.0
            spec["lo1"] = ((spec["lo1"] + 180.0) % 360.0) - 180.0
        else:
            spec["lo1"] = ((spec["lo1"] + 180.0) % 360.0) - 180.0
        g = Grid(gid, spec)
        _GRIDS[gid] = g
    return g


def get_grid(gid: str) -> Grid | None:
    return _GRIDS.get(gid)


_BASE_KEYS = {
    "latlon": ("type", "ni", "nj", "la1", "lo1", "dlon", "dlat"),
    "lambert": ("type", "ni", "nj", "la1", "lo1", "lov", "lad", "latin1", "latin2", "dx", "dy", "jpos"),
}


def grid_from_client(spec: dict) -> Grid:
    """Recreate a grid from the client spec stored in a frame header (e.g. after restart)."""
    gid = spec["id"]
    g = _GRIDS.get(gid)
    if g is None:
        base = {k: spec[k] for k in _BASE_KEYS[spec["type"]] if k in spec}
        g = Grid(gid, base)
        _GRIDS[gid] = g
    return g


def all_grids() -> dict[str, Grid]:
    return _GRIDS


# --------------------------------------------------------------------------- wind tools

def rotate_to_earth(u: np.ndarray, v: np.ndarray, grid: Grid) -> tuple[np.ndarray, np.ndarray]:
    """Rotate grid-relative Lambert winds to earth-relative (NCEP convention)."""
    s = grid.spec
    if s["type"] != "lambert":
        return u, v
    c = lambert_constants(s)
    _, lon = grid.latlon()
    lov = s["lov"]
    dl = np.radians(((lon.astype(np.float64) - lov + 180.0) % 360.0) - 180.0)
    alpha = c["n"] * dl
    ca, sa = np.cos(alpha).astype(np.float32), np.sin(alpha).astype(np.float32)
    return ca * u + sa * v, -sa * u + ca * v


def abs_vorticity_latlon(u: np.ndarray, v: np.ndarray, grid: Grid) -> np.ndarray:
    """Absolute vorticity on a regular lat/lon grid (s^-1)."""
    s = grid.spec
    lat, _ = grid.latlon()
    phi = np.radians(np.clip(lat.astype(np.float64), -89.5, 89.5))
    dlam = math.radians(s["dlon"])
    dphi = math.radians(s["dlat"])
    wrap = abs(abs(s["dlon"]) * s["ni"] - 360.0) < 1e-6
    if wrap:
        dvdl = (np.roll(v, -1, axis=1) - np.roll(v, 1, axis=1)) / (2 * dlam)
    else:
        dvdl = np.gradient(v, dlam, axis=1)
    dudp = np.gradient(u, dphi, axis=0)
    cos = np.clip(np.cos(phi), 1e-3, None)
    zeta = (dvdl / cos - dudp) / EARTH_R + u * np.tan(phi) / EARTH_R
    f = 2 * 7.2921e-5 * np.sin(phi)
    return (zeta + f).astype(np.float32)


def coriolis(grid: Grid) -> np.ndarray:
    lat, _ = grid.latlon()
    return (2 * 7.2921e-5 * np.sin(np.radians(lat))).astype(np.float32)
