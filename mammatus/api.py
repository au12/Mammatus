"""HTTP API: data (catalog, runs, frames, radar, satellite, alerts, points),
per-user resources (saved points, notification rules, push devices) and admin."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import __version__
from .alerts import DEFAULT_RULE_MODELS, METRICS, clean_rule_params, push_endpoint_allowed
from .auth import CurrentUser, require_admin, require_user
from .config import settings
from .data.catalog import (
    COLORMAPS, METEOGRAM_MODELS, PRODUCT_INDEX, PRODUCTS, REGIONS, SOUNDING_MODELS, VARS, var_models,
)
from .data.derive import NotAvailable
from .data.http import FetchError
from .data.models import REGISTRY
from .data.openmeteo import RateLimited
from .data.satellite import ATTRIBUTION as SAT_ATTRIBUTION, PRODUCTS as SAT_PRODUCTS
from .db import get_db
from .security import new_token, token_digest

log = logging.getLogger("mammatus.api")
router = APIRouter(prefix="/api")

# Ids are SQLite integers: anything outside this range is a bad request, not a server error.
Id = Annotated[int, Path(ge=1, le=2**62)]

IMMUTABLE = "private, max-age=31536000, immutable"


def svc(request: Request):
    return request.app.state.svc


def _frame_response(path, etag: str, request: Request) -> Response:
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": IMMUTABLE})
    return FileResponse(
        path, media_type="application/octet-stream",
        headers={"Content-Encoding": "gzip", "Cache-Control": IMMUTABLE, "ETag": etag, "Vary": "Cookie"},
    )


def _upstream_error(exc: Exception) -> HTTPException:
    if isinstance(exc, RateLimited):
        return HTTPException(429, str(exc))
    if isinstance(exc, NotAvailable):
        return HTTPException(404, str(exc))
    return HTTPException(502, f"Upstream data source error: {exc}")


# --------------------------------------------------------------------------- catalog & runs

@router.get("/catalog")
def catalog(request: Request, user: CurrentUser = Depends(require_user)):
    s = svc(request)
    enabled = tuple(m.id for m in s.runs.models)
    models = []
    for mid in enabled:
        m = REGISTRY[mid]
        models.append({"id": m.id, "name": m.name, "short": m.short, "desc": m.desc, "kind": m.kind,
                       "color": m.color, "cycleHours": m.cycle_hours, "attribution": m.attribution})
    products = [p.client(enabled) for p in PRODUCTS]
    return {
        "version": __version__,
        "models": models,
        "products": [p for p in products if p["models"]],
        "colormaps": COLORMAPS,
        "vars": {k: {"name": v.name, "units": v.units, "kind": v.kind, "method": v.method}
                 for k, v in VARS.items() if not v.internal},
        "regions": REGIONS,
        "meteogramModels": METEOGRAM_MODELS,
        "soundingModels": SOUNDING_MODELS,
        "satellite": [{"id": k, **v} for k, v in SAT_PRODUCTS.items()],
        "satAttribution": SAT_ATTRIBUTION,
        "metrics": {k: {"label": v["label"], "unit": v["unit"], "agg": v["agg"]} for k, v in METRICS.items()},
        "tz": settings.display_tz,
        "vapid": s.vapid.public_b64,
    }


@router.get("/runs")
def runs(request: Request, user: CurrentUser = Depends(require_user)):
    s = svc(request)
    return {"runs": s.runs.snapshot(), "now": time.time()}


@router.get("/frame/{model}/{run}/{var}/{fhr}")
async def frame(model: str, run: str, var: str, fhr: int, request: Request, lod: int = Query(0, ge=0, le=2),
                user: CurrentUser = Depends(require_user)):
    s = svc(request)
    if model not in REGISTRY or model not in s.models_enabled:
        raise HTTPException(404, "Unknown model")
    if var not in VARS or model not in var_models(var):
        raise HTTPException(404, "Variable not available for this model")
    if not re.fullmatch(r"\d{10}", run) or not (0 <= fhr <= 400) or lod not in (0, 1, 2):
        raise HTTPException(400, "Bad request")
    steps = s.runs.steps(model, run)
    if not steps:
        raise HTTPException(404, "Run not available")
    if fhr not in steps and not VARS[var].static:
        raise HTTPException(404, "Forecast hour not published yet")
    try:
        info = await s.frames.get(model, run, var, fhr, lod)
    except (NotAvailable, FetchError) as exc:
        raise _upstream_error(exc)
    return _frame_response(info.path, info.etag, request)


# --------------------------------------------------------------------------- observations

@router.get("/radar/times")
async def radar_times(request: Request, hours: float = Query(2.0, ge=0.5, le=4), user: CurrentUser = Depends(require_user)):
    try:
        return {"times": await svc(request).radar.times(hours=hours), "src": "NOAA/NSSL MRMS"}
    except FetchError as exc:
        raise _upstream_error(exc)


@router.get("/radar/frame/{stamp}")
async def radar_frame(stamp: str, request: Request, lod: int = Query(0, ge=0, le=2), user: CurrentUser = Depends(require_user)):
    if lod not in (0, 1, 2):
        raise HTTPException(400, "Bad lod")
    try:
        path = await svc(request).radar.frame(stamp, 0)
        path = svc(request).radar.path(stamp, lod)
    except ValueError:
        raise HTTPException(400, "Bad radar time")
    except FetchError as exc:
        raise _upstream_error(exc)
    st = path.stat()
    return _frame_response(path, f'"r{int(st.st_mtime)}-{st.st_size}"', request)


@router.get("/sat/{product}/times")
async def sat_times(product: str, request: Request, count: int = Query(12, ge=1, le=48),
                    user: CurrentUser = Depends(require_user)):
    try:
        return {"times": await svc(request).sat.times(product, count), "attribution": SAT_ATTRIBUTION}
    except ValueError:
        raise HTTPException(404, "Unknown product")
    except FetchError as exc:
        raise _upstream_error(exc)


@router.get("/sat/{product}/{stamp}.webp")
async def sat_image(product: str, stamp: str, request: Request, user: CurrentUser = Depends(require_user)):
    try:
        path = await svc(request).sat.image(product, stamp)
    except ValueError:
        raise HTTPException(400, "Bad request")
    except FetchError as exc:
        raise _upstream_error(exc)
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": IMMUTABLE})


@router.get("/lightning/status")
def lightning_status(request: Request, user: CurrentUser = Depends(require_user)):
    s = svc(request).lightning
    if not s.enabled:
        return JSONResponse({"enabled": False}, headers={"Cache-Control": "no-store"})
    return JSONResponse(s.status(), headers={"Cache-Control": "no-store"})


@router.get("/lightning/chunk/{t0}")
def lightning_chunk(t0: int, request: Request, after: float | None = Query(None),
                    user: CurrentUser = Depends(require_user)):
    s = svc(request).lightning
    if not s.enabled:
        raise HTTPException(404, "Lightning is turned off on this server")
    now = time.time()
    if t0 > now + 600 or t0 < now - 7 * 3600:
        raise HTTPException(404, "Outside the lightning history")
    try:
        blob, final = s.chunk(t0, after)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    headers = {"Content-Encoding": "gzip", "X-Final": "1" if final else "0",
               "Cache-Control": IMMUTABLE if final else "no-store"}
    return Response(blob, media_type="application/octet-stream", headers=headers)


@router.get("/fronts")
async def fronts(request: Request, user: CurrentUser = Depends(require_user)):
    try:
        data = await svc(request).fronts.sets()
    except FetchError as exc:
        raise _upstream_error(exc)
    return JSONResponse(data, headers={"Cache-Control": "private, max-age=300"})


@router.get("/alerts")
async def alerts(request: Request, user: CurrentUser = Depends(require_user)):
    try:
        items = await svc(request).nws.active()
    except FetchError as exc:
        raise _upstream_error(exc)
    return JSONResponse({"alerts": items, "updated": time.time()}, headers={"Cache-Control": "private, max-age=60"})


@router.get("/alerts/detail")
async def alert_detail(request: Request, id: str = Query(..., max_length=300), user: CurrentUser = Depends(require_user)):
    if not re.fullmatch(r"[A-Za-z0-9:._\-/]+", id):
        raise HTTPException(400, "Bad id")
    try:
        return await svc(request).nws.detail(id)
    except FetchError as exc:
        raise _upstream_error(exc)


@router.get("/alerts/point")
async def alerts_point(request: Request, lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                       user: CurrentUser = Depends(require_user)):
    try:
        return {"alerts": await svc(request).nws.at_point(lat, lon)}
    except FetchError as exc:
        raise _upstream_error(exc)


# --------------------------------------------------------------------------- point forecasts

def _model_ids(raw: str | None, allowed: list[dict]) -> list[str]:
    ids = [m["id"] for m in allowed]
    if not raw:
        return ids
    wanted = [m for m in raw.split(",") if m in ids]
    return wanted or ids


def _in_conus(lat: float, lon: float) -> bool:
    return 20 <= lat <= 54 and -135 <= lon <= -60


@router.get("/point/meteogram")
async def meteogram(request: Request, lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                    elev: float | None = Query(None, ge=-500, le=9000), models: str | None = None,
                    user: CurrentUser = Depends(require_user)):
    allowed = [m for m in METEOGRAM_MODELS if not m.get("region") or _in_conus(lat, lon)]
    try:
        return await svc(request).om.meteogram(lat, lon, _model_ids(models, allowed), elevation=elev)
    except FetchError as exc:
        raise _upstream_error(exc)


@router.get("/point/sounding")
async def sounding(request: Request, lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                   model: str = "ncep_gfs025", user: CurrentUser = Depends(require_user)):
    ids = {m["id"]: m for m in SOUNDING_MODELS}
    if model not in ids:
        raise HTTPException(400, "Unknown sounding model")
    days = max(2, min(7, int(round(ids[model]["days"]))))
    try:
        return await svc(request).om.sounding(lat, lon, model, days=days)
    except FetchError as exc:
        raise _upstream_error(exc)


@router.get("/point/terrain")
async def terrain(request: Request, lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                  user: CurrentUser = Depends(require_user)):
    """Model terrain heights at a point vs. the real (90 m DEM) elevation."""
    s = svc(request)
    out: dict = {"dem": await s.om.elevation(lat, lon), "models": {}}
    for mid in ("hrrr", "rrfs", "gfs"):
        if mid not in s.models_enabled:
            continue
        info = s.runs.latest(mid)
        if not info:
            continue
        try:
            data, grid = await s.frames.values(mid, info.run, "orog", info.steps[0])
            val = sample_grid(data[0], grid, lat, lon)
            if val is not None:
                out["models"][mid] = round(val, 1)
        except Exception as exc:
            log.debug("terrain %s failed: %s", mid, exc)
    return out


def sample_grid(arr, grid, lat: float, lon: float) -> float | None:
    import numpy as np

    from .data.grib import lambert_forward

    s = grid.spec
    if s["type"] == "latlon":
        i = (((lon - s["lo1"]) % 360.0) / s["dlon"]) if s["dlon"] > 0 else (lon - s["lo1"]) / s["dlon"]
        j = (lat - s["la1"]) / s["dlat"]
    else:
        i, j = lambert_forward(lat, lon, s)
        i, j = float(i), float(j)
    ii, jj = int(round(i)), int(round(j))
    if 0 <= jj < arr.shape[0]:
        ii = ii % arr.shape[1] if s["type"] == "latlon" and abs(abs(s["dlon"]) * s["ni"] - 360) < 1e-6 else ii
        if 0 <= ii < arr.shape[1]:
            v = float(arr[jj, ii])
            return v if np.isfinite(v) else None
    return None


@router.get("/geocode")
async def geocode(request: Request, q: str = Query(..., min_length=2, max_length=80), user: CurrentUser = Depends(require_user)):
    try:
        return {"results": await svc(request).om.search(q)}
    except FetchError as exc:
        raise _upstream_error(exc)


# --------------------------------------------------------------------------- saved points

class PointIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    elev: float | None = Field(default=None, ge=-500, le=9000)


class PointPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    elev: float | None = Field(default=None, ge=-500, le=9000)
    sort: int | None = Field(default=None, ge=-1_000_000, le=1_000_000)


def _point_out(r: dict) -> dict:
    return {"id": r["id"], "name": r["name"], "lat": r["lat"], "lon": r["lon"], "elev": r["elev_m"], "sort": r["sort"]}


@router.get("/points")
def list_points(user: CurrentUser = Depends(require_user)):
    rows = get_db().all("SELECT * FROM points WHERE user_id=? ORDER BY sort, id", (user.id,))
    return [_point_out(r) for r in rows]


@router.post("/points")
async def add_point(body: PointIn, request: Request, user: CurrentUser = Depends(require_user)):
    db = get_db()
    count = db.one("SELECT COUNT(*) n FROM points WHERE user_id=?", (user.id,))["n"]
    if count >= 100:
        raise HTTPException(400, "You can save up to 100 points.")
    elev = body.elev
    if elev is None:
        elev = await svc(request).om.elevation(body.lat, body.lon)
    pid = db.insert(
        "INSERT INTO points(user_id, name, lat, lon, elev_m, sort, created_at) VALUES(?,?,?,?,?,?,?)",
        (user.id, body.name.strip(), round(body.lat, 5), round(body.lon, 5), elev, count, int(time.time())),
    )
    return _point_out(db.one("SELECT * FROM points WHERE id=?", (pid,)))


@router.patch("/points/{pid}")
def update_point(pid: Id, body: PointPatch, user: CurrentUser = Depends(require_user)):
    db = get_db()
    row = db.one("SELECT * FROM points WHERE id=? AND user_id=?", (pid, user.id))
    if not row:
        raise HTTPException(404, "Not found")
    if body.name is not None:
        db.execute("UPDATE points SET name=? WHERE id=?", (body.name.strip(), pid))
    if "elev" in body.model_fields_set:
        db.execute("UPDATE points SET elev_m=? WHERE id=?", (body.elev, pid))
    if body.sort is not None:
        db.execute("UPDATE points SET sort=? WHERE id=?", (body.sort, pid))
    return _point_out(db.one("SELECT * FROM points WHERE id=?", (pid,)))


@router.delete("/points/{pid}")
def delete_point(pid: Id, user: CurrentUser = Depends(require_user)):
    get_db().execute("DELETE FROM points WHERE id=? AND user_id=?", (pid, user.id))
    return {"ok": True}


# --------------------------------------------------------------------------- notification rules

RULE_KINDS = ("nws", "threshold", "precip_soon", "run")


class RuleIn(BaseModel):
    kind: str
    pointId: int | None = Field(default=None, ge=1, le=2**62)
    params: dict = Field(default_factory=dict)
    enabled: bool = True


def _validate_rule(body: RuleIn, user: CurrentUser) -> dict:
    if body.kind not in RULE_KINDS:
        raise HTTPException(400, "Unknown rule type")
    raw = body.params or {}
    try:
        if len(json.dumps(raw, allow_nan=False)) > 2000:
            raise HTTPException(400, "Rule too large")
    except (ValueError, TypeError):
        raise HTTPException(400, "Bad rule parameters")
    if body.kind in ("nws", "threshold", "precip_soon"):
        if not body.pointId or not get_db().one("SELECT 1 x FROM points WHERE id=? AND user_id=?", (body.pointId, user.id)):
            raise HTTPException(400, "Pick one of your saved points")
    try:
        return clean_rule_params(body.kind, raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get("/rules")
def list_rules(user: CurrentUser = Depends(require_user)):
    rows = get_db().all("SELECT * FROM rules WHERE user_id=? ORDER BY id", (user.id,))
    return [{"id": r["id"], "kind": r["kind"], "pointId": r["point_id"], "params": json.loads(r["params"]),
             "enabled": bool(r["enabled"])} for r in rows]


@router.post("/rules")
def add_rule(body: RuleIn, user: CurrentUser = Depends(require_user)):
    p = _validate_rule(body, user)
    db = get_db()
    if db.one("SELECT COUNT(*) n FROM rules WHERE user_id=?", (user.id,))["n"] >= 50:
        raise HTTPException(400, "You can have up to 50 alerts.")
    rid = db.insert(
        "INSERT INTO rules(user_id, kind, point_id, params, enabled, created_at) VALUES(?,?,?,?,?,?)",
        (user.id, body.kind, body.pointId, json.dumps(p), int(body.enabled), int(time.time())),
    )
    return {"id": rid}


@router.put("/rules/{rid}")
def update_rule(rid: Id, body: RuleIn, user: CurrentUser = Depends(require_user)):
    p = _validate_rule(body, user)
    db = get_db()
    if not db.one("SELECT 1 x FROM rules WHERE id=? AND user_id=?", (rid, user.id)):
        raise HTTPException(404, "Not found")
    db.execute("UPDATE rules SET kind=?, point_id=?, params=?, enabled=?, state='{}' WHERE id=?",
               (body.kind, body.pointId, json.dumps(p), int(body.enabled), rid))
    return {"ok": True}


@router.delete("/rules/{rid}")
def delete_rule(rid: Id, user: CurrentUser = Depends(require_user)):
    get_db().execute("DELETE FROM rules WHERE id=? AND user_id=?", (rid, user.id))
    return {"ok": True}


@router.get("/notifications")
def notifications(user: CurrentUser = Depends(require_user), limit: int = Query(50, ge=1, le=200)):
    rows = get_db().all("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT ?", (user.id, limit))
    return [{"id": r["id"], "at": r["created_at"], "kind": r["kind"], "title": r["title"], "body": r["body"],
             "data": json.loads(r["data"]), "read": bool(r["read"])} for r in rows]


@router.post("/notifications/read")
def notifications_read(user: CurrentUser = Depends(require_user)):
    get_db().execute("UPDATE notifications SET read=1 WHERE user_id=?", (user.id,))
    return {"ok": True}


# --------------------------------------------------------------------------- push devices

class PushSub(BaseModel):
    endpoint: str = Field(max_length=1000)
    keys: dict
    label: str | None = Field(default=None, max_length=80)


@router.get("/push/key")
def push_key(request: Request, user: CurrentUser = Depends(require_user)):
    return {"key": svc(request).vapid.public_b64}


@router.post("/push/subscribe")
def push_subscribe(body: PushSub, user: CurrentUser = Depends(require_user)):
    if not push_endpoint_allowed(body.endpoint):
        raise HTTPException(400, "Unsupported push service")
    p256dh, auth = body.keys.get("p256dh"), body.keys.get("auth")
    if not isinstance(p256dh, str) or not isinstance(auth, str) or len(p256dh) > 200 or len(auth) > 64:
        raise HTTPException(400, "Bad subscription keys")
    db = get_db()
    db.execute(
        "INSERT INTO push_subs(user_id, endpoint, p256dh, auth, label, created_at) VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, "
        "label=excluded.label, fail_count=0",
        (user.id, body.endpoint, p256dh, auth, (body.label or "")[:80], int(time.time())),
    )
    if db.one("SELECT COUNT(*) n FROM push_subs WHERE user_id=?", (user.id,))["n"] > 20:
        db.execute("DELETE FROM push_subs WHERE user_id=? AND id NOT IN (SELECT id FROM push_subs WHERE user_id=? "
                   "ORDER BY created_at DESC LIMIT 20)", (user.id, user.id))
    return {"ok": True}


@router.post("/push/unsubscribe")
def push_unsubscribe(body: dict, user: CurrentUser = Depends(require_user)):
    get_db().execute("DELETE FROM push_subs WHERE user_id=? AND endpoint=?", (user.id, str(body.get("endpoint", ""))))
    return {"ok": True}


@router.get("/push/devices")
def push_devices(user: CurrentUser = Depends(require_user)):
    rows = get_db().all("SELECT id, label, created_at, last_ok_at, endpoint FROM push_subs WHERE user_id=?", (user.id,))
    return [{"id": r["id"], "label": r["label"] or "Device", "created": r["created_at"], "lastOk": r["last_ok_at"],
             "service": re.sub(r"^https://([^/]+)/.*$", r"\1", r["endpoint"])} for r in rows]


@router.delete("/push/devices/{sid}")
def push_device_delete(sid: Id, user: CurrentUser = Depends(require_user)):
    get_db().execute("DELETE FROM push_subs WHERE id=? AND user_id=?", (sid, user.id))
    return {"ok": True}


@router.post("/push/test")
async def push_test(request: Request, user: CurrentUser = Depends(require_user)):
    sent = await svc(request).notifier.push_user(
        user.id, {"kind": "test", "title": "Mammatus is connected", "body": "Notifications will arrive here.",
                  "data": {"url": "/"}, "tag": "test"}, topic="test",
    )
    return {"sent": sent}


# --------------------------------------------------------------------------- live events

@router.get("/events")
async def events(request: Request, user: CurrentUser = Depends(require_user)):
    hub = svc(request).events
    q = hub.subscribe(user.id)

    async def stream():
        try:
            yield "retry: 15000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=45)
                    yield msg
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            hub.unsubscribe(user.id, q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------- admin

class InviteIn(BaseModel):
    role: str = "user"
    note: str | None = Field(default=None, max_length=80)
    days: int = Field(default=7, ge=1, le=30)


class UserPatch(BaseModel):
    role: str | None = None
    disabled: bool | None = None
    displayName: str | None = Field(default=None, max_length=60)


def _link(request: Request, path: str) -> str:
    base = settings.public_url
    if not base:
        from .security import request_host, request_scheme

        peer = request.client.host if request.client else None
        scheme = request_scheme(peer, request.headers, settings.trusted_proxies, request.url.scheme)
        base = f"{scheme}://{request_host(peer, request.headers, settings.trusted_proxies)}"
    return f"{base}{path}"


@router.get("/admin/users")
def admin_users(admin: CurrentUser = Depends(require_admin)):
    db = get_db()
    rows = db.all("SELECT * FROM users ORDER BY id")
    out = []
    for r in rows:
        sess = db.one("SELECT COUNT(*) n, MAX(last_seen_at) seen FROM sessions WHERE user_id=?", (r["id"],))
        out.append({"id": r["id"], "username": r["username"], "displayName": r["display_name"], "role": r["role"],
                    "disabled": bool(r["disabled"]), "totp": bool(r["totp_enabled"]), "created": r["created_at"],
                    "lastLogin": r["last_login_at"], "sessions": sess["n"], "lastSeen": sess["seen"]})
    return out


@router.patch("/admin/users/{uid}")
def admin_user_update(uid: Id, body: UserPatch, request: Request, admin: CurrentUser = Depends(require_admin)):
    db = get_db()
    row = db.one("SELECT * FROM users WHERE id=?", (uid,))
    if not row:
        raise HTTPException(404, "Not found")
    if uid == admin.id and (body.role == "user" or body.disabled):
        raise HTTPException(400, "You can't demote or disable yourself.")
    if body.role is not None:
        if body.role not in ("admin", "user"):
            raise HTTPException(400, "Bad role")
        db.execute("UPDATE users SET role=? WHERE id=?", (body.role, uid))
    if body.disabled is not None:
        db.execute("UPDATE users SET disabled=? WHERE id=?", (int(body.disabled), uid))
        if body.disabled:
            db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    if body.displayName is not None:
        db.execute("UPDATE users SET display_name=? WHERE id=?", (body.displayName, uid))
    db.audit("admin_user_update", user_id=admin.id, ip=request.state.client_ip, detail=f"{uid}: {body.model_dump(exclude_none=True)}")
    return {"ok": True}


@router.delete("/admin/users/{uid}")
def admin_user_delete(uid: Id, request: Request, admin: CurrentUser = Depends(require_admin)):
    if uid == admin.id:
        raise HTTPException(400, "You can't delete yourself.")
    get_db().execute("DELETE FROM users WHERE id=?", (uid,))
    get_db().audit("admin_user_delete", user_id=admin.id, ip=request.state.client_ip, detail=str(uid))
    return {"ok": True}


@router.post("/admin/users/{uid}/reset")
def admin_user_reset(uid: Id, request: Request, admin: CurrentUser = Depends(require_admin)):
    db = get_db()
    if not db.one("SELECT 1 x FROM users WHERE id=?", (uid,)):
        raise HTTPException(404, "Not found")
    token = new_token(24)
    now = int(time.time())
    db.execute("INSERT INTO invites(id, kind, created_by, created_at, expires_at, target_user) VALUES(?,?,?,?,?,?)",
               (token_digest(token), "reset", admin.id, now, now + 2 * 86400, uid))
    db.audit("admin_reset_link", user_id=admin.id, ip=request.state.client_ip, detail=str(uid))
    return {"url": _link(request, f"/#reset={token}"), "expires": now + 2 * 86400}


@router.post("/admin/users/{uid}/signout")
def admin_user_signout(uid: Id, admin: CurrentUser = Depends(require_admin)):
    get_db().execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    return {"ok": True}


@router.get("/admin/invites")
def admin_invites(admin: CurrentUser = Depends(require_admin)):
    rows = get_db().all("SELECT * FROM invites WHERE kind='invite' ORDER BY created_at DESC LIMIT 50")
    return [{"id": r["id"][:12], "role": r["role"], "note": r["note"], "created": r["created_at"],
             "expires": r["expires_at"], "used": bool(r["used_at"])} for r in rows]


@router.post("/admin/invites")
def admin_invite_create(body: InviteIn, request: Request, admin: CurrentUser = Depends(require_admin)):
    if body.role not in ("user", "admin"):
        raise HTTPException(400, "Bad role")
    token = new_token(24)
    now = int(time.time())
    get_db().execute(
        "INSERT INTO invites(id, kind, created_by, created_at, expires_at, role, note) VALUES(?,?,?,?,?,?,?)",
        (token_digest(token), "invite", admin.id, now, now + body.days * 86400, body.role, body.note),
    )
    get_db().audit("invite_created", user_id=admin.id, ip=request.state.client_ip, detail=body.note or "")
    return {"url": _link(request, f"/#invite={token}"), "expires": now + body.days * 86400}


@router.delete("/admin/invites/{iid}")
def admin_invite_delete(iid: str, admin: CurrentUser = Depends(require_admin)):
    if not re.fullmatch(r"[0-9a-f]{12}", iid):
        raise HTTPException(400, "Bad id")
    get_db().execute("DELETE FROM invites WHERE kind='invite' AND substr(id,1,12)=?", (iid,))
    return {"ok": True}


@router.get("/admin/system")
def admin_system(request: Request, admin: CurrentUser = Depends(require_admin)):
    s = svc(request)
    usage = shutil.disk_usage(settings.data_dir) if settings.data_dir.exists() else None
    return {
        "version": __version__,
        "uptime": time.time() - s.started,
        "cache": {"bytes": s.frames.cache.total, "cap": s.frames.cache.cap},
        "disk": {"total": usage.total, "free": usage.free} if usage else None,
        "stats": s.frames.stats,
        "openMeteoCalls": s.om.calls,
        "openMeteoUrl": s.om.base,
        "runs": {m: {"latest": (s.runs.latest(m).run if s.runs.latest(m) else None),
                     "polled": s.runs.last_poll.get(m), "error": s.runs.errors.get(m)} for m in s.models_enabled},
        "listeners": s.events.listeners,
        "publicUrl": settings.public_url,
        "users": get_db().one("SELECT COUNT(*) n FROM users")["n"],
    }


@router.post("/admin/cache/clear")
def admin_cache_clear(request: Request, admin: CurrentUser = Depends(require_admin)):
    s = svc(request)
    root = s.frames.cache.root
    for sub in ("frames", "radar", "sat"):
        shutil.rmtree(root / sub, ignore_errors=True)
    s.frames.cache.scan()
    get_db().audit("cache_cleared", user_id=admin.id, ip=request.state.client_ip)
    return {"ok": True}


@router.get("/admin/audit")
def admin_audit(admin: CurrentUser = Depends(require_admin), limit: int = Query(200, ge=1, le=1000)):
    rows = get_db().all(
        "SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?", (limit,),
    )
    return [{"ts": r["ts"], "user": r["username"], "ip": r["ip"], "event": r["event"], "detail": r["detail"]} for r in rows]
