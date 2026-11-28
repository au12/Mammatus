"""Notification rules and delivery (Web Push + in-app feed + live events).

Rule kinds:
  nws          NWS watches/warnings/advisories at a saved point
  threshold    a forecast metric crossing a value at a saved point (Open-Meteo, multi-model)
  precip_soon  precipitation starting within the hour at a saved point (15-minute data)
  run          a model run finished publishing
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .data.http import FetchError, get_client
from .data.nws import SEVERITY_RANK
from .db import get_db
from .webpush import PushGone, VapidKeys, send_push

log = logging.getLogger("mammatus.alerts")

PUSH_HOST_SUFFIXES = (
    ".googleapis.com", ".mozilla.com", ".mozilla.org", ".push.apple.com", ".notify.windows.com",
)

METRICS = {
    "snow": {"label": "Snowfall", "unit": "in", "agg": "sum", "var": "snowfall", "conv": lambda cm: cm / 2.54},
    "precip": {"label": "Precipitation", "unit": "in", "agg": "sum", "var": "precipitation", "conv": lambda mm: mm / 25.4},
    "tmin": {"label": "Low temperature", "unit": "°F", "agg": "min", "var": "temperature_2m", "conv": lambda c: c * 9 / 5 + 32},
    "tmax": {"label": "High temperature", "unit": "°F", "agg": "max", "var": "temperature_2m", "conv": lambda c: c * 9 / 5 + 32},
    "gust": {"label": "Wind gust", "unit": "mph", "agg": "max", "var": "wind_gusts_10m", "conv": lambda ms: ms * 2.23694},
}
DEFAULT_RULE_MODELS = ["ncep_hrrr_conus", "ncep_rrfs_conus", "ncep_nbm_conus", "ncep_gfs_seamless", "ecmwf_ifs"]
SEVERITIES = ("Extreme", "Severe", "Moderate", "Minor")


def clean_rule_params(kind: str, params) -> dict:
    """Validated, normalized parameters for a notification rule; ValueError says what is wrong.

    Used by the API on the way in and by the engine on the way out, so a rule stored by an older
    version (or edited by hand) can never take the alert loops down for everyone."""
    from .data.catalog import METEOGRAM_MODELS
    from .data.models import REGISTRY

    p = params if isinstance(params, dict) else {}
    out: dict = {}
    if kind == "nws":
        sev = p.get("minSeverity", "Moderate")
        types = p.get("types", "warnings")
        if sev not in SEVERITIES:
            raise ValueError("Bad severity")
        if types not in ("warnings", "watches", "all"):
            raise ValueError("Bad alert types")
        out.update(minSeverity=sev, types=types)
    elif kind == "threshold":
        metric = p.get("metric")
        if not isinstance(metric, str) or metric not in METRICS:
            raise ValueError("Bad metric")
        try:
            value = float(p.get("value"))
            hours = int(p.get("hours", 48))
            need = int(p.get("agreement", 1))
        except (TypeError, ValueError, OverflowError):
            raise ValueError("Bad threshold") from None
        if not math.isfinite(value) or abs(value) > 1e6 or isinstance(p.get("value"), bool):
            raise ValueError("Bad threshold")
        if not 6 <= hours <= 240:
            raise ValueError("Window must be 6-240 hours")
        if not 1 <= need <= 10:
            raise ValueError("Bad model agreement")
        op = p.get("op", "<=" if METRICS[metric]["agg"] == "min" else ">=")
        if op not in (">=", "<="):
            raise ValueError("Bad comparison")
        out.update(metric=metric, value=value, hours=hours, op=op, agreement=need)
        models = p.get("models")
        if models is not None:
            known = {m["id"] for m in METEOGRAM_MODELS}
            if not isinstance(models, list) or len(models) > 10 or not all(isinstance(m, str) and m in known for m in models):
                raise ValueError("Bad models")
            out["models"] = models or None
    elif kind == "run":
        model = p.get("model")
        if not isinstance(model, str) or model not in REGISTRY:
            raise ValueError("Bad model")
        out["model"] = model
        complete = p.get("complete", True)
        if not isinstance(complete, bool):
            raise ValueError("Bad notify option")
        out["complete"] = complete   # False: as soon as the run's first hours are out
        cycles = p.get("cycles")
        if cycles is not None:
            if (not isinstance(cycles, list) or len(cycles) > 24
                    or not all(isinstance(c, int) and not isinstance(c, bool) and 0 <= c <= 23 for c in cycles)):
                raise ValueError("Bad cycles")
            out["cycles"] = sorted(set(cycles)) or None
    elif kind != "precip_soon":
        raise ValueError("Unknown rule type")
    return out


def push_endpoint_allowed(endpoint: str) -> bool:
    from urllib.parse import urlparse

    p = urlparse(endpoint)
    host = (p.hostname or "").lower()
    return p.scheme == "https" and any(host.endswith(s) or host == s.lstrip(".") for s in PUSH_HOST_SUFFIXES)


class Notifier:
    def __init__(self, vapid: VapidKeys, subject: str, events, tz: str):
        self.vapid = vapid
        self.subject = subject
        self.events = events
        self.tz = tz

    async def notify(self, user_id: int, kind: str, title: str, body: str, data: dict | None = None,
                     urgency: str = "normal", tag: str | None = None) -> int:
        db = get_db()
        data = data or {}
        nid = db.insert(
            "INSERT INTO notifications(user_id, created_at, kind, title, body, data) VALUES(?,?,?,?,?,?)",
            (user_id, int(time.time()), kind, title[:200], body[:1000], json.dumps(data)),
        )
        db.execute(
            "DELETE FROM notifications WHERE user_id=? AND id NOT IN "
            "(SELECT id FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 200)", (user_id, user_id),
        )
        payload = {"id": nid, "kind": kind, "title": title, "body": body, "data": data, "tag": tag or f"{kind}-{nid}"}
        self.events.publish("notification", payload, user_id=user_id)
        await self.push_user(user_id, payload, urgency=urgency, topic=tag)
        return nid

    async def push_user(self, user_id: int, payload: dict, urgency: str = "normal", topic: str | None = None) -> int:
        db = get_db()
        subs = db.all("SELECT * FROM push_subs WHERE user_id=?", (user_id,))
        sent = 0
        client = get_client()
        for s in subs:
            try:
                await send_push(client, self.vapid, self.subject, s["endpoint"], s["p256dh"], s["auth"], payload,
                                urgency=urgency, topic=topic)
                db.execute("UPDATE push_subs SET last_ok_at=?, fail_count=0 WHERE id=?", (int(time.time()), s["id"]))
                sent += 1
            except PushGone:
                db.execute("DELETE FROM push_subs WHERE id=?", (s["id"],))
                log.info("removed expired push subscription %s", s["id"])
            except Exception as exc:
                db.execute("UPDATE push_subs SET fail_count=fail_count+1 WHERE id=?", (s["id"],))
                db.execute("DELETE FROM push_subs WHERE id=? AND fail_count>=10", (s["id"],))
                log.warning("push to subscription %s failed: %s", s["id"], exc)
        return sent

    def local(self, ts: float) -> str:
        try:
            tz = ZoneInfo(self.tz)
        except Exception:
            tz = timezone.utc
        dt = datetime.fromtimestamp(ts, tz)
        return dt.strftime("%a %-I:%M %p").replace(":00 ", " ")


class RulesEngine:
    def __init__(self, notifier: Notifier, nws, openmeteo, runs):
        self.notifier = notifier
        self.nws = nws
        self.om = openmeteo
        self.runs = runs
        self._tasks: list[asyncio.Task] = []
        runs.on_update(self.on_run_update)

    # -- helpers -------------------------------------------------------------
    @staticmethod
    def _rules(kind: str) -> list[dict]:
        rows = get_db().all(
            "SELECT r.*, p.name pname, p.lat, p.lon, p.elev_m FROM rules r LEFT JOIN points p ON p.id=r.point_id "
            "JOIN users u ON u.id=r.user_id WHERE r.kind=? AND r.enabled=1 AND u.disabled=0", (kind,),
        )
        out = []
        for r in rows:
            try:
                r["params"] = clean_rule_params(kind, json.loads(r["params"] or "{}"))
                state = json.loads(r["state"] or "{}")
                r["state"] = state if isinstance(state, dict) else {}
            except (ValueError, TypeError) as exc:
                log.warning("skipping rule %s: %s", r.get("id"), exc)
                continue
            out.append(r)
        return out

    @staticmethod
    def _save_state(rule_id: int, state: dict) -> None:
        get_db().execute("UPDATE rules SET state=? WHERE id=?", (json.dumps(state), rule_id))

    # -- NWS -----------------------------------------------------------------
    async def check_nws(self) -> None:
        rules = [r for r in self._rules("nws") if r.get("lat") is not None]
        by_point: dict[tuple, list[dict]] = {}
        for r in rules:
            by_point.setdefault((round(r["lat"], 3), round(r["lon"], 3)), []).append(r)
        now = time.time()
        for (lat, lon), group in by_point.items():
            try:
                alerts = await self.nws.at_point(lat, lon)
            except FetchError as exc:
                log.debug("NWS point check failed: %s", exc)
                continue
            for r in group:
                minimum = SEVERITY_RANK.get(r["params"].get("minSeverity", "Moderate"), 2)
                kinds = r["params"].get("types", "warnings")
                seen: dict = r["state"].get("seen", {})
                changed = False
                for a in alerts:
                    if SEVERITY_RANK.get(a["severity"], 0) < minimum:
                        continue
                    ev = a["event"]
                    if kinds == "warnings" and not any(w in ev for w in ("Warning", "Emergency")):
                        continue
                    if kinds == "watches" and not any(w in ev for w in ("Warning", "Emergency", "Watch")):
                        continue
                    if a["id"] in seen:
                        continue
                    seen[a["id"]] = now + 3 * 86400
                    changed = True
                    ends = a.get("ends")
                    until = ""
                    if ends:
                        try:
                            until = " until " + self.notifier.local(datetime.fromisoformat(ends).timestamp())
                        except ValueError:
                            pass
                    urgent = "Warning" in ev or "Emergency" in ev
                    await self.notifier.notify(
                        r["user_id"], "nws", f"{ev} · {r['pname']}", f"{a['headline']}{until}".strip()[:300],
                        {"alert": a["id"], "point": r["point_id"], "url": f"/#alert={a['id']}", "color": a["color"]},
                        urgency="high" if urgent else "normal", tag=f"nws-{abs(hash(a['id'])) % 10**9}",
                    )
                for k in [k for k, exp in seen.items() if exp < now]:
                    seen.pop(k, None)
                    changed = True
                if changed:
                    r["state"]["seen"] = seen
                    self._save_state(r["id"], r["state"])

    # -- forecast thresholds -----------------------------------------------
    async def check_thresholds(self) -> None:
        rules = [r for r in self._rules("threshold") if r.get("lat") is not None]
        by_point: dict[tuple, list[dict]] = {}
        for r in rules:
            by_point.setdefault((round(r["lat"], 3), round(r["lon"], 3), r.get("elev_m")), []).append(r)
        for (lat, lon, elev), group in by_point.items():
            models = sorted({m for r in group for m in (r["params"].get("models") or DEFAULT_RULE_MODELS) if isinstance(m, str)})
            try:
                fc = await self.om.meteogram(lat, lon, models, elevation=elev, days=10)
            except FetchError as exc:
                log.debug("threshold fetch failed: %s", exc)
                continue
            for r in group:
                try:
                    await self._eval_threshold(r, fc)
                except Exception:
                    log.exception("threshold rule %s failed", r["id"])

    async def _eval_threshold(self, r: dict, fc: dict) -> None:
        p = r["params"]
        metric = METRICS.get(p.get("metric"))
        if not metric:
            return
        window = p["hours"]
        value = p["value"]
        op = p["op"]
        need = p["agreement"]  # how many models must agree
        times = fc.get("time") or []
        now = time.time()
        idx = [i for i, t in enumerate(times) if isinstance(t, (int, float)) and now <= t <= now + window * 3600]
        if not idx:
            return
        results = {}
        for m, series in (fc.get("models") or {}).items():
            arr = series.get(metric["var"]) if isinstance(series, dict) else None
            if not isinstance(arr, list) or not arr:
                continue
            vals = [arr[i] for i in idx if i < len(arr) and isinstance(arr[i], (int, float)) and math.isfinite(arr[i])]
            if not vals:
                continue
            agg = sum(vals) if metric["agg"] == "sum" else (min(vals) if metric["agg"] == "min" else max(vals))
            results[m] = metric["conv"](agg)
        if not results:
            return
        hits = {m: v for m, v in results.items() if (v >= value if op == ">=" else v <= value)}
        st = r["state"]
        active = len(hits) >= need
        if not active:
            if st.get("active"):
                st["active"] = False
                self._save_state(r["id"], st)
            return
        best = max(hits.values()) if op == ">=" else min(hits.values())
        last_val = st.get("value")
        cooldown = now - st.get("at", 0) > 6 * 3600
        grew = last_val is not None and (
            (op == ">=" and best >= last_val * 1.5 and best - last_val >= max(0.5, value * 0.25)) or
            (op == "<=" and best <= last_val - 5)
        )
        if st.get("active") and not (grew and cooldown):
            return
        names = {"ncep_hrrr_conus": "HRRR", "ncep_rrfs_conus": "RRFS", "ncep_nbm_conus": "NBM",
                 "ncep_gfs_seamless": "GFS", "ecmwf_ifs": "ECMWF", "ecmwf_ifs025": "ECMWF",
                 "ecmwf_aifs025_single": "AIFS", "icon_seamless": "ICON", "gem_seamless": "GEM"}
        detail = ", ".join(f"{names.get(m, m)} {v:.1f}" for m, v in sorted(hits.items(), key=lambda kv: -kv[1] if op == '>=' else kv[1])[:4])
        unit = metric["unit"]
        title = f"{metric['label']} {('≥' if op == '>=' else '≤')} {value:g} {unit} · {r['pname']}"
        body = f"Next {window} h: {detail} {unit}" + (" (forecast increased)" if st.get("active") else "")
        await self.notifier.notify(r["user_id"], "threshold", title, body,
                                   {"point": r["point_id"], "url": f"/#point={r['point_id']}&tab=meteogram"},
                                   tag=f"thr-{r['id']}")
        st.update({"active": True, "value": best, "at": now})
        self._save_state(r["id"], st)

    # -- precipitation starting soon ----------------------------------------
    async def check_precip_soon(self) -> None:
        rules = [r for r in self._rules("precip_soon") if r.get("lat") is not None]
        now = time.time()
        for r in rules:
            st = r["state"]
            if now - st.get("at", 0) < 3 * 3600:
                continue
            try:
                data = await self.om.minutely(r["lat"], r["lon"])
            except FetchError:
                continue
            m = (data or {}).get("minutely_15") or {}
            times, precip, snow = m.get("time") or [], m.get("precipitation") or [], m.get("snowfall") or []
            slots = [(t, p or 0, (snow[i] if i < len(snow) else 0) or 0) for i, (t, p) in enumerate(zip(times, precip)) if t >= now - 900]
            if len(slots) < 3:
                continue
            dry_now = slots[0][1] < 0.05
            upcoming = [s for s in slots[1:5] if s[1] >= 0.1]
            if not (dry_now and upcoming):
                continue
            t0, p0, s0 = upcoming[0]
            kind = "Snow" if s0 > 0 else "Rain"
            mins = max(5, int(round((t0 - now) / 60 / 5) * 5))
            await self.notifier.notify(
                r["user_id"], "precip_soon", f"{kind} starting soon · {r['pname']}",
                f"{kind} expected around {self.notifier.local(t0)} (in about {mins} min).",
                {"point": r["point_id"], "url": "/#layer=radar"}, tag=f"soon-{r['id']}",
            )
            st["at"] = now
            self._save_state(r["id"], st)

    # -- model runs ----------------------------------------------------------
    async def on_run_update(self, model: str, info, new_steps: list[int]) -> None:
        if not info.steps:
            return
        cyc = info.client()["cycle"]
        for r in self._rules("run"):
            if r["params"].get("model") != model:
                continue
            whole = r["params"].get("complete", True)
            if whole and not info.complete:
                continue
            if cyc not in (r["params"].get("cycles") or [0, 6, 12, 18]):
                continue
            if r["state"].get("last") == info.run:
                continue
            r["state"]["last"] = info.run
            self._save_state(r["id"], r["state"])
            try:
                await self.notifier.notify(
                    r["user_id"], "run", f"{model.upper()} {cyc:02d}z is {'in' if whole else 'arriving'}",
                    f"All {len(info.steps)} forecast hours are available." if whole else
                    f"The first {len(info.steps)} forecast hour{'s are' if len(info.steps) != 1 else ' is'} out; the rest follow over the next while.",
                    {"url": f"/#model={model}&run={info.run}"}, tag=f"run-{model}",
                )
            except Exception:
                log.exception("run rule %s failed", r["id"])

    # -- loops ---------------------------------------------------------------
    async def _loop(self, fn, every: float, initial: float) -> None:
        await asyncio.sleep(initial)
        while True:
            try:
                await fn()
            except Exception:
                log.exception("%s failed", fn.__name__)
            await asyncio.sleep(every)

    def start(self) -> None:
        if self._tasks:
            return
        self._tasks = [
            asyncio.create_task(self._loop(self.check_nws, 120, 20), name="rules-nws"),
            asyncio.create_task(self._loop(self.check_thresholds, 1800, 60), name="rules-threshold"),
            asyncio.create_task(self._loop(self.check_precip_soon, 600, 40), name="rules-precip"),
        ]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks = []
