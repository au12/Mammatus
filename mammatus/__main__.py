"""Entry point: ``python -m mammatus``."""

from __future__ import annotations

import logging

import uvicorn

from .config import settings


def main() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    try:
        import uvloop  # noqa: F401

        loop = "uvloop"
    except ImportError:
        loop = "asyncio"
    uvicorn.run(
        "mammatus.app:app",
        host=settings.host,
        port=settings.port,
        proxy_headers=False,  # handled by GuardMiddleware with MAMMATUS_TRUSTED_PROXIES
        server_header=False,
        log_level=settings.log_level.lower(),
        access_log=settings.log_level == "DEBUG",
        loop=loop,
        timeout_keep_alive=30,
        timeout_graceful_shutdown=5,
    )


if __name__ == "__main__":
    main()
