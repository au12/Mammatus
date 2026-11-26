"""Fronts, troughs and pressure centers from NOAA WPC's coded surface bulletins.

WPC hand-analyzes North America every 3 hours and forecasts the fronts 12 and 24 hours out.
Both are published as compact text through the NWS API:

* ``ASUS02 KWBC`` (CODSUS, high resolution) - the analysis, coordinates to 0.1 degree
* ``ASUS01 KWBC`` (CODSUS) - the same analysis to whole degrees (used only as a fallback)
* ``FSUS02 KWBC`` (CODSRP) - 12 and 24 hour forecast positions

Each feature is a keyword followed by points written as latitude then west longitude, e.g.
``4731193`` (47.3N 119.3W) or ``4185`` (41N 85W). Front symbols belong on the left of the
direction the points are listed in.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone

from .http import FetchError, get_json

log = logging.getLogger("mammatus.fronts")

API = "https://api.weather.gov"
UTC = timezone.utc
ATTRIBUTION = "NOAA/NWS Weather Prediction Center"

FRONT_TYPES = {
    "COLD": "cold", "WARM": "warm", "STNRY": "stationary", "OCFNT": "occluded",
    "TROF": "trough", "DRYLINE": "dryline", "DRYLN": "dryline", "SQLN": "squall", "SQUALL": "squall",
}
STRENGTHS = {"WK": "weak", "MDT": "moderate", "STG": "strong"}
KEYWORDS = set(FRONT_TYPES) | {"HIGHS", "LOWS"}
_VALID = re.compile(r"^(?:(\d+)\s*HR\s+PROG\s+)?VALID\s+(\d{6})Z", re.I)


def decode_point(code: str) -> tuple[float, float] | None:
    """Coded position -> (lon, lat). 7 digits: LLLllll in tenths; 4-5 digits: LLll(l) whole degrees."""
    if not code.isdigit():
        return None
    n = len(code)
    if n == 7:
        lat, lon = int(code[:3]) / 10, int(code[3:]) / 10
    elif n == 6:
        lat, lon = int(code[:3]) / 10, int(code[3:]) / 10
    elif n in (4, 5):
        lat, lon = float(code[:2]), float(code[2:])
    else:
        return None
    if lat > 90 or lon > 360:
        return None
    lon = -lon
    if lon < -180:
        lon += 360
    return round(lon, 2), round(lat, 2)


def _unwrap(points: list[tuple[float, float]]) -> list[list[float]]:
    """Keep longitudes continuous across the dateline so lines never jump around the globe."""
    out: list[list[float]] = []
    for lon, lat in points:
        if out:
            prev = out[-1][0]
            while lon - prev > 180:
                lon -= 360
            while lon - prev < -180:
                lon += 360
        if not out or out[-1] != [lon, lat]:
            out.append([lon, lat])
    return out


def _valid_time(kind: str, code: str, issued: datetime) -> datetime:
    """Analyses write MMDDHH; forecasts write DDHHMM. The year/month come from the issuance."""
    if kind == "analysis":
        month, day, hour, minute = int(code[:2]), int(code[2:4]), int(code[4:6]), 0
        year = issued.year - (1 if month == 12 and issued.month == 1 else 0)
    else:
        day, hour, minute = int(code[:2]), int(code[2:4]), int(code[4:6])
        year, month = issued.year, issued.month
        if day < issued.day - 15:  # forecast valid early next month
            month += 1
            if month > 12:
                year, month = year + 1, 1
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


def parse_bulletin(text: str, issued: datetime) -> list[dict]:
    """Parse one coded bulletin into feature sets (one per VALID block)."""
    sets: list[dict] = []
    cur: dict | None = None
    entry: list | None = None
    for raw in text.replace("\r", "").split("\n"):
        line = raw.strip()
        if not line or line.startswith("$$"):
            entry = None
            continue
        m = _VALID.match(line)
        if m:
            hours = int(m.group(1)) if m.group(1) else 0
            kind = "forecast" if m.group(1) else "analysis"
            try:
                valid = _valid_time(kind, m.group(2), issued)
            except ValueError:
                cur = None
                continue
            cur = {"kind": kind, "hours": hours, "valid": valid, "_entries": []}
            sets.append(cur)
            entry = None
            continue
        if cur is None:
            continue
        tokens = line.split()
        if tokens[0].upper() in KEYWORDS:
            entry = [tokens[0].upper(), tokens[1:]]
            cur["_entries"].append(entry)
        elif entry is not None and all(t.isdigit() for t in tokens):
            entry[1].extend(tokens)  # wrapped continuation line
        else:
            entry = None
    out = []
    for s in sets:
        highs, lows, fronts = [], [], []
        for kw, tokens in s.pop("_entries"):
            if kw in ("HIGHS", "LOWS"):
                target = highs if kw == "HIGHS" else lows
                for i in range(0, len(tokens) - 1, 2):
                    p = decode_point(tokens[i + 1])
                    if p and tokens[i].isdigit() and 850 <= int(tokens[i]) <= 1090:
                        target.append([p[0], p[1], int(tokens[i])])
                continue
            strength = None
            if tokens and tokens[0].upper() in STRENGTHS:
                strength = STRENGTHS[tokens[0].upper()]
                tokens = tokens[1:]
            pts = [p for p in (decode_point(t) for t in tokens) if p]
            coords = _unwrap(pts)
            if len(coords) >= 2:
                f = {"type": FRONT_TYPES[kw], "coords": coords}
                if strength:
                    f["strength"] = strength
                fronts.append(f)
        out.append({**s, "highs": highs, "lows": lows, "fronts": fronts})
    return out


class FrontsService:
    """Keeps the last ~12 h of analyses and the newest forecasts, refreshed at most every 10 min."""

    def __init__(self, ttl: float = 600):
        self.ttl = ttl
        self._products: dict[str, list[dict]] = {}
        self._result: dict | None = None
        self._at = 0.0
        self._lock = asyncio.Lock()

    async def sets(self) -> dict:
        async with self._lock:
            if self._result is None or time.time() - self._at > self.ttl:
                try:
                    await self._refresh()
                except FetchError:
                    if self._result is None:
                        raise
                    log.warning("fronts: refresh failed, serving the previous set")
                    self._at = time.time() - self.ttl + 120  # retry in two minutes
        return self._result

    async def _product(self, item: dict) -> list[dict]:
        pid = item["id"]
        if pid not in self._products:
            data = await get_json(f"{API}/products/{pid}", headers={"Accept": "application/ld+json"})
            issued = datetime.fromisoformat(item["issuanceTime"]).astimezone(UTC)
            sets = parse_bulletin((data or {}).get("productText") or "", issued)
            for s in sets:
                s["issued"] = issued
            self._products[pid] = sets
            if len(self._products) > 80:
                for k in list(self._products)[:40]:
                    self._products.pop(k, None)
        return self._products[pid]

    async def _refresh(self) -> None:
        data = await get_json(f"{API}/products/types/COD", headers={"Accept": "application/ld+json"})
        graph = sorted((data or {}).get("@graph", []), key=lambda p: p.get("issuanceTime", ""), reverse=True)
        now = datetime.now(UTC)
        recent = [p for p in graph if datetime.fromisoformat(p["issuanceTime"]) > now - timedelta(hours=14)]
        analyses = [p for p in recent if p.get("wmoCollectiveId") == "ASUS02"]
        if not analyses:
            analyses = [p for p in recent if p.get("wmoCollectiveId") == "ASUS01"]
        forecasts = [p for p in recent if p.get("wmoCollectiveId") == "FSUS02"][:4]
        chosen: dict[tuple[str, str], dict] = {}
        for item in analyses[:6] + forecasts:
            try:
                sets = await self._product(item)
            except FetchError as exc:
                log.warning("fronts: product %s failed: %s", item.get("id"), exc)
                continue
            for s in sets:
                key = (s["kind"], s["valid"].isoformat())
                # the newest issuance wins for each valid time (corrections come a few minutes later)
                if key not in chosen or s["issued"] > chosen[key]["issued"]:
                    chosen[key] = s
        out = []
        for s in sorted(chosen.values(), key=lambda s: (s["valid"], s["kind"])):
            out.append({
                "kind": s["kind"], "hours": s["hours"],
                "valid": s["valid"].strftime("%Y-%m-%dT%H:%M:%SZ"), "issued": s["issued"].strftime("%Y-%m-%dT%H:%M:%SZ"),
                "highs": s["highs"], "lows": s["lows"], "fronts": s["fronts"],
            })
        self._result = {"sets": out, "updated": round(time.time()), "attribution": ATTRIBUTION}
        self._at = time.time()
