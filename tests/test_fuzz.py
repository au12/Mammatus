"""Fuzz tests: parsers and codecs fed hostile input, and every HTTP route hit with junk.

Deterministic and quick by default. For a deep run:  MAMMATUS_FUZZ=20000 pytest -q tests/test_fuzz.py
"""
import gzip
import json
import math
import os
import random
import string
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

N = int(os.environ.get("MAMMATUS_FUZZ", "300"))
SEED = int(os.environ.get("MAMMATUS_FUZZ_SEED", "1234"))

from mammatus.data import frames, fronts, grib, lightning, nws, openmeteo  # noqa: E402
from mammatus import security  # noqa: E402

UNI = "٣²①Ⅻ０éß漢字🙂​‮\x00\x7f"


def rand_text(rng: random.Random, n: int = 40) -> str:
    alphabet = string.printable + UNI
    return "".join(rng.choice(alphabet) for _ in range(rng.randint(0, n)))


def junk(rng: random.Random, depth: int = 0):
    """A random JSON-ish value: the shapes upstream APIs and clients could send."""
    kinds = ["int", "float", "str", "none", "bool", "list", "dict", "special"]
    if depth > 3:
        kinds = kinds[:5]
    k = rng.choice(kinds)
    if k == "int":
        return rng.choice([0, -1, 1, 7, 2**31, -(2**63), 10**18, rng.randint(-1000, 1000)])
    if k == "float":
        return rng.choice([0.0, -0.0, 1e-300, 1e300, 3.5, -91.0, 181.0, rng.uniform(-1e4, 1e4)])
    if k == "str":
        return rng.choice(["", "x", "Warning", "Extreme", "../../etc/passwd", "1e3", "NaN", "null", rand_text(rng)])
    if k == "none":
        return None
    if k == "bool":
        return rng.random() < 0.5
    if k == "list":
        return [junk(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    if k == "dict":
        return {rng.choice(["a", "type", "coordinates", "properties", "geometry", "SAME", rand_text(rng, 6)]): junk(rng, depth + 1)
                for _ in range(rng.randint(0, 4))}
    return rng.choice([[0, 0], [[0, 0], [1, 1], [0, 1]], {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [0, 1]]]}, [[[]]]])


def mutate(rng: random.Random, blob: bytes) -> bytes:
    b = bytearray(blob)
    for _ in range(rng.randint(1, 8)):
        op = rng.random()
        if op < 0.4 and b:
            b[rng.randrange(len(b))] = rng.randrange(256)
        elif op < 0.6 and b:
            del b[rng.randrange(len(b)):][: rng.randint(1, 64)]
        elif op < 0.8:
            pos = rng.randrange(len(b) + 1)
            b[pos:pos] = bytes(rng.randrange(256) for _ in range(rng.randint(1, 16)))
        else:
            b = b[: rng.randrange(len(b) + 1)]
    return bytes(b)


# --------------------------------------------------------------------------- codecs

def test_frame_decode_rejects_garbage_cleanly():
    rng = random.Random(SEED)
    q = frames.quantize(np.random.default_rng(1).normal(280, 5, (13, 17)).astype(np.float32), 0.1, 150)
    good = frames.encode({"w": 17, "h": 13, "comps": 1, "scale": 0.1, "offset": 150}, [q])
    raw = gzip.decompress(good)
    for i in range(N):
        blob = mutate(rng, raw if i % 2 else good)
        try:
            header, comps = frames.decode(blob)
        except Exception as exc:  # noqa: BLE001 - any clean exception is fine, a crash or hang is not
            assert not isinstance(exc, (SystemError, MemoryError, RecursionError)), exc
            continue
        assert all(c.shape == (header["h"], header["w"]) for c in comps)


def test_lightning_chunk_roundtrip_and_garbage():
    rng = random.Random(SEED)
    nprng = np.random.default_rng(SEED)
    for i in range(N // 3 + 5):
        n = int(nprng.integers(0, 400))
        arr = np.zeros(n, lightning.DTYPE)
        t0 = 1_800_000_000 - int(nprng.integers(0, 100)) * 600
        arr["t"] = t0 + nprng.uniform(-50, 700, n)            # some outside the chunk on purpose
        arr["lat"] = nprng.uniform(-90, 90, n)
        arr["lon"] = nprng.uniform(-180, 180, n)
        arr["e"] = nprng.integers(0, 256, n)
        blob = lightning.encode_chunk(t0, arr, final=bool(i % 2), latest=None if i % 3 else t0 + 300.5, now=t0 + 900)
        header, back = lightning.decode_chunk(blob)
        assert header["n"] == n and len(back) == n
        assert np.all(np.diff(back["t"]) >= 0)
        assert np.all((back["t"] >= t0) & (back["t"] <= t0 + 655.36))
        assert np.all(np.abs(back["lat"]) <= 90.01) and np.all(np.abs(back["lon"]) <= 180.01)
        for _ in range(3):
            try:
                lightning.decode_chunk(mutate(rng, blob))
            except Exception as exc:  # noqa: BLE001
                assert not isinstance(exc, (SystemError, MemoryError, RecursionError)), exc


def test_lightning_names_intervals_and_split():
    rng = random.Random(SEED)
    assert lightning.parse_name("OR_GLM-L2-LCFA_G19_s20263301200000_e20263301200200_c20263301200220.nc")
    for _ in range(N):
        assert lightning.parse_name(rand_text(rng, 90)) is None or True
    for _ in range(N // 10 + 5):
        iv: list = []
        spans = []
        for _ in range(rng.randint(1, 30)):
            a = rng.uniform(0, 1000)
            b = a + rng.uniform(0, 40)
            lightning.add_interval(iv, a, b)
            spans.append((a, b))
        assert all(iv[k][0] <= iv[k][1] for k in range(len(iv)))
        assert all(iv[k][1] < iv[k + 1][0] for k in range(len(iv) - 1)), iv
        for a, b in spans:
            assert lightning.covers(iv, a, b)
    lon = np.linspace(-180, 180, 3601)
    east = lightning.nearest_satellite_mask(lon, "east", ["west"])
    west = lightning.nearest_satellite_mask(lon, "west", ["east"])
    assert np.all(east ^ west), "every longitude belongs to exactly one satellite"


# --------------------------------------------------------------------------- upstream text and JSON

def test_grib_index_parsers_survive_garbage():
    rng = random.Random(SEED)
    sample = "1:0:d=2026112612:TMP:2 m above ground:anl:\n2:1000:d=2026112612:APCP:surface:0-6 hour acc fcst:\n"
    ec = '{"param": "2t", "levtype": "sfc", "step": "6", "_offset": 0, "_length": 100}\n'
    for _ in range(N):
        for text in (rand_text(rng, 200), sample.replace(rng.choice("0:TA"), rng.choice(":x9 \n"), rng.randint(1, 3))):
            try:
                grib.parse_wgrib_idx(text)
            except ValueError:
                pass
        try:
            grib.parse_ecmwf_index(ec.replace(rng.choice('0"6s'), rng.choice(':x9 "{'), rng.randint(1, 3)) + rand_text(rng, 30))
        except ValueError:
            pass


BULLETIN = """CODSUS
VALID 112612Z
HIGHS 1032 4210512 1028 3800952
LOWS 1004 3920972 998 4580685
COLD WK 3920972 3780985 3590998 3401010
WARM 3920972 3880950 3830930
STNRY 4580685 4600660 4620640
OCFNT 4580685 4650700
TROF 3200990 3001000
DRYLINE 3501020 3301025
$$
VALID 112700Z 12HR
COLD 3920962 3780975
"""


def test_fronts_parser_survives_mutations():
    rng = random.Random(SEED)
    issued = datetime(2026, 11, 26, 13, 30, tzinfo=timezone.utc)
    base = fronts.parse_bulletin(BULLETIN, issued)
    assert base and base[0]["fronts"]
    for _ in range(N):
        lines = BULLETIN.split("\n")
        for _ in range(rng.randint(1, 5)):
            k = rng.randrange(len(lines))
            choice = rng.random()
            if choice < 0.3:
                lines[k] = rand_text(rng, 60)
            elif choice < 0.6:
                toks = lines[k].split()
                if toks:
                    toks[rng.randrange(len(toks))] = rng.choice(["٣٢١٠٩٨٧", "²²²²", "99999999", "0", "-12", "COLD", rand_text(rng, 8)])
                lines[k] = " ".join(toks)
            else:
                lines.insert(k, rng.choice(["VALID 999999Z", "VALID 113199Z 48HR", "HIGHS", "COLD", "$$", rand_text(rng, 30)]))
        out = fronts.parse_bulletin("\n".join(lines), issued)
        for s in out:
            for f in s["fronts"]:
                assert len(f["coords"]) >= 2
                for lon, lat in f["coords"]:
                    assert math.isfinite(lon) and math.isfinite(lat) and abs(lat) <= 90
            for lon, lat, p in s["highs"] + s["lows"]:
                assert abs(lat) <= 90 and 850 <= p <= 1090
    for tok in ["٣٢١٠٩٨٧", "²²²²", "１２３４", "1234567", "", "12", "abcdefg"]:
        fronts.decode_point(tok)


def test_nws_compact_survives_any_feature():
    rng = random.Random(SEED)
    for _ in range(N * 2):
        f = junk(rng)
        if rng.random() < 0.7:
            f = {"properties": junk(rng) if rng.random() < 0.3 else {k: junk(rng) for k in rng.sample(
                ["id", "event", "severity", "status", "geocode", "headline", "ends", "sent", "areaDesc"], rng.randint(0, 9))},
                 "geometry": junk(rng) if rng.random() < 0.5 else {"type": rng.choice(["Polygon", "MultiPolygon", "Point"]), "coordinates": junk(rng)}}
        out = nws.compact(f)
        assert out is None or isinstance(out, dict)
        if out:
            json.dumps(out, allow_nan=False)
            for poly in out["polys"] or []:
                for ring in poly:
                    assert len(ring) >= 3 and all(abs(lat) <= 90 for _, lat in ring)
    assert nws.compact_all({"features": [None, 3, {"properties": []}, {"properties": {"id": "a", "event": "Tornado Warning"}}]})[0]["id"] == "a"
    assert nws.compact_all("not json") == []


def test_openmeteo_normalize_survives_junk():
    rng = random.Random(SEED)
    for _ in range(N):
        data = junk(rng) if rng.random() < 0.3 else {"hourly": {f"{v}_{m}": junk(rng) for v in ("temperature_2m", "cape") for m in ("a", "b")},
                                                    "latitude": junk(rng)}
        out = openmeteo.normalize_multi(data, ["a", "b"], ["temperature_2m", "cape"])
        assert isinstance(out, dict) and "models" in out


def test_security_header_parsing_survives_junk():
    rng = random.Random(SEED)
    nets = security.parse_networks("10.0.0.0/8,127.0.0.1/32") if hasattr(security, "parse_networks") else []
    from starlette.datastructures import Headers

    rb = lambda n: bytes(rng.randrange(256) for _ in range(rng.randint(0, n)))  # noqa: E731
    pool = [b"1.2.3.4, 10.0.0.1", b"  , ,", b"[::1]:443", b"https", b"evil.example:99999", b"\xff\xfe"]
    for _ in range(N):
        h = Headers(raw=[(k, rng.choice(pool) if rng.random() < 0.3 else rb(40))
                         for k in (b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host", b"host", b"x-real-ip")])
        peer = rng.choice(["10.0.0.5", "203.0.113.9", None, "::1", "not-an-ip"])
        ip = security.client_ip(peer, h, nets)
        assert ip is None or isinstance(ip, str)
        security.request_scheme(peer, h, nets, "http")
        security.request_host(peer, h, nets)


# --------------------------------------------------------------------------- rules engine

def test_rules_engine_survives_bad_params():
    import asyncio

    from mammatus import alerts

    rng = random.Random(SEED)
    sent = []

    class Note:
        async def notify(self, *a, **k):
            sent.append(a)

        def local(self, ts):
            return "now"

    class Runs:
        def on_update(self, fn):
            pass

    eng = alerts.RulesEngine(Note(), None, None, Runs())
    now = __import__("time").time()
    fc = {"time": [now + 3600 * k for k in range(48)],
          "models": {"m1": {"snowfall": [1.0] * 48, "temperature_2m": [-5.0] * 48}, "m2": {"snowfall": [None, "x", 2] * 16}}}
    for _ in range(N):
        params = {k: junk(rng) for k in rng.sample(["metric", "hours", "value", "op", "agreement", "models", "cycles"], rng.randint(0, 7))}
        if rng.random() < 0.6:
            params["metric"] = rng.choice(list(alerts.METRICS))
        for kind in ("threshold", "run", "nws", "precip_soon"):
            try:
                clean = alerts.clean_rule_params(kind, params)
            except ValueError:
                continue
            json.dumps(clean, allow_nan=False)
            if kind != "threshold":
                continue
            r = {"id": 1, "user_id": 1, "point_id": 1, "pname": "Home", "params": clean, "state": {}}
            try:
                asyncio.run(eng._eval_threshold(r, fc))
            except Exception as exc:  # noqa: BLE001
                pytest.fail(f"threshold rule with params {params!r} raised {exc!r}")
    for bad in ([0], {"a": 1}, None, 3, "snowfall"):
        with pytest.raises(ValueError):
            alerts.clean_rule_params("threshold", {"metric": bad, "value": 1})
    with pytest.raises(ValueError):
        alerts.clean_rule_params("threshold", {"metric": "snow", "value": "nan"})
    with pytest.raises(ValueError):
        alerts.clean_rule_params("run", {"model": "gfs", "cycles": 6})


# --------------------------------------------------------------------------- HTTP routes

def _offline(monkeypatch):
    """Every upstream request fails fast, as if NOAA/ECMWF/Open-Meteo were unreachable."""
    from mammatus.data import http

    async def fail(*a, **k):
        raise http.FetchError("offline (fuzz)", 503)

    for mod_name in ("mammatus.data.http", "mammatus.data.nws", "mammatus.data.openmeteo", "mammatus.data.fronts",
                     "mammatus.data.radar", "mammatus.data.satellite", "mammatus.data.models", "mammatus.data.frames",
                     "mammatus.data.lightning", "mammatus.alerts"):
        mod = sys.modules.get(mod_name) or __import__(mod_name, fromlist=["x"])
        for name in ("request", "get_text", "get_bytes", "get_json", "fetch_ranges", "list_s3", "list_gcs"):
            if hasattr(mod, name):
                monkeypatch.setattr(mod, name, fail)


VALUES = ["", "0", "1", "-1", "7", "999999999999999999999", "1e309", "NaN", "inf", "-0", "0x10", "3.5",
          "..", "../../etc/passwd", "%2e%2e%2fetc", "%00", "a" * 300, "✓", "20261126-120000", "20261126.120000",
          "2026112612", "gfs", "hrrr", "t2m", "mslp", "globalir", "true", "null", "[]", "{}", "<script>"]


def _fill(rng, path: str) -> str:
    import re
    from urllib.parse import quote

    return re.sub(r"\{[^}]+\}", lambda m: quote(rng.choice(VALUES), safe="") or "x", path)


def test_http_routes_never_500(monkeypatch):
    from fastapi.routing import APIRoute
    from fastapi.testclient import TestClient

    from mammatus.app import create_app
    from mammatus.db import get_db

    _offline(monkeypatch)
    from mammatus import app as app_mod, auth as auth_mod
    from mammatus.security import RateLimiter

    for mod, name in [(app_mod, "api_limiter"), (app_mod, "anon_limiter"), (auth_mod, "login_ip_limiter"),
                      (auth_mod, "login_user_limiter"), (auth_mod, "signup_limiter"), (auth_mod, "totp_limiter")]:
        monkeypatch.setattr(mod, name, RateLimiter(10**9, 60))  # fuzz the handlers, not the limiters
    rng = random.Random(SEED)
    app = create_app()
    H = {"X-Mammatus": "1"}
    with TestClient(app, raise_server_exceptions=True) as admin, TestClient(app) as user, TestClient(app) as anon:
        db = get_db()
        if db.one("SELECT COUNT(*) n FROM users")["n"] == 0:
            code = db.get_meta("setup_token")
            assert admin.post("/api/auth/setup", json={"code": code, "username": "fuzzadmin", "password": "fuzz admin passphrase 1"}, headers=H).status_code == 200
        else:
            admin.post("/api/auth/login", json={"username": "fuzzadmin", "password": "fuzz admin passphrase 1"}, headers=H)
        if admin.get("/api/auth/me").status_code != 200:
            pytest.skip("could not sign in the fuzz admin (shared test database)")
        inv = admin.post("/api/admin/invites", json={"days": 1}, headers=H).json()["url"].split("#invite=")[1]
        user.post("/api/auth/register", json={"token": inv, "username": f"fuzz{rng.randrange(10**6)}", "password": "fuzz user passphrase 2"}, headers=H)
        admin.post("/api/points", json={"name": "Home", "lat": 35.6, "lon": -82.5}, headers=H)
        from mammatus.api import router as api_router
        from mammatus.auth import router as auth_router

        routes = [(m, r.path) for r in [*api_router.routes, *auth_router.routes] if isinstance(r, APIRoute)
                  for m in r.methods if m in ("GET", "POST", "PUT", "PATCH", "DELETE")]
        assert len(routes) > 50
        routes = [(m, p) for m, p in routes if p != "/api/events"]  # an endless stream; covered elsewhere
        fields = ["name", "lat", "lon", "elev", "sort", "kind", "pointId", "params", "enabled", "endpoint", "keys", "label",
                  "username", "password", "code", "ticket", "token", "displayName", "prefs", "current", "new", "role",
                  "disabled", "note", "days", "metric", "value", "hours", "model", "cycles", "minSeverity", "types"]
        queries = ["lat", "lon", "elev", "models", "model", "lod", "hours", "count", "after", "q", "id", "limit"]
        statuses = {}
        for i in range(N * 3):
            method, path = rng.choice(routes)
            url = _fill(rng, path)
            qs = {k: rng.choice(VALUES) for k in rng.sample(queries, rng.randint(0, 4))}
            body = None
            if method in ("POST", "PUT", "PATCH"):
                body = junk(rng) if rng.random() < 0.15 else {k: junk(rng) for k in rng.sample(fields, rng.randint(0, 6))}
                if rng.random() < 0.3 and isinstance(body, dict):
                    body["params"] = {k: junk(rng) for k in rng.sample(fields, rng.randint(0, 5))}
                    body["kind"] = rng.choice(["nws", "threshold", "precip_soon", "run", "x"])
            client = rng.choice([admin, user, anon])
            if path in ("/api/auth/logout",) or (path.startswith("/api/admin/users/") and method in ("DELETE", "PATCH")):
                client = anon  # keep the signed-in fuzz clients alive
            r = client.request(method, url, params=qs, json=body, headers=H)
            statuses[r.status_code] = statuses.get(r.status_code, 0) + 1
            assert r.status_code < 500 or r.status_code in (502, 503, 504), f"{method} {url} {qs} {body!r} -> {r.status_code} {r.text[:300]}"
            if "json" in r.headers.get("content-type", ""):
                r.json()
        # nothing stored by the fuzzing may break reading it back
        for c in (admin, user):
            for p in ("/api/auth/state", "/api/auth/me", "/api/points", "/api/rules", "/api/notifications", "/api/push/devices"):
                r = c.get(p)
                assert r.status_code in (200, 401), f"{p} -> {r.status_code} {r.text[:200]}"
