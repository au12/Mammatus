"""Model registry: where each model's files live and which steps each cycle has.

Sources are tried in order; the first that answers is used. Run discovery uses
a single bucket listing per run instead of probing every forecast hour.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

from .http import FetchError, list_gcs, list_s3

log = logging.getLogger("mammatus.models")

UTC = timezone.utc


def run_id(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H")


def parse_run(run: str) -> datetime:
    if not re.fullmatch(r"\d{10}", run):
        raise ValueError("bad run id")
    return datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=UTC)


@dataclass
class Source:
    name: str
    url: Callable[[str, datetime, int], str]  # (product, run, fhr) -> url of the GRIB file
    idx_suffix: str  # appended to the GRIB url for the index (".idx" or "")
    lister: Callable[[datetime], "object"] | None = None  # coroutine fn -> set of steps


@dataclass
class Model:
    id: str
    name: str
    short: str
    desc: str
    kind: str  # "cam" (convection-allowing regional) or "global"
    color: str
    cycle_hours: int
    lookback_cycles: int
    keep_runs: int
    idx_kind: str  # "wgrib" or "ecmwf"
    sources: list[Source] = field(default_factory=list)
    attribution: str = "NOAA/NCEP"
    publish_delay_min: int = 45  # rough time from cycle start to first file

    def expected_steps(self, cycle: int) -> list[int]:
        raise NotImplementedError

    def index_url(self, source: Source, product: str, run: datetime, fhr: int) -> str:
        url = source.url(product, run, fhr)
        if self.idx_kind == "ecmwf":
            return re.sub(r"\.grib2$", ".index", url)
        return url + source.idx_suffix

    def candidate_runs(self, now: datetime | None = None) -> list[datetime]:
        now = now or datetime.now(UTC)
        latest = now - timedelta(minutes=self.publish_delay_min)
        base = latest.replace(minute=0, second=0, microsecond=0)
        base = base.replace(hour=base.hour - base.hour % self.cycle_hours)
        return [base - timedelta(hours=self.cycle_hours * i) for i in range(self.lookback_cycles)]

    async def list_steps(self, run: datetime) -> list[int]:
        last_error: Exception | None = None
        for source in self.sources:
            if source.lister is None:
                continue
            try:
                steps = await source.lister(run)
                return sorted(steps)
            except FetchError as exc:
                last_error = exc
                log.debug("%s listing via %s failed: %s", self.id, source.name, exc)
        if last_error:
            raise last_error
        return []


# --------------------------------------------------------------------------- HRRR

class HRRR(Model):
    def expected_steps(self, cycle: int) -> list[int]:
        return list(range(0, 49 if cycle % 6 == 0 else 19))


def _hrrr_url(base: str):
    def url(product: str, run: datetime, fhr: int) -> str:
        return f"{base}/hrrr.{run:%Y%m%d}/conus/hrrr.t{run:%H}z.wrf{product}f{fhr:02d}.grib2"
    return url


async def _hrrr_list(run: datetime) -> set[int]:
    prefix = f"hrrr.{run:%Y%m%d}/conus/hrrr.t{run:%H}z.wrfsfcf"
    keys = await list_s3("https://noaa-hrrr-bdp-pds.s3.amazonaws.com", prefix)
    steps = set()
    for key, _ in keys:
        m = re.search(r"wrfsfcf(\d{2})\.grib2\.idx$", key)
        if m:
            steps.add(int(m.group(1)))
    return steps


# --------------------------------------------------------------------------- RRFS

class RRFS(Model):
    def expected_steps(self, cycle: int) -> list[int]:
        return list(range(0, 85 if cycle % 6 == 0 else 19))


def _rrfs_url(base: str):
    def url(product: str, run: datetime, fhr: int) -> str:
        return f"{base}/rrfs.{run:%Y%m%d}/{run:%H}/rrfs.t{run:%H}z.{product}.3km.f{fhr:03d}.conus.grib2"
    return url


async def _rrfs_list(run: datetime) -> set[int]:
    prefix = f"rrfs.{run:%Y%m%d}/{run:%H}/rrfs.t{run:%H}z.2dfld.3km.f"
    keys = await list_s3("https://noaa-rrfs-ops-pds.s3.amazonaws.com", prefix)
    steps = set()
    for key, _ in keys:
        m = re.search(r"2dfld\.3km\.f(\d{3})\.conus\.grib2\.idx$", key)
        if m:
            steps.add(int(m.group(1)))
    return steps


# --------------------------------------------------------------------------- GFS

class GFS(Model):
    def expected_steps(self, cycle: int) -> list[int]:
        return list(range(0, 121)) + list(range(123, 385, 3))


def _gfs_url(base: str):
    def url(product: str, run: datetime, fhr: int) -> str:
        return f"{base}/gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f{fhr:03d}"
    return url


async def _gfs_list(run: datetime) -> set[int]:
    prefix = f"gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f"
    keys = await list_s3("https://noaa-gfs-bdp-pds.s3.amazonaws.com", prefix)
    steps = set()
    for key, _ in keys:
        m = re.search(r"pgrb2\.0p25\.f(\d{3})\.idx$", key)
        if m:
            steps.add(int(m.group(1)))
    return steps


# --------------------------------------------------------------------------- ECMWF

class ECMWF(Model):
    stream_dir: str = "ifs/0p25/oper"

    def expected_steps(self, cycle: int) -> list[int]:
        if self.id == "aifs":
            return list(range(0, 361, 6))
        if cycle in (0, 12):
            return list(range(0, 145, 3)) + list(range(150, 361, 6))
        return list(range(0, 91, 3)) + list(range(96, 145, 6))


def _ec_url(base: str, stream_dir: str):
    def url(product: str, run: datetime, fhr: int) -> str:
        return f"{base}/{run:%Y%m%d}/{run:%H}z/{stream_dir}/{run:%Y%m%d%H}0000-{fhr}h-oper-fc.grib2"
    return url


def _ec_steps_from_keys(keys, run: datetime) -> set[int]:
    steps = set()
    pat = re.compile(rf"{run:%Y%m%d%H}0000-(\d+)h-oper-fc\.index$")
    for key, _ in keys:
        m = pat.search(key)
        if m:
            steps.add(int(m.group(1)))
    return steps


def _ec_lister_s3(stream_dir: str):
    async def lister(run: datetime) -> set[int]:
        prefix = f"{run:%Y%m%d}/{run:%H}z/{stream_dir}/"
        keys = await list_s3("https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com", prefix)
        return _ec_steps_from_keys(keys, run)
    return lister


def _ec_lister_gcs(stream_dir: str):
    async def lister(run: datetime) -> set[int]:
        prefix = f"{run:%Y%m%d}/{run:%H}z/{stream_dir}/"
        keys = await list_gcs("ecmwf-open-data", prefix)
        return _ec_steps_from_keys(keys, run)
    return lister


def build_registry() -> dict[str, Model]:
    hrrr = HRRR(
        id="hrrr", name="HRRR", short="HRRR",
        desc="High-Resolution Rapid Refresh · 3 km · CONUS · hourly runs to 18 h (48 h at 00/06/12/18z)",
        kind="cam", color="#ff8a5b", cycle_hours=1, lookback_cycles=8, keep_runs=6,
        idx_kind="wgrib", publish_delay_min=48,
        sources=[
            Source("aws", _hrrr_url("https://noaa-hrrr-bdp-pds.s3.amazonaws.com"), ".idx", _hrrr_list),
            Source("google", _hrrr_url("https://storage.googleapis.com/high-resolution-rapid-refresh"), ".idx"),
            Source("nomads", _hrrr_url("https://nomads.ncep.noaa.gov/pub/data/nccf/com/hrrr/prod"), ".idx"),
        ],
    )
    rrfs = RRFS(
        id="rrfs", name="RRFS", short="RRFS",
        desc="Rapid Refresh Forecast System · 3 km · CONUS · replaced the NAM in Nov 2026 · to 84 h at 00/06/12/18z",
        kind="cam", color="#c084fc", cycle_hours=1, lookback_cycles=8, keep_runs=6,
        idx_kind="wgrib", publish_delay_min=70,
        sources=[
            Source("aws", _rrfs_url("https://noaa-rrfs-ops-pds.s3.amazonaws.com"), ".idx", _rrfs_list),
            Source("nomads", _rrfs_url("https://nomads.ncep.noaa.gov/pub/data/nccf/com/rrfs/v1.0"), ".idx"),
        ],
    )
    gfs = GFS(
        id="gfs", name="GFS", short="GFS",
        desc="Global Forecast System · 0.25° · 4 runs/day to 384 h",
        kind="global", color="#4fd1c5", cycle_hours=6, lookback_cycles=4, keep_runs=3,
        idx_kind="wgrib", publish_delay_min=200,
        sources=[
            Source("aws", _gfs_url("https://noaa-gfs-bdp-pds.s3.amazonaws.com"), ".idx", _gfs_list),
            Source("google", _gfs_url("https://storage.googleapis.com/global-forecast-system"), ".idx"),
            Source("nomads", _gfs_url("https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"), ".idx"),
        ],
    )
    ec_dir = "ifs/0p25/oper"
    ecmwf = ECMWF(
        id="ecmwf", name="ECMWF IFS", short="ECMWF",
        desc="ECMWF Integrated Forecasting System open data · 0.25° · to 360 h at 00/12z",
        kind="global", color="#60a5fa", cycle_hours=6, lookback_cycles=4, keep_runs=3,
        idx_kind="ecmwf", publish_delay_min=330, attribution="ECMWF (CC BY 4.0)",
        sources=[
            Source("aws", _ec_url("https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com", ec_dir), "", _ec_lister_s3(ec_dir)),
            Source("google", _ec_url("https://storage.googleapis.com/ecmwf-open-data", ec_dir), "", _ec_lister_gcs(ec_dir)),
            Source("ecmwf", _ec_url("https://data.ecmwf.int/forecasts", ec_dir), ""),
        ],
    )
    ai_dir = "aifs-single/0p25/oper"
    aifs = ECMWF(
        id="aifs", name="ECMWF AIFS", short="AIFS",
        desc="ECMWF Artificial Intelligence Forecasting System · 0.25° · 6-hourly to 360 h",
        kind="global", color="#f472b6", cycle_hours=6, lookback_cycles=4, keep_runs=3,
        idx_kind="ecmwf", publish_delay_min=330, attribution="ECMWF (CC BY 4.0)",
        sources=[
            Source("aws", _ec_url("https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com", ai_dir), "", _ec_lister_s3(ai_dir)),
            Source("google", _ec_url("https://storage.googleapis.com/ecmwf-open-data", ai_dir), "", _ec_lister_gcs(ai_dir)),
            Source("ecmwf", _ec_url("https://data.ecmwf.int/forecasts", ai_dir), ""),
        ],
    )
    return {m.id: m for m in (hrrr, rrfs, gfs, ecmwf, aifs)}


REGISTRY = build_registry()
