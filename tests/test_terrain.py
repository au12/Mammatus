"""Sky view terrain: tile maths, resampling accuracy, the nested grids, packing, the cache and the API.

No network: the tile server is a function of latitude and longitude served as real Terrarium PNGs."""
import asyncio
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest

from mammatus.data import terrain as T
from mammatus.data.derive import NotAvailable
from mammatus.data.http import FetchError

SRC = T.TileSource("https://tiles.test/{z}/{x}/{y}.png")
LAT, LON = 35.6, -82.55


def ground(lat, lon):
    """Smooth hills between 300 and 1,900 m, with a bay of 'sea floor' to the south-east."""
    h = 1100.0 + 500.0 * np.sin(np.radians(lon) * 40.0) * np.cos(np.radians(lat) * 55.0) + 300.0 * np.sin(np.radians(lat + lon) * 9.0)
    return np.where((lat < 34.2) & (lon > -81.0), -250.0, h)


# a fault of the real tile pyramid: a needle on level ground in the coarse zooms only (here 30 km north) ...
NEEDLE = (LAT + 0.27, LON + 0.02)
# ... and a real pinnacle 25 km east, which every zoom agrees on
PINNACLE = (LAT + 0.01, LON + 0.2766)


def tile_png(z, x, y, tile_px=256, faults=False):
    n = tile_px * (1 << z)
    px = (np.arange(tile_px) + 0.5 + x * tile_px) / n
    py = (np.arange(tile_px) + 0.5 + y * tile_px) / n
    lon = px * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * py))))
    la, lo = lat[:, None], lon[None, :]
    g = ground(la, lo)
    if faults:
        km = lambda p: np.hypot((la - p[0]) * 111.2, (lo - p[1]) * 111.2 * math.cos(math.radians(LAT)))  # noqa: E731
        g = g + 700.0 * np.exp(-(km(PINNACLE) / 0.16) ** 2)
        if z <= 10:
            g = g + 900.0 * (km(NEEDLE) < 0.14)
    return T.encode_tile(g)


class FakeTiles:
    def __init__(self, fail=None, faults=False):
        self.calls = []
        self.fail = fail
        self.faults = faults

    async def __call__(self, url, **kw):
        z, x, y = (int(v) for v in url.rsplit(".", 1)[0].split("/")[-3:])
        self.calls.append((z, x, y))
        if self.fail and self.fail(z, x, y):
            raise FetchError("503 from tiles.test", 503)
        return tile_png(z, x, y, faults=self.faults)


@pytest.fixture
def tiles(monkeypatch):
    fake = FakeTiles()
    monkeypatch.setattr(T, "get_bytes", fake)
    return fake


@pytest.fixture
def service(tmp_path):
    pool = ThreadPoolExecutor(2)
    yield T.TerrainService(tmp_path, pool, SRC)
    pool.shutdown(wait=False)


def texel_latlon(half, size):
    lats, lons = T.level_axes(LAT, LON, half, size)
    return lats[:, None], lons[None, :]


# --------------------------------------------------------------------------- tiles and geometry

def test_terrarium_codec():
    e = np.array([[-431.5, 0.0, 0.25], [8848.86, 1234.5, -11034.0]], np.float32)
    back = T.decode_tile(T.encode_tile(np.tile(e, (128, 86))[:256, :256]), 256)
    assert np.allclose(back[:2, :3], e, atol=1 / 256 + 1e-3)
    with pytest.raises(ValueError):
        T.decode_tile(b"not a png", 256)
    with pytest.raises(ValueError):
        T.decode_tile(T.encode_tile(np.zeros((64, 64))), 256)


def test_zoom_matches_texel_size():
    for lat in (0.0, 35.0, 60.0, 80.0):
        for half, size in ((16.0, 1024), (64.0, 1024), (256.0, 1024)):
            texel = 2000.0 * half / size
            z = T.zoom_for(lat, texel, SRC)
            px = T.MERC_M_PER_PX * math.cos(math.radians(lat)) / (1 << z)
            assert 0.7 < px / texel < 1.42          # never more than ~1.4x too coarse or too fine
    assert T.zoom_for(35.0, 0.5, SRC) == SRC.max_zoom
    # 512 px tiles carry twice the detail per zoom
    assert T.zoom_for(35.0, 31.25, T.TileSource(SRC.url, 512)) == T.zoom_for(35.0, 31.25, SRC) - 1


def test_plan_covers_the_grid_and_wraps():
    p = T.plan_level(LAT, LON, 16.0, 1024, SRC)
    w, h = p.nx * 256, p.ny * 256
    assert 0 <= p.fx.min() and p.fx.max() <= w - 1 and 0 <= p.fy.min() and p.fy.max() <= h - 1
    assert len(p.tiles()) == p.nx * p.ny <= 49
    # rows run south to north: mercator y falls as the row index rises
    assert p.fy[0] > p.fy[-1] and p.fx[0] < p.fx[-1]
    # across the antimeridian the tile columns wrap, and stay unique
    q = T.plan_level(-17.7, 179.9, 256.0, 1024, SRC)
    xs = {x for _, x, _ in q.tiles()}
    assert 0 in xs and (1 << q.z) - 1 in xs and len(set(q.tiles())) == q.nx * q.ny
    # near the pole the rows clamp to the last tile row
    r = T.plan_level(88.5, 10.0, 256.0, 1024, SRC)
    assert all(0 <= y < (1 << r.z) for _, _, y in r.tiles())


# --------------------------------------------------------------------------- the patch

def test_patch_matches_the_ground(service, tiles):
    blob = asyncio.run(service.patch(LAT, LON, 512))
    head, levels = T.unpack(blob)
    assert head["size"] == 512 and head["half"] == [16.0, 64.0, 256.0] and head["lat"] == LAT and head["lon"] == LON
    assert head["attribution"] == SRC.attribution and len(head["zoom"]) == 3
    assert abs(head["elev"] - float(ground(LAT, LON))) < 3.0
    for lv, half in zip(levels, T.HALF_KM):
        assert lv.shape == (512, 512) and lv.dtype == np.int16
        la, lo = texel_latlon(half, 512)
        want = np.maximum(ground(la, lo), 0.0)
        inner = slice(64, 448)      # away from the blended rim
        err = np.abs(lv[inner, inner] - want[inner, inner])
        land = want[inner, inner] > 0
        assert float(np.percentile(err[land], 99)) < 6.0 and float(np.median(err[land])) < 1.5
    # the sea is level: the source's sea floor never shows
    assert min(int(lv.min()) for lv in levels) >= 0
    assert head["min"] >= 0 and head["max"] == max(int(lv.max()) for lv in levels)
    la, lo = texel_latlon(256.0, 512)
    bay = (ground(la, lo) < 0)[96:416, 96:416]
    assert bay.any() and int(np.abs(levels[2][96:416, 96:416][bay]).max()) <= 60     # 0, give or take the shoreline filter


def test_grids_meet_without_a_seam(service, tiles):
    head, levels = T.unpack(asyncio.run(service.patch(LAT, LON, 512)))
    f = [lv.astype(np.float32) for lv in levels]
    for k in (0, 1):
        up = T._from_coarser(f[k + 1], T.HALF_KM[k], T.HALF_KM[k + 1])
        rim = np.concatenate([f[k][0] - up[0], f[k][-1] - up[-1], f[k][:, 0] - up[:, 0], f[k][:, -1] - up[:, -1]])
        assert float(np.abs(rim).max()) <= 1.01      # the outermost texels are the coarser grid, to the metre
        mid = f[k][200:312, 200:312] - up[200:312, 200:312]
        assert float(np.abs(mid).max()) > 0.0        # ... while the middle keeps its own detail
    edge = np.concatenate([f[2][0], f[2][-1], f[2][:, 0], f[2][:, -1]])
    assert float(np.abs(edge - head["base"]).max()) <= 0.51


def _at(level, half, where):
    """The grid's value at a (lat, lon), and its row and column."""
    size = level.shape[0]
    j = int(((where[0] - LAT) * T.KM_PER_DEG + half) / (2 * half) * size)
    i = int(((where[1] - LON) * T.KM_PER_DEG * math.cos(math.radians(LAT)) + half) / (2 * half) * size)
    return float(level[j - 1:j + 2, i - 1:i + 2].max()), j, i


def test_false_spikes_are_mended_and_real_summits_kept(service, monkeypatch):
    fake = FakeTiles(faults=True)
    monkeypatch.setattr(T, "get_bytes", fake)
    head, levels = T.unpack(asyncio.run(service.patch(LAT, LON, 1024)))
    flat = float(ground(*NEEDLE))
    needle, _, _ = _at(levels[1], 64.0, NEEDLE)
    assert abs(needle - flat) < 60.0                 # the coarse zoom's needle is gone ...
    peak, _, _ = _at(levels[1], 64.0, PINNACLE)
    assert peak - float(ground(*PINNACLE)) > 350.0   # ... the pinnacle every zoom shows still stands
    assert service.stats["spikes_removed"] >= 1
    # the check looked at a finer zoom than the middle grid's own, a few tiles of it at most
    z1 = head["zoom"][1]
    extra = {t for t in fake.calls if t[0] == z1 + 2} - {t for p in [T.plan_level(LAT, LON, 16.0, 1024, SRC)] for t in p.tiles()}
    assert 1 <= len(extra) <= 6


def test_suspects_need_a_level_ring():
    rng = np.random.default_rng(11)
    a = (rng.normal(500, 8, (96, 96))).astype(np.float32)
    a[40, 40] += 600; a[41, 40] += 550; a[60:63, 20:23] -= 400      # a needle two texels wide, and a pit of 3 x 3
    yy, xx = np.mgrid[0:96, 0:96]
    a += (900 * np.exp(-((yy - 20) ** 2 + (xx - 70) ** 2) / (2 * 6.0 ** 2))).astype(np.float32)   # a broad mountain
    got = set(T.suspects(a))
    assert {(40, 40), (41, 40)} <= got and {(j, i) for j in range(60, 63) for i in range(20, 23)} <= got
    assert not any(abs(j - 20) < 12 and abs(i - 70) < 12 for j, i in got)      # the mountain has flanks: not a suspect
    assert T.suspects(np.full((32, 32), 100.0, np.float32)) == []
    assert len(T.suspects(a, limit=3)) == 3


def test_repair_survives_missing_check_tiles(service, monkeypatch):
    # the finer zoom can't be fetched where the needle is: the patch is still built, needle and all
    inner = set(T.plan_level(LAT, LON, 16.0, 1024, SRC).tiles())
    fake = FakeTiles(faults=True, fail=lambda z, x, y: z == 12 and (z, x, y) not in inner)
    monkeypatch.setattr(T, "get_bytes", fake)
    head, levels = T.unpack(asyncio.run(service.patch(LAT, LON, 1024)))
    assert head["size"] == 1024 and service.stats["patches"] == 1 and service.stats["spikes_removed"] == 0
    needle, _, _ = _at(levels[1], 64.0, NEEDLE)
    assert needle - float(ground(*NEEDLE)) > 300.0


def test_nest_keeps_the_middle_untouched():
    rng = np.random.default_rng(3)
    lv = [rng.uniform(100, 2000, (64, 64)).astype(np.float32) for _ in range(3)]
    out, base = T.nest(lv)
    for a, b in zip(lv, out):
        assert np.array_equal(a[16:48, 16:48], b[16:48, 16:48])
    assert 100 <= base <= 2000


def test_pack_roundtrip_and_size():
    rng = np.random.default_rng(5)
    rough = [rng.uniform(0, 8999, (512, 512)).astype(np.float32) for _ in range(3)]      # the worst case for the predictor
    head, back = T.unpack(T.pack(rough, {"lat": 1.0}))
    assert head["lat"] == 1.0 and head["v"] == 1
    assert all(np.array_equal(b, np.rint(a).astype(np.int16)) for a, b in zip(rough, back))
    smooth = T.synth_levels(LAT, LON, 512)
    blob = T.pack(smooth, {})
    assert len(blob) < 0.55 * 3 * 512 * 512 * 2      # real ground packs to well under half its raw size
    with pytest.raises(ValueError):
        T.unpack(b"MMS1" + bytes(64))


def test_synthetic_patch_is_stable():
    a, b = T.synth_patch(LAT, LON, 512), T.synth_patch(LAT, LON, 512)
    assert a == b
    head, levels = T.unpack(a)
    assert head["source"] == "demo" and len(levels) == 3 and head["max"] > head["min"] >= 0


# --------------------------------------------------------------------------- service and cache

def test_cache_tiles_and_patches(service, tiles):
    a = asyncio.run(service.patch(LAT, LON, 512))
    n = len(tiles.calls)
    assert 9 <= n <= 147 and len(set(tiles.calls)) == n        # each tile once
    assert service.stats["tiles_downloaded"] == n
    # the same point again: memory, then disk, never the network
    assert asyncio.run(service.patch(LAT + 0.0002, LON, 512)) is a
    service._out.clear()
    assert asyncio.run(service.patch(LAT, LON, 512)) == a and len(tiles.calls) == n
    # the other size is built from the tiles already on disk
    b = asyncio.run(service.patch(LAT, LON, 1024))
    assert len(tiles.calls) == n and T.unpack(b)[0]["size"] == 1024
    # a neighbour a few km away needs few new tiles, if any
    asyncio.run(service.patch(LAT + 0.03, LON + 0.03, 512))
    assert len(tiles.calls) - n < n / 2
    assert service.usage() > 0


def test_concurrent_requests_share_one_build(service, tiles):
    async def both():
        return await asyncio.gather(service.patch(LAT, LON, 512), service.patch(LAT, LON, 512))

    a, b = asyncio.run(both())
    assert a is b and len(set(tiles.calls)) == len(tiles.calls)


def test_cleanup_drops_least_recently_used(service, tiles):
    asyncio.run(service.patch(LAT, LON, 512))
    files = sorted(p for p in service.root.rglob("*") if p.is_file())
    old = files[0]
    os.utime(old, (time.time() - 86400, time.time() - 86400))
    total, size = service.usage(), old.stat().st_size
    service.cap = total - 1
    assert service.cleanup() == size           # just enough goes, oldest first
    assert not old.exists() and service.usage() == total - size
    service.cap = 10**12
    assert service.cleanup() == 0
    service.clear()
    assert service.usage() == 0


def test_failures_are_not_cached(service, monkeypatch):
    fake = FakeTiles(fail=lambda z, x, y: True)
    monkeypatch.setattr(T, "get_bytes", fake)
    with pytest.raises(FetchError):
        asyncio.run(service.patch(LAT, LON, 512))
    assert not list(service.root.rglob("*.mmt"))
    # the server comes back: the same request now works
    monkeypatch.setattr(T, "get_bytes", FakeTiles())
    assert T.unpack(asyncio.run(service.patch(LAT, LON, 512)))[0]["size"] == 512


def test_damaged_cached_tile_is_fetched_again(service, tiles):
    asyncio.run(service.patch(LAT, LON, 512))
    n = len(tiles.calls)
    victim = next(p for p in (service.root / "tiles").rglob("*.tile"))
    victim.write_bytes(b"garbage")
    for p in (service.root / "patch").glob("*"):
        p.unlink()
    service._out.clear()
    asyncio.run(service.patch(LAT, LON, 512))
    assert len(tiles.calls) == n + 1


def test_turned_off(tmp_path):
    svc = T.TerrainService(tmp_path, None, None)
    assert not svc.enabled
    with pytest.raises(NotAvailable):
        asyncio.run(svc.patch(LAT, LON, 512))
    assert svc.cleanup() == 0 and svc.usage() == 0


def test_settings_from_environment(monkeypatch):
    from mammatus import config

    monkeypatch.setenv("MAMMATUS_TERRAIN_URL", "off")
    assert config.load_settings().terrain_url is None
    monkeypatch.setenv("MAMMATUS_TERRAIN_URL", "https://tiles.example/no-placeholders.png")
    assert config.load_settings().terrain_url is None
    monkeypatch.setenv("MAMMATUS_TERRAIN_URL", "https://tiles.example/{z}/{x}/{y}.webp")
    monkeypatch.setenv("MAMMATUS_TERRAIN_TILE_SIZE", "512")
    s = config.load_settings()
    assert s.terrain_url.endswith("{y}.webp") and s.terrain_tile_px == 512
    monkeypatch.delenv("MAMMATUS_TERRAIN_URL")
    monkeypatch.setenv("MAMMATUS_TERRAIN_TILE_SIZE", "300")
    s = config.load_settings()
    assert "elevation-tiles-prod" in s.terrain_url and s.terrain_tile_px == 256


# --------------------------------------------------------------------------- API

H = {"X-Mammatus": "1", "Origin": "http://testserver"}


def _sign_in(c):
    """Works whether or not another test module has already set the server up."""
    from mammatus.db import get_db

    if c.get("/api/auth/state").json()["setup"]:
        code = get_db().get_meta("setup_token")
        r = c.post("/api/auth/setup", json={"code": code, "username": "adam", "password": "a fine long passphrase"}, headers=H)
    else:
        r = c.post("/api/auth/login", json={"username": "adam", "password": "a fine long passphrase"}, headers=H)
    assert r.status_code == 200, r.text


def test_terrain_route(tiles):
    from fastapi.testclient import TestClient

    from mammatus.app import create_app

    with TestClient(create_app()) as c:
        assert c.get(f"/api/sky/terrain?lat={LAT}&lon={LON}").status_code == 401
        _sign_in(c)
        assert c.get("/api/catalog").json()["sky"]["terrain"] is True
        assert c.get(f"/api/sky/terrain?lat={LAT}&lon={LON}&size=333").status_code == 400
        assert c.get(f"/api/sky/terrain?lat=95&lon={LON}").status_code == 422
        r = c.get(f"/api/sky/terrain?lat={LAT}&lon={LON}&size=512")
        assert r.status_code == 200, r.text
        assert "immutable" in r.headers["cache-control"] and "private" in r.headers["cache-control"]
        head, levels = T.unpack(r.content)        # the test client has already undone the gzip transfer coding
        assert head["size"] == 512 and len(levels) == 3
        sysinfo = c.get("/api/admin/system").json()["terrain"]
        assert sysinfo["enabled"] and sysinfo["bytes"] > 0 and sysinfo["patches"] >= 1
        # upstream trouble is a 502, and a terrain-less server a 404: the browser falls back either way
        svc = c.app.state.svc.terrain
        svc.clear()
        tiles.fail = lambda z, x, y: True
        assert c.get(f"/api/sky/terrain?lat={LAT}&lon={LON}&size=512").status_code == 502
        src, svc.source = svc.source, None
        try:
            assert c.get(f"/api/sky/terrain?lat={LAT}&lon={LON}&size=512").status_code == 404
            assert c.get("/api/catalog").json()["sky"]["terrain"] is False
        finally:
            svc.source = src
        c.post("/api/auth/logout", headers=H)


# --------------------------------------------------------------------------- the browser's side

JS_CHECK = r"""
import fs from "node:fs";
import { decodePatch, modelTerrain, HALF } from "%(module)s";
const raw = fs.readFileSync("%(patch)s");
const T = decodePatch(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const S = T.size, out = { size: S, elev: T.elev, sea: T.sea, real: T.real, levels: T.levels };
// a sample of texels back in metres, to compare with the server's own decoder
out.sample = [];
for (let k = 0; k < 3; k++) for (let i = 0; i < S * S; i += 4099) out.sample.push(Math.round(T.layers[k][i] * 1000 + T.elev));
out.centre = T.heightAt(0, 0);
function check(t) {
  const pyr = t.pyramids(), n = t.size;
  let seed = 7, worst = -1e9, seam = 0;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  // the maxima must bound the drawn surface at every level of every grid (else a ray could skip a hill)
  for (let it = 0; it < 60000; it++) {
    const k = it %% 3, H = HALF[k], V = k < 2 ? H * (1 - 1 / n) : H;
    const x = (rnd() * 2 - 1) * V, y = (rnd() * 2 - 1) * V, h = t.heightAt(x, y);
    for (const m of pyr[k]) {
      const ci = Math.min(m.w - 1, Math.floor((x + H) / (2 * H) * m.w)), cj = Math.min(m.w - 1, Math.floor((y + H) / (2 * H) * m.w));
      worst = Math.max(worst, h - m.data[(cj * m.w + ci) * 2 + 1]);
    }
  }
  // stepping from one grid onto the next changes the height by no more than a slope would
  for (let it = 0; it < 4000; it++) {
    const k = it %% 2, H = HALF[k] * (1 - 1 / n), u = (rnd() * 2 - 1) * H, d = 1e-4;
    for (const [a, b, c, e] of [[H - d, u, H + d, u], [u, H - d, u, H + d], [-H + d, u, -H - d, u], [u, -H + d, u, -H - d]]) seam = Math.max(seam, Math.abs(t.heightAt(a, b) - t.heightAt(c, e)));
  }
  return { worst, seam, chain: pyr.map((p) => p.length), top: pyr[2][pyr[2].length - 1].data[1], max: t.max };
}
out.real_ = check(T);
const box = new Float32Array(1600);
const hill = (i, j) => 0.4 * Math.sin(i / 5) * Math.cos(j / 7) + 0.015 * (i - 19.5);
for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) box[j * 40 + i] = hill(i, j) - hill(19.5, 19.5);     // relative to the point, as the server sends it
const M = modelTerrain(box, 40, { elev: 600, key: "m" });
out.model = { ...check(M), size: M.size, real: M.real, sea: M.sea, centre: M.heightAt(0, 0), far: M.heightAt(256, -256), base: M.base };
let threw = false;
try { decodePatch(new Uint8Array(64).buffer); } catch { threw = true; }
out.rejects = threw;
console.log(JSON.stringify(out));
"""


def test_browser_decoder_and_pyramids(tmp_path):
    """sky/terrain.js, run under Node: it must read what pack() writes and build maxima a ray can trust."""
    import gzip
    import json
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    blob = T.synth_patch(LAT, LON, 512)
    patch = tmp_path / "patch.bin"
    patch.write_bytes(gzip.decompress(blob))
    module = (Path(__file__).resolve().parents[1] / "mammatus/static/js/sky/terrain.js").as_posix()
    script = tmp_path / "check.mjs"
    script.write_text(JS_CHECK % {"module": module, "patch": patch.as_posix()})
    run = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-2000:]
    out = json.loads(run.stdout)
    head, levels = T.unpack(blob)
    assert out["size"] == 512 and out["real"] is True and out["levels"] == 10
    assert out["elev"] == head["elev"] and out["sea"] == pytest.approx(-head["elev"] / 1000)
    want = [int(levels[k].ravel()[i]) for k in range(3) for i in range(0, 512 * 512, 4099)]
    assert out["sample"] == want
    assert abs(out["centre"]) < 0.002                       # the ground at the point is the origin of heights
    for part in (out["real_"], out["model"]):
        assert part["worst"] <= 1e-6                        # nothing drawn stands above its block's maximum
        assert part["seam"] < 0.03                          # no cliff where two grids meet
        assert part["top"] == pytest.approx(part["max"], abs=1e-6)     # the coarsest block holds the highest ground
    assert out["real_"]["chain"] == [10, 10, 10]
    m = out["model"]
    assert m["real"] is False and m["sea"] < -1000 and m["size"] == 128
    assert m["centre"] == pytest.approx(0.0, abs=0.02)      # the model's box, read where the point is
    assert abs(m["far"] - m["base"]) < 1e-3                 # ... and a level plain far outside it
    assert out["rejects"] is True
