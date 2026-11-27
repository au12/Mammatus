"""FastAPI application: middleware, static files, service lifecycle."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .alerts import Notifier, RulesEngine
from .api import router as api_router
from .auth import bootstrap, load_session, router as auth_router
from .config import settings

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("image/svg+xml", ".svg")
from .data.frames import FrameService
from .data.http import close_client
from .data.models import REGISTRY
from .data.nws import NWSService
from .data.openmeteo import OpenMeteo
from .data.radar import RadarService
from .data.runs import RunsService
from .data.satellite import SatelliteService
from .data.lightning import LightningService
from .data.fronts import FrontsService
from .data.sky import SkyService
from .data.terrain import TerrainService, TileSource
from .db import get_db
from .events import EventHub
from .security import RateLimiter, client_ip, request_host, request_scheme
from .webpush import load_or_create_vapid

log = logging.getLogger("mammatus")

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("application/octet-stream", ".bin")

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "connect-src 'self'; worker-src 'self' blob:; font-src 'self'; manifest-src 'self'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)
SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"same-origin"),
    (b"x-frame-options", b"DENY"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"permissions-policy", b"geolocation=(self), camera=(), microphone=(), payment=(), usb=()"),
    (b"content-security-policy", CSP.encode()),
]
api_limiter = RateLimiter(900, 60)
anon_limiter = RateLimiter(120, 60)
MAX_BODY = 256 * 1024


def _json(send_status: int, detail: str, extra: dict | None = None) -> Response:
    return JSONResponse({"detail": detail}, status_code=send_status, headers=extra or {})


class GuardMiddleware:
    """Client IP, session loading, CSRF/origin checks, rate limits and security headers."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)
        peer = scope["client"][0] if scope.get("client") else None
        state = scope.setdefault("state", {})
        state["client_ip"] = client_ip(peer, headers, settings.trusted_proxies)
        path: str = scope["path"]
        method: str = scope["method"]

        https = request_scheme(peer, headers, settings.trusted_proxies, scope.get("scheme", "http")) == "https"

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                for k, v in SECURITY_HEADERS:
                    if k.decode() not in h:
                        h.append(k.decode(), v.decode())
                if settings.hsts and https:
                    h["strict-transport-security"] = "max-age=31536000; includeSubDomains"
            await send(message)

        if path.startswith("/api/"):
            request = Request(scope)
            user = load_session(request)
            state["user"] = user
            if method not in ("GET", "HEAD", "OPTIONS"):
                if headers.get("x-mammatus") != "1":
                    return await _json(403, "Missing request header")(scope, receive, send_wrapper)
                origin = headers.get("origin")
                if origin and origin != "null" and not self._origin_ok(origin, peer, headers):
                    return await _json(403, "Cross-origin request blocked")(scope, receive, send_wrapper)
                try:
                    if int(headers.get("content-length") or 0) > MAX_BODY:
                        return await _json(413, "Request too large")(scope, receive, send_wrapper)
                except ValueError:
                    return await _json(400, "Bad length")(scope, receive, send_wrapper)
            limiter, key = (api_limiter, f"u{user.id}") if user else (anon_limiter, f"ip{state['client_ip']}")
            if not limiter.hit(key):
                return await _json(429, "Slow down", {"Retry-After": str(limiter.retry_after(key))})(
                    scope, receive, send_wrapper)
        await self.app(scope, receive, send_wrapper)

    @staticmethod
    def _origin_ok(origin: str, peer, headers) -> bool:
        origin = origin.rstrip("/").lower()
        allowed = set()
        if settings.public_url:
            from urllib.parse import urlparse

            u = urlparse(settings.public_url)
            allowed.add(f"{u.scheme}://{u.netloc}".lower())
        host = request_host(peer, headers, settings.trusted_proxies)
        if host:
            for scheme in ("https", "http"):
                allowed.add(f"{scheme}://{host}")
        return origin in allowed


# --------------------------------------------------------------------------- static files

def _static_root() -> Path:
    return settings.static_dir or Path(__file__).parent / "static"


def static_response(rel: str, request: Request, cache: str) -> Response:
    root = _static_root().resolve()
    target = (root / rel).resolve()
    if root not in target.parents and target != root:
        raise HTTPException(404)
    if not target.is_file():
        raise HTTPException(404)
    media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    headers = {"Cache-Control": cache, "Vary": "Accept-Encoding"}
    gz = target.with_name(target.name + ".gz")
    if gz.is_file() and "gzip" in (request.headers.get("accept-encoding") or ""):
        headers["Content-Encoding"] = "gzip"
        return FileResponse(gz, media_type=media, headers=headers)
    return FileResponse(target, media_type=media, headers=headers)


def _cache_policy(rel: str) -> str:
    if rel.startswith("assets/") and "-" in Path(rel).stem and (_static_root() / "BUILD").exists():
        return "public, max-age=31536000, immutable"
    if rel.startswith(("data/", "img/", "icons/")):
        return "public, max-age=604800"
    return "no-cache"


# --------------------------------------------------------------------------- lifecycle

async def _cleanup_loop(svc) -> None:
    while True:
        await asyncio.sleep(1800)
        try:
            protected = set()
            for mid in svc.models_enabled:
                for r in svc.runs.runs(mid)[: REGISTRY[mid].keep_runs]:
                    protected.add(svc.frames.frames_root / mid / r.run)
            loop = asyncio.get_running_loop()
            removed = await loop.run_in_executor(None, svc.frames.cache.cleanup, protected, settings.retention_hours)
            removed += await loop.run_in_executor(None, svc.sky.cleanup)
            removed += await loop.run_in_executor(None, svc.terrain.cleanup)
            if removed:
                log.info("cache cleanup freed %.1f MB", removed / 1e6)
        except Exception:
            log.exception("cache cleanup failed")


def terrain_source(cfg) -> TileSource | None:
    """The elevation tile server for the Sky view's terrain, or None when it is turned off."""
    if not cfg.terrain_url:
        return None
    default = TileSource()
    credit = cfg.terrain_attribution or (default.attribution if cfg.terrain_url == default.url else "Custom elevation tiles")
    return TileSource(cfg.terrain_url, cfg.terrain_tile_px, cfg.terrain_max_zoom, credit)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.cache_dir.mkdir(parents=True, exist_ok=True)
    db = get_db()
    bootstrap()
    vapid = load_or_create_vapid(settings.keys_dir)
    events = EventHub()
    runs = RunsService(db, settings.models)
    frames = FrameService(settings.cache_dir, int(settings.cache_gb * 1024**3), settings.workers)
    frames.runs = runs
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, frames.cache.scan)
    om_url = db.get_meta("openmeteo_url") or settings.openmeteo_url
    om = OpenMeteo(om_url, settings.geocode_url, settings.openmeteo_key)
    nws = NWSService()
    subject = settings.vapid_subject or (settings.public_url if (settings.public_url or "").startswith("https") else
                                          "mailto:mammatus@users.noreply.github.com")
    notifier = Notifier(vapid, subject, events, settings.display_tz)
    engine = RulesEngine(notifier, nws, om, runs)

    async def on_runs(model, info, new_steps):
        events.publish("runs", {"model": model, "run": info.client()})

    runs.on_update(on_runs)
    svc = SimpleNamespace(
        runs=runs, frames=frames, radar=RadarService(frames.cache, frames.pool),
        sat=SatelliteService(frames.cache, frames.pool), nws=nws, om=om, vapid=vapid, events=events,
        notifier=notifier, engine=engine, started=time.time(), models_enabled=set(m.id for m in runs.models),
        lightning=LightningService(settings.cache_dir, frames.pool, settings.lightning, settings.lightning_backfill_min),
        fronts=FrontsService(), sky=SkyService(frames, runs, om, settings.cache_dir, int(settings.sky_cache_gb * 1024**3)),
        terrain=TerrainService(
            settings.cache_dir, frames.pool,
            terrain_source(settings),
            int(settings.terrain_cache_gb * 1024**3)),
    )
    app.state.svc = svc
    background = os.environ.get("MAMMATUS_BACKGROUND", "1") != "0"  # tests turn polling off
    if background:
        runs.start()
        svc.radar.start()
        svc.lightning.start()
        engine.start()
    cleanup = asyncio.create_task(_cleanup_loop(svc), name="cache-cleanup")
    log.info("Mammatus %s ready on port %s (models: %s)", __version__, settings.port, ", ".join(svc.models_enabled))
    try:
        yield
    finally:
        cleanup.cancel()
        await svc.lightning.stop()
        await engine.stop()
        await runs.stop()
        await close_client()
        svc.sky.close()
        frames.close()


def create_app() -> FastAPI:
    app = FastAPI(title="Mammatus", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.add_middleware(GuardMiddleware)
    app.include_router(auth_router)
    app.include_router(api_router)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(x) for x in first.get("loc", [])[1:]) or "request"
        return JSONResponse({"detail": f"Invalid {field}: {first.get('msg', 'bad value')}"}, status_code=422)

    @app.exception_handler(OverflowError)
    async def overflow_error(request: Request, exc: OverflowError):
        # a number too large for SQLite or a float conversion is the client's mistake, not a crash
        return JSONResponse({"detail": "Number out of range"}, status_code=400)

    @app.get("/healthz", include_in_schema=False)
    def healthz():
        return {"ok": True, "version": __version__}

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def index(request: Request):
        return static_response("index.html", request, "no-cache")

    @app.api_route("/sw.js", methods=["GET", "HEAD"], include_in_schema=False)
    def service_worker(request: Request):
        resp = static_response("sw.js", request, "no-cache")
        resp.headers["Service-Worker-Allowed"] = "/"
        return resp

    @app.api_route("/{rel:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def static(rel: str, request: Request):
        if rel.startswith("api/") or rel.endswith(".gz") or rel.startswith(".") or "/." in rel:
            raise HTTPException(404)
        return static_response(rel, request, _cache_policy(rel))

    return app


app = create_app()
