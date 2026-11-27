"""National Weather Service alerts (api.weather.gov), compacted for the map."""

from __future__ import annotations

import asyncio
import math
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


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _round_ring(ring):
    """Rounded, de-duplicated ring of (lon, lat); points that are not finite pairs are dropped."""
    out = []
    last = None
    for pt in ring if isinstance(ring, (list, tuple)) else ():
        if not isinstance(pt, (list, tuple)) or len(pt) < 2 or not (_num(pt[0]) and _num(pt[1])):
            continue
        lon, lat = pt[0], pt[1]
        if abs(lat) > 90 or abs(lon) > 360:
            continue
        p = (round(lon, 3), round(lat, 3))
        if p != last:
            out.append(p)
            last = p
    return out


def _text(v, default: str = "") -> str:
    return v if isinstance(v, str) else default


def compact(feature: dict) -> dict | None:
    """The fields Mammatus uses from one NWS alert feature, or None if it should be skipped.

    Upstream JSON is trusted for nothing: an unexpected shape anywhere skips that part (or that
    alert), never the whole list."""
    if not isinstance(feature, dict):
        return None
    p = feature.get("properties")
    if not isinstance(p, dict):
        p = {}
    if p.get("status") not in (None, "Actual"):
        return None
    event = _text(p.get("event")) or "Alert"
    geom = feature.get("geometry")
    polys = None
    if isinstance(geom, dict):
        coords = geom.get("coordinates")
        if geom.get("type") == "Polygon" and isinstance(coords, list):
            rings = [r for r in (_round_ring(r) for r in coords) if len(r) >= 3]
            polys = [rings] if rings else None
        elif geom.get("type") == "MultiPolygon" and isinstance(coords, list):
            polys = [rings for rings in ([r for r in (_round_ring(r) for r in poly) if len(r) >= 3]
                                         for poly in coords if isinstance(poly, list)) if rings] or None
    geocode = p.get("geocode")
    same = geocode.get("SAME") if isinstance(geocode, dict) else None
    fips = sorted({s[1:] for s in same if isinstance(s, str) and len(s) == 6 and s.isascii() and s.isdigit()}) if isinstance(same, list) else []
    severity = _text(p.get("severity"), "Unknown")
    return {
        "id": _text(p.get("id")) or _text(feature.get("id")) or None,
        "event": event,
        "severity": severity if severity in SEVERITY_RANK else "Unknown",
        "urgency": _text(p.get("urgency")) or None,
        "certainty": _text(p.get("certainty")) or None,
        "headline": _text(p.get("headline")) or event,
        "area": _text(p.get("areaDesc")),
        "sent": _text(p.get("sent")) or None,
        "onset": _text(p.get("onset")) or _text(p.get("effective")) or None,
        "ends": _text(p.get("ends")) or _text(p.get("expires")) or None,
        "sender": _text(p.get("senderName")) or None,
        "color": COLORS.get(event, "#E0E0E0"),
        "polys": polys,
        "fips": fips if not polys else [],
        "msgType": _text(p.get("messageType")) or None,
    }


def compact_all(data) -> list[dict]:
    feats = data.get("features") if isinstance(data, dict) else None
    out = []
    for f in feats if isinstance(feats, list) else ():
        try:
            c = compact(f)
        except Exception:  # noqa: BLE001 - one bad alert must not hide the rest
            log.warning("skipping malformed NWS alert", exc_info=True)
            continue
        if c and c["id"]:
            out.append(c)
    return out


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
            items = compact_all(data)
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
        items = compact_all(data)
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
        p = data.get("properties") if isinstance(data, dict) else None
        if not isinstance(p, dict):
            p = {}
        out = {
            "id": p.get("id"), "event": p.get("event"), "headline": p.get("headline"),
            "description": p.get("description"), "instruction": p.get("instruction"),
            "area": p.get("areaDesc"), "sender": p.get("senderName"), "onset": p.get("onset"),
            "ends": p.get("ends") or p.get("expires"), "severity": p.get("severity"),
            "color": COLORS.get(p.get("event") if isinstance(p.get("event"), str) else "", "#E0E0E0"),
        }
        self._details[alert_id] = (time.time(), out)
        return out
