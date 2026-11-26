"""Runtime configuration, read once from environment variables.

Every setting has a safe default so the container starts with no configuration.
Admin-editable settings that can change at runtime live in the database
(see ``db.get_setting``) and override the values here where noted.
"""

from __future__ import annotations

import ipaddress
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("mammatus.config")

PRIVATE_NETS = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7"

ALL_MODELS = ("hrrr", "rrfs", "gfs", "ecmwf", "aifs")


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip()


def _bool(name: str, default: bool) -> bool:
    value = _env(name)
    if value is None:
        return default
    return value.lower() in ("1", "true", "yes", "on")


def _float(name: str, default: float) -> float:
    value = _env(name)
    try:
        return float(value) if value is not None else default
    except ValueError:
        log.warning("Ignoring invalid %s=%r", name, value)
        return default


def _int(name: str, default: int) -> int:
    return int(_float(name, default))


def _networks(spec: str) -> list[ipaddress._BaseNetwork]:
    nets = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            log.warning("Ignoring invalid network in MAMMATUS_TRUSTED_PROXIES: %r", part)
    return nets


@dataclass
class Settings:
    data_dir: Path
    host: str = "0.0.0.0"
    port: int = 8080
    public_url: str | None = None
    trusted_proxies: list = field(default_factory=list)
    cookie_secure: str = "auto"  # auto | true | false
    session_days: int = 30
    cache_gb: float = 10.0
    retention_hours: int = 54
    models: tuple[str, ...] = ALL_MODELS
    openmeteo_url: str = "https://api.open-meteo.com"
    openmeteo_ensemble_url: str = "https://ensemble-api.open-meteo.com"
    openmeteo_key: str | None = None
    geocode_url: str = "https://geocoding-api.open-meteo.com"
    nws_contact: str = "self-hosted"
    vapid_subject: str | None = None
    admin_user: str | None = None
    admin_password: str | None = None
    display_tz: str = "America/New_York"
    log_level: str = "INFO"
    static_dir: Path | None = None
    workers: int = 3
    hsts: bool = False

    @property
    def db_path(self) -> Path:
        return self.data_dir / "mammatus.sqlite3"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def keys_dir(self) -> Path:
        return self.data_dir / "keys"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    @property
    def user_agent(self) -> str:
        from . import __version__

        return f"Mammatus/{__version__} (+https://github.com/au12/Mammatus; {self.nws_contact})"


def load_settings() -> Settings:
    data_dir = Path(_env("MAMMATUS_DATA_DIR", "/data") or "/data")
    models_raw = _env("MAMMATUS_MODELS")
    models = ALL_MODELS
    if models_raw:
        wanted = tuple(m.strip().lower() for m in models_raw.split(",") if m.strip())
        models = tuple(m for m in ALL_MODELS if m in wanted) or ALL_MODELS

    here = Path(__file__).resolve().parent
    static = _env("MAMMATUS_STATIC_DIR")
    if static:
        static_dir = Path(static)
    elif (here / "static-dist").is_dir():
        static_dir = here / "static-dist"
    else:
        static_dir = here / "static"

    public_url = _env("MAMMATUS_PUBLIC_URL")
    if public_url:
        public_url = public_url.rstrip("/")

    return Settings(
        data_dir=data_dir,
        host=_env("MAMMATUS_HOST", "0.0.0.0") or "0.0.0.0",
        port=_int("MAMMATUS_PORT", 8080),
        public_url=public_url,
        trusted_proxies=_networks(_env("MAMMATUS_TRUSTED_PROXIES", PRIVATE_NETS) or PRIVATE_NETS),
        cookie_secure=(_env("MAMMATUS_SECURE_COOKIES", "auto") or "auto").lower(),
        session_days=max(1, _int("MAMMATUS_SESSION_DAYS", 30)),
        cache_gb=max(0.5, _float("MAMMATUS_CACHE_GB", 10.0)),
        retention_hours=max(12, _int("MAMMATUS_RETENTION_HOURS", 54)),
        models=models,
        openmeteo_url=(_env("MAMMATUS_OPENMETEO_URL", "https://api.open-meteo.com") or "").rstrip("/"),
        openmeteo_ensemble_url=(
            _env("MAMMATUS_OPENMETEO_ENSEMBLE_URL", "https://ensemble-api.open-meteo.com") or ""
        ).rstrip("/"),
        openmeteo_key=_env("MAMMATUS_OPENMETEO_KEY"),
        geocode_url=(_env("MAMMATUS_GEOCODE_URL", "https://geocoding-api.open-meteo.com") or "").rstrip("/"),
        nws_contact=_env("MAMMATUS_CONTACT", "self-hosted") or "self-hosted",
        vapid_subject=_env("MAMMATUS_VAPID_SUBJECT"),
        admin_user=_env("MAMMATUS_ADMIN_USER"),
        admin_password=_env("MAMMATUS_ADMIN_PASSWORD"),
        display_tz=_env("TZ", "America/New_York") or "America/New_York",
        log_level=(_env("MAMMATUS_LOG_LEVEL", "INFO") or "INFO").upper(),
        static_dir=static_dir,
        workers=max(1, min(8, _int("MAMMATUS_DECODE_WORKERS", 3))),
        hsts=_bool("MAMMATUS_HSTS", False),
    )


settings = load_settings()
