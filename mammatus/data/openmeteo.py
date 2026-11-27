"""Point forecasts from Open-Meteo: multi-model meteograms, soundings,
15-minute precipitation, elevation and place search.

The base URL is configurable so a self-hosted Open-Meteo container can be used.
Responses are cached briefly to stay well inside the free API's fair-use limits.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .http import FetchError, get_json

log = logging.getLogger("mammatus.openmeteo")

METEOGRAM_VARS = [
    "temperature_2m", "dew_point_2m", "apparent_temperature", "relative_humidity_2m",
    "precipitation", "rain", "showers", "snowfall", "weather_code", "cloud_cover",
    "pressure_msl", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
    "freezing_level_height", "cape", "visibility",
]
LEVELS = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 650, 600, 550,
          500, 450, 400, 350, 300, 250, 200, 150, 100]
LEVEL_VARS = ["temperature", "dew_point", "relative_humidity", "wind_speed", "wind_direction", "geopotential_height"]
SKY_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100]
SKY_LEVEL_VARS = ["cloud_cover", "temperature", "geopotential_height", "wind_speed", "wind_direction"]
SKY_SURFACE_VARS = ["temperature_2m", "dew_point_2m", "surface_pressure", "cape", "cloud_cover", "cloud_cover_low",
                    "cloud_cover_mid", "cloud_cover_high", "rain", "showers", "snowfall", "visibility"]
SURFACE_VARS = ["temperature_2m", "dew_point_2m", "surface_pressure", "wind_speed_10m",
                "wind_direction_10m", "cape", "convective_inhibition", "freezing_level_height"]


class RateLimited(FetchError):
    pass


class OpenMeteo:
    def __init__(self, base: str, geocode_base: str, api_key: str | None = None):
        self.base = base.rstrip("/")
        self.geocode_base = geocode_base.rstrip("/")
        self.key = api_key
        self._cache: dict[tuple, tuple[float, Any]] = {}
        self._locks: dict[tuple, asyncio.Lock] = {}
        self.calls = 0

    def configure(self, base: str | None = None, geocode_base: str | None = None, api_key: str | None = None):
        if base:
            self.base = base.rstrip("/")
        if geocode_base:
            self.geocode_base = geocode_base.rstrip("/")
        self.key = api_key or self.key

    async def _get(self, path: str, params: dict, ttl: float, base: str | None = None) -> Any:
        key = (base or self.base, path, tuple(sorted(params.items())))
        hit = self._cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
            q = dict(params)
            if self.key:
                q["apikey"] = self.key
            try:
                data = await get_json(f"{base or self.base}{path}", params=q, retries=1, timeout=30)
            except FetchError as exc:
                if exc.status == 429:
                    raise RateLimited("Open-Meteo rate limit reached. Try again later, or point Mammatus at a self-hosted Open-Meteo.", 429) from exc
                raise
            self.calls += 1
            if isinstance(data, dict) and data.get("error"):
                raise FetchError(data.get("reason") or "Open-Meteo error", 400)
            self._cache[key] = (time.time(), data)
            if len(self._cache) > 600:
                for k, _ in sorted(self._cache.items(), key=lambda kv: kv[1][0])[:300]:
                    self._cache.pop(k, None)
            self._locks.pop(key, None)
            return data

    async def meteogram(self, lat: float, lon: float, models: list[str], elevation: float | None = None,
                        days: int = 16) -> dict:
        params = {
            "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "hourly": ",".join(METEOGRAM_VARS),
            "models": ",".join(models), "timeformat": "unixtime", "timezone": "GMT",
            "forecast_days": str(days), "past_hours": "6", "wind_speed_unit": "ms",
        }
        if elevation is not None:
            params["elevation"] = f"{elevation:.0f}"
        data = await self._get("/v1/forecast", params, ttl=900)
        return normalize_multi(data, models, METEOGRAM_VARS)

    async def sounding(self, lat: float, lon: float, model: str, days: int = 4) -> dict:
        hourly = [f"{v}_{p}hPa" for v in LEVEL_VARS for p in LEVELS] + SURFACE_VARS
        params = {
            "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "hourly": ",".join(hourly),
            "models": model, "timeformat": "unixtime", "timezone": "GMT",
            "forecast_days": str(days), "past_hours": "3", "wind_speed_unit": "ms",
        }
        data = await self._get("/v1/forecast", params, ttl=900)
        h = data.get("hourly") or {}

        def col(name: str) -> list:
            return h.get(name) or h.get(f"{name}_{model}") or []

        levels = {}
        for p in LEVELS:
            levels[str(p)] = {v: col(f"{v}_{p}hPa") for v in LEVEL_VARS}
        return {
            "lat": data.get("latitude"), "lon": data.get("longitude"), "elevation": data.get("elevation"),
            "model": model, "time": h.get("time", []), "levels": levels,
            "surface": {v: col(v) for v in SURFACE_VARS},
        }

    async def sky(self, lat: float, lon: float, model: str, days: int = 7) -> dict:
        """Cloud cover, temperature and wind by height for the Sky view fallback.

        Open-Meteo derives pressure-level cloud cover from relative humidity, so this is an
        estimate of where cloud is, not the model's own cloud water.
        """
        hourly = [f"{v}_{p}hPa" for v in SKY_LEVEL_VARS for p in SKY_LEVELS] + SKY_SURFACE_VARS
        params = {
            "latitude": f"{lat:.3f}", "longitude": f"{lon:.3f}", "hourly": ",".join(hourly),
            "models": model, "timeformat": "unixtime", "timezone": "GMT",
            "forecast_days": str(days), "past_hours": "6", "wind_speed_unit": "ms",
        }
        data = await self._get("/v1/forecast", params, ttl=1800)
        h = data.get("hourly") or {}

        def col(name: str) -> list:
            return h.get(name) or h.get(f"{name}_{model}") or []

        return {
            "lat": data.get("latitude"), "lon": data.get("longitude"), "elevation": data.get("elevation"),
            "model": model, "time": h.get("time", []), "plevels": [str(p) for p in SKY_LEVELS],
            "levels": {str(p): {v: col(f"{v}_{p}hPa") for v in SKY_LEVEL_VARS} for p in SKY_LEVELS},
            "surface": {v: col(v) for v in SKY_SURFACE_VARS},
        }

    async def minutely(self, lat: float, lon: float) -> dict:
        params = {
            "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}", "minutely_15": "precipitation,snowfall,weather_code",
            "forecast_minutely_15": "16", "timeformat": "unixtime", "timezone": "GMT",
        }
        return await self._get("/v1/forecast", params, ttl=600)

    async def elevation(self, lat: float, lon: float) -> float | None:
        try:
            data = await self._get("/v1/elevation", {"latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}"}, ttl=86400)
            vals = (data or {}).get("elevation") or []
            return float(vals[0]) if vals else None
        except FetchError:
            return None

    async def search(self, name: str, count: int = 8) -> list[dict]:
        data = await self._get("/v1/search", {"name": name, "count": str(count), "language": "en", "format": "json"},
                               ttl=3600, base=self.geocode_base)
        out = []
        for r in (data or {}).get("results", []) or []:
            out.append({
                "name": r.get("name"), "admin1": r.get("admin1"), "country": r.get("country_code"),
                "lat": r.get("latitude"), "lon": r.get("longitude"), "elevation": r.get("elevation"),
                "population": r.get("population"),
            })
        return out


def normalize_multi(data: dict, models: list[str], variables: list[str]) -> dict:
    """Split Open-Meteo's suffixed multi-model keys into {model: {var: [...]}}.

    Only list-valued series are kept, so an unexpected response shape degrades to fewer models."""
    data = data if isinstance(data, dict) else {}
    h = data.get("hourly")
    h = h if isinstance(h, dict) else {}
    out_models: dict[str, dict] = {}
    for m in models:
        series = {}
        for v in variables:
            arr = h.get(f"{v}_{m}")
            if arr is None and len(models) == 1:
                arr = h.get(v)
            if isinstance(arr, list):
                series[v] = arr
        if any(any(x is not None for x in arr) for arr in series.values()):
            out_models[m] = series
    times = h.get("time")
    return {
        "lat": data.get("latitude"), "lon": data.get("longitude"),
        "elevation": data.get("elevation"), "time": times if isinstance(times, list) else [], "models": out_models,
    }
