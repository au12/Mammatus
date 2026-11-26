"""National Weather Service alerts (api.weather.gov), compacted for the map."""

from __future__ import annotations

import asyncio
import logging
import time

from .http import FetchError, get_json

log = logging.getLogger("mammatus.nws")

API = "https://api.weather.gov"

# Official NWS hazard map colors for common products.
COLORS = {
    "Tornado Warning": "#FF0000", "Tornado Watch": "#FFFF00", "Tornado Emergency": "#FF00FF",
    "Severe Thunderstorm Warning": "#FFA500", "Severe Thunderstorm Watch": "#DB7093",
    "Flash Flood Warning": "#8B0000", "Flash Flood Emergency": "#8B0000", "Flash Flood Watch": "#2E8B57",
    "Flood Warning": "#00FF00", "Flood Watch": "#2E8B57", "Flood Advisory": "#00FF7F",
    "Coastal Flood Warning": "#228B22", "Coastal Flood Advisory": "#7CFC00", "Coastal Flood Watch": "#66CDAA",
    "Winter Storm Warning": "#FF69B4", "Winter Storm Watch": "#4682B4", "Winter Weather Advisory": "#7B68EE",
    "Blizzard Warning": "#FF4500", "Ice Storm Warning": "#8B008B", "Lake Effect Snow Warning": "#008B8B",
    "Lake Effect Snow Advisory": "#48D1CC", "Freezing Rain Advisory": "#DA70D6",
    "High Wind Warning": "#DAA520", "High Wind Watch": "#B8860B", "Wind Advisory": "#D2B48C",
    "Extreme Wind Warning": "#FF8C00", "Wind Chill Warning": "#B0C4DE", "Wind Chill Advisory": "#AFEEEE",
    "Extreme Cold Warning": "#0000FF", "Extreme Cold Watch": "#5F9EA0", "Cold Weather Advisory": "#AFEEEE",
    "Freeze Warning": "#483D8B", "Freeze Watch": "#00FFFF", "Frost Advisory": "#6495ED",
    "Heat Advisory": "#FF7F50", "Excessive Heat Warning": "#C71585", "Extreme Heat Warning": "#C71585",
    "Excessive Heat Watch": "#800000", "Extreme Heat Watch": "#800000",
    "Dense Fog Advisory": "#708090", "Dense Smoke Advisory": "#F0E68C", "Air Quality Alert": "#808080",
    "Red Flag Warning": "#FF1493", "Fire Weather Watch": "#FFDEAD", "Special Weather Statement": "#FFE4B5",
    "Hurricane Warning": "#DC143C", "Hurricane Watch": "#FF00FF", "Tropical Storm Warning": "#B22222",
    "Tropical Storm Watch": "#F08080", "Storm Surge Warning": "#B524F7", "Storm Surge Watch": "#DB7FF7",
    "Gale Warning": "#DDA0DD", "Storm Warning": "#9400D3", "Small Craft Advisory": "#D8BFD8",
    "Special Marine Warning": "#FFA500", "Dust Storm Warning": "#FFE4C4", "Blowing Dust Advisory": "#BDB76B",
    "Avalanche Warning": "#1E90FF", "Snow Squall Warning": "#C71585", "Hard Freeze Warning": "#9400D3",
}

SEVERITY_RANK = {"Extreme": 4, "Severe": 3, "Moderate": 2, "Minor": 1, "Unknown": 0}


def _round_ring(ring):
    out = []
    last = None
    for lon, lat in ring:
        p = (round(lon, 3), round(lat, 3))
        if p != last:
            out.append(p)
            last = p
    return out


def compact(feature: dict) -> dict | None:
    p = feature.get("properties") or {}
    if p.get("status") not in (None, "Actual"):
        return None
    event = p.get("event") or "Alert"
    geom = feature.get("geometry")
    polys = None
    if geom and geom.get("type") == "Polygon":
        polys = [[_round_ring(r) for r in geom["coordinates"]]]
    elif geom and geom.get("type") == "MultiPolygon":
        polys = [[_round_ring(r) for r in poly] for poly in geom["coordinates"]]
    same = (p.get("geocode") or {}).get("SAME") or []
    fips = sorted({s[1:] for s in same if len(s) == 6 and s.isdigit()})
    return {
        "id": p.get("id") or feature.get("id"),
        "event": event,
        "severity": p.get("severity") or "Unknown",
        "urgency": p.get("urgency"),
        "certainty": p.get("certainty"),
        "headline": p.get("headline") or event,
        "area": p.get("areaDesc") or "",
        "sent": p.get("sent"),
        "onset": p.get("onset") or p.get("effective"),
        "ends": p.get("ends") or p.get("expires"),
        "sender": p.get("senderName"),
        "color": COLORS.get(event, "#E0E0E0"),
        "polys": polys,
        "fips": fips if not polys else [],
        "msgType": p.get("messageType"),
    }


class NWSService:
    def __init__(self):
        self._all: tuple[float, list[dict]] | None = None
        self._lock = asyncio.Lock()
        self._points: dict[tuple[float, float], tuple[float, list[dict]]] = {}
        self._details: dict[str, tuple[float, dict]] = {}

    async def active(self, max_age: float = 120) -> list[dict]:
        async with self._lock:
            if self._all and time.time() - self._all[0] < max_age:
                return self._all[1]
            data = await get_json(f"{API}/alerts/active", params={"status": "actual"},
                                  headers={"Accept": "application/geo+json"}, timeout=40)
            items = [c for c in (compact(f) for f in (data or {}).get("features", [])) if c]
            items.sort(key=lambda a: (-SEVERITY_RANK.get(a["severity"], 0), a["event"]))
            self._all = (time.time(), items)
            return items

    async def at_point(self, lat: float, lon: float, max_age: float = 110) -> list[dict]:
        key = (round(lat, 3), round(lon, 3))
        hit = self._points.get(key)
        if hit and time.time() - hit[0] < max_age:
            return hit[1]
        data = await get_json(f"{API}/alerts/active", params={"point": f"{key[0]},{key[1]}"},
                              headers={"Accept": "application/geo+json"}, timeout=30)
        items = [c for c in (compact(f) for f in (data or {}).get("features", [])) if c]
        self._points[key] = (time.time(), items)
        if len(self._points) > 500:
            oldest = sorted(self._points.items(), key=lambda kv: kv[1][0])[:250]
            for k, _ in oldest:
                self._points.pop(k, None)
        return items

    async def detail(self, alert_id: str) -> dict:
        hit = self._details.get(alert_id)
        if hit and time.time() - hit[0] < 600:
            return hit[1]
        if not alert_id.startswith(f"{API}/alerts/"):
            alert_id = f"{API}/alerts/{alert_id.split('/')[-1]}"
        data = await get_json(alert_id, headers={"Accept": "application/geo+json"})
        p = (data or {}).get("properties") or {}
        out = {
            "id": p.get("id"), "event": p.get("event"), "headline": p.get("headline"),
            "description": p.get("description"), "instruction": p.get("instruction"),
            "area": p.get("areaDesc"), "sender": p.get("senderName"), "onset": p.get("onset"),
            "ends": p.get("ends") or p.get("expires"), "severity": p.get("severity"),
            "color": COLORS.get(p.get("event") or "", "#E0E0E0"),
        }
        self._details[alert_id] = (time.time(), out)
        return out
