"""Shared async HTTP client with retries, per-host concurrency limits,
merged byte-range requests and cloud bucket listings (S3 and GCS)."""

from __future__ import annotations

import asyncio
import logging
import random
import re
import xml.etree.ElementTree as ET
from urllib.parse import quote, urlparse

import httpx

log = logging.getLogger("mammatus.http")

_client: httpx.AsyncClient | None = None
_host_sems: dict[str, asyncio.Semaphore] = {}

HOST_LIMITS = {
    "data.ecmwf.int": 2,
    "ecmwf-forecasts.s3.eu-central-1.amazonaws.com": 4,
    "storage.googleapis.com": 6,
    "api.open-meteo.com": 4,
    "api.weather.gov": 4,
    "realearth.ssec.wisc.edu": 4,
    "s3.amazonaws.com": 12,           # terrain tiles: many small files
}
DEFAULT_HOST_LIMIT = 8


class FetchError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        from ..config import settings

        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(45.0, connect=10.0),
            limits=httpx.Limits(max_connections=48, max_keepalive_connections=16, keepalive_expiry=30),
            headers={"User-Agent": settings.user_agent, "Accept-Encoding": "gzip"},
            follow_redirects=True,
            http2=False,
        )
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _sem(url: str) -> asyncio.Semaphore:
    host = urlparse(url).netloc
    sem = _host_sems.get(host)
    if sem is None:
        sem = asyncio.Semaphore(HOST_LIMITS.get(host, DEFAULT_HOST_LIMIT))
        _host_sems[host] = sem
    return sem


async def request(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    params: dict | None = None,
    retries: int = 3,
    ok404: bool = False,
    timeout: float | None = None,
) -> httpx.Response | None:
    """Request with retry/backoff on transient errors. Returns None on 404 when ok404."""
    client = get_client()
    delay = 0.6
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with _sem(url):
                resp = await client.request(
                    method, url, headers=headers, params=params,
                    timeout=timeout if timeout else httpx.USE_CLIENT_DEFAULT,
                )
            if resp.status_code in (404, 403) and ok404:
                return None
            if resp.status_code == 429 or resp.status_code >= 500 or resp.status_code == 503:
                retry_after = resp.headers.get("retry-after")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
                if attempt < retries:
                    await asyncio.sleep(min(wait, 20) + random.random() * 0.4)
                    delay *= 2
                    continue
                raise FetchError(f"{resp.status_code} from {urlparse(url).netloc}", resp.status_code)
            if resp.status_code >= 400:
                raise FetchError(f"{resp.status_code} from {urlparse(url).netloc}", resp.status_code)
            return resp
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            last_exc = exc
            if attempt < retries:
                await asyncio.sleep(delay + random.random() * 0.4)
                delay *= 2
                continue
            raise FetchError(f"network error contacting {urlparse(url).netloc}: {exc}") from exc
    raise FetchError(f"failed: {url}: {last_exc}")


async def get_text(url: str, ok404: bool = False, **kw) -> str | None:
    resp = await request("GET", url, ok404=ok404, **kw)
    return None if resp is None else resp.text


async def get_bytes(url: str, ok404: bool = False, **kw) -> bytes | None:
    resp = await request("GET", url, ok404=ok404, **kw)
    return None if resp is None else resp.content


async def get_json(url: str, ok404: bool = False, **kw):
    resp = await request("GET", url, ok404=ok404, **kw)
    return None if resp is None else resp.json()


async def fetch_ranges(url: str, ranges: list[tuple[int, int | None]], gap: int = 128 * 1024) -> list[bytes]:
    """Fetch several byte ranges of one file, merging nearby ranges into fewer requests.

    ``ranges`` are inclusive (start, end) pairs; end=None means "to end of file".
    Returns the bytes for each input range in the original order.
    """
    order = sorted(range(len(ranges)), key=lambda i: ranges[i][0])
    groups: list[list[int]] = []
    for i in order:
        start, end = ranges[i]
        if groups:
            g = groups[-1]
            gs, ge = _group_span(ranges, g)
            if ge is not None and start - ge <= gap:
                g.append(i)
                continue
        groups.append([i])

    results: list[bytes | None] = [None] * len(ranges)

    async def run_group(g: list[int]) -> None:
        gs, ge = _group_span(ranges, g)
        hdr = {"Range": f"bytes={gs}-{'' if ge is None else ge}"}
        resp = await request("GET", url, headers=hdr)
        assert resp is not None
        data = resp.content
        if resp.status_code == 200 and gs > 0:
            # Server ignored the Range header; slice the full body.
            data = data[gs:] if ge is None else data[gs:ge + 1]
        for i in g:
            s, e = ranges[i]
            off = s - gs
            results[i] = data[off:] if e is None else data[off:off + (e - s + 1)]

    await asyncio.gather(*(run_group(g) for g in groups))
    return [r if r is not None else b"" for r in results]


def _group_span(ranges, group):
    start = min(ranges[i][0] for i in group)
    ends = [ranges[i][1] for i in group]
    end = None if any(e is None for e in ends) else max(ends)
    return start, end


# -- bucket listing -------------------------------------------------------------

_S3_NS = re.compile(r"\{[^}]+\}")


async def list_s3(bucket_url: str, prefix: str, max_pages: int = 6) -> list[tuple[str, int]]:
    """List keys under ``prefix`` in a public S3 bucket. Returns (key, size)."""
    out: list[tuple[str, int]] = []
    token = None
    for _ in range(max_pages):
        params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        resp = await request("GET", bucket_url.rstrip("/") + "/", params=params)
        assert resp is not None
        root = ET.fromstring(resp.content)
        token = None
        truncated = False
        for el in root:
            tag = _S3_NS.sub("", el.tag)
            if tag == "Contents":
                key = size = None
                for c in el:
                    ctag = _S3_NS.sub("", c.tag)
                    if ctag == "Key":
                        key = c.text
                    elif ctag == "Size":
                        size = int(c.text or 0)
                if key:
                    out.append((key, size or 0))
            elif tag == "IsTruncated":
                truncated = (el.text or "").lower() == "true"
            elif tag == "NextContinuationToken":
                token = el.text
        if not truncated or not token:
            break
    return out


async def list_gcs(bucket: str, prefix: str, max_pages: int = 6) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    token = None
    for _ in range(max_pages):
        params = {"prefix": prefix, "maxResults": "1000", "fields": "items(name,size),nextPageToken"}
        if token:
            params["pageToken"] = token
        url = f"https://storage.googleapis.com/storage/v1/b/{quote(bucket)}/o"
        data = await get_json(url, params=params)
        for item in (data or {}).get("items", []):
            out.append((item["name"], int(item.get("size", 0))))
        token = (data or {}).get("nextPageToken")
        if not token:
            break
    return out
