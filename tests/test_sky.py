"""Sky view: cloud-layer classification, box building from model cloud water, packing, and the API."""
import gzip
import math

import numpy as np
import pytest

from mammatus.data import sky
from mammatus.data.grib import register_grid


def column(layers, t_sfc=290.0, rain=0.0, snow=0.0):
    """A column with clouds between heights: [(base, top, cover, liq, ice, cum)]."""
    cover = np.zeros(sky.NZ, np.float32)
    liq, ice, cum = (np.zeros(sky.NZ, np.float32) for _ in range(3))
    for base, top, c, l, i, cu in layers:
        m = (sky.ZC >= base) & (sky.ZC <= top)
        cover[m], liq[m], ice[m], cum[m] = c, l, i, cu
    r = np.zeros(sky.NZ, np.float32)
    s = np.zeros(sky.NZ, np.float32)
    r[: int(2000 / sky.DZ)] = rain
    s[: int(2000 / sky.DZ)] = snow
    t = sky.std_temperature(sky.ZC, t_sfc)
    return cover, liq, ice, r, s, cum, t


def names(layers):
    return [ly["genus"] for ly in layers]


@pytest.mark.parametrize("layers,sfc,expect", [
    ([(900, 1800, 0.35, 0.4, 0, 1.0)], {"cape": 600}, ["Cu"]),
    ([(400, 900, 1.0, 0.3, 0, 0.1)], {}, ["St"]),
    ([(800, 1400, 0.9, 0.3, 0, 0.45)], {}, ["Sc"]),
    ([(3500, 4200, 0.5, 0.12, 0, 0.8)], {}, ["Ac"]),
    ([(3500, 4800, 0.95, 0.12, 0.01, 0.2)], {}, ["As"]),
    ([(9000, 10500, 0.4, 0, 0.02, 0.15)], {}, ["Ci"]),
    ([(9000, 10500, 0.95, 0, 0.02, 0.1)], {}, ["Cs"]),
    ([(9200, 9600, 0.5, 0, 0.02, 0.8)], {}, ["Cc"]),
    ([(1000, 6500, 0.5, 0.8, 0.05, 1.0)], {"cape": 1500}, ["TCu"]),
    ([(1000, 12000, 0.8, 0.8, 0.4, 0.9)], {"cape": 2500, "ltng": 2.0, "refc": 55}, ["Cb"]),
    ([(0, 200, 1.0, 0.2, 0, 0.05)], {"vis": 300}, ["Fg"]),
    ([(900, 1500, 0.4, 0.4, 0, 1.0), (9000, 10500, 0.9, 0, 0.02, 0.1)], {"cape": 300}, ["Cu", "Cs"]),
])
def test_classify(layers, sfc, expect):
    assert names(sky.classify(*column(layers), sfc)) == expect


def test_classify_rain_and_virga():
    ns = sky.classify(*column([(500, 6000, 1.0, 0.4, 0.05, 0.15)], rain=0.2), {})
    assert ns[0]["genus"] == "Ns" and ns[0]["precip"] == "rain"
    # a stratiform rain shield with a bright band is not a thunderstorm
    assert names(sky.classify(*column([(500, 11000, 1.0, 0.4, 0.05, 0.15)], rain=0.2), {"refc": 48})) == ["Ns"]
    cover, liq, ice, r, s, cum, t = column([(3500, 4300, 0.6, 0.12, 0, 0.7)])
    r[int(2500 / sky.DZ):int(3400 / sky.DZ)] = 0.05
    assert sky.classify(cover, liq, ice, r, s, cum, t, {})[0]["precip"] == "virga"


def test_mid_level_ice_deck_is_altostratus():
    # a snow-laden deck based at 2.3 km with virga under it: altostratus, not nimbostratus or cirrostratus
    cover, liq, ice, r, s, cum, t = column([(2300, 7700, 1.0, 0.02, 0.05, 0.15)], t_sfc=280.0)
    r[int(1000 / sky.DZ):int(2200 / sky.DZ)] = 0.02
    got = sky.classify(cover, liq, ice, r, s, cum, t, {})
    assert got[0]["genus"] == "As" and got[0]["precip"] == "virga"


def test_deep_shield_splits_into_as_and_cs():
    got = sky.classify(*column([(3000, 11500, 0.98, 0.1, 0.03, 0.15)]), {})
    assert names(got) == ["As", "Cs"]


def test_classify_uses_model_base_and_top():
    got = sky.classify(*column([(900, 1800, 0.35, 0.4, 0, 1.0)]), {"cape": 500}, base0=845.0, top1=1912.0)
    assert got[0]["base"] == 845 and got[0]["top"] == 1912


def test_water_content_codec():
    a = np.array([0, 5e-5, 1e-4, 0.01, 0.3, 3.2, 10.0], np.float32)
    back = sky.decode_wc(sky._encode_wc(a))
    assert back[0] == 0 and back[1] == 0
    ok = (a >= 1e-4) & (a <= 3.2)
    assert np.allclose(back[ok], a[ok], rtol=0.03)
    assert back[-1] == pytest.approx(back[-2])


@pytest.mark.parametrize("scene", sky.SCENES)
def test_pack_roundtrip(scene):
    blob = sky.pack(sky.synth_box(scene), {"model": "test"})
    head, vol, aux = sky.unpack(blob)
    assert vol.shape == aux.shape == (sky.NZ, sky.N, sky.N, 4)
    assert len(head["terrain"]) == sky.N * sky.N and len(head["profile"]["t"]) == sky.NZ
    assert head["model"] == "test" and head["n"] == sky.N
    if scene == "clear":
        assert head["layers"] == [] and aux[..., 0].max() == 0
    else:
        assert head["layers"] and aux[..., 0].max() > 0
    if scene == "storm":
        assert head["layers"][0]["genus"] == "Cb" and head["cells"] and head["mammatus"] > 0
    assert gzip.decompress(blob)[:4] == sky.MAGIC


def latlon_block(cloud_hpa=(850, 800), q=4e-4, ice_hpa=(300, 250)):
    """A fake GFS-like block: 0.25-degree grid, standard atmosphere, one water cloud and one ice cloud."""
    spec = {"type": "latlon", "ni": 40, "nj": 40, "la1": 30.0, "lo1": -90.0, "dlat": 0.25, "dlon": 0.25}
    grid = register_grid(spec)
    reg = sky.region_for(grid, 35.0, -85.0, 16, 6)
    h, w = len(reg.jj), len(reg.ii)
    levels = np.array([1000, 925, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100])
    L = len(levels)
    z_std = 44330.8 * (1 - (levels / 1013.25) ** 0.190263)
    t = np.broadcast_to(np.maximum(288.15 - 0.0065 * z_std, 216.65)[:, None, None], (L, h, w)).astype(np.float32)
    zero = np.zeros((L, h, w), np.float16)
    qcw, qci = zero.copy(), zero.copy()
    for p in cloud_hpa:
        qcw[list(levels).index(p)] = q
    for p in ice_hpa:
        qci[list(levels).index(p)] = 1e-4
    f2 = {"psfc": np.full((h, w), 101325.0, np.float32), "orog": np.zeros((h, w), np.float32),
          "t2m": np.full((h, w), 288.15, np.float32), "d2m": np.full((h, w), 283.0, np.float32),
          "cape": np.zeros((h, w), np.float32), "lcc": np.zeros((h, w), np.float32),
          "mcc": np.zeros((h, w), np.float32), "hcc": np.zeros((h, w), np.float32)}
    blk = sky.Block(grid, reg, f2, levels=levels, q={"cw": qcw, "ci": qci, "rw": zero, "sn": zero, "gr": zero},
                    frac3=None, tlev=levels, t=t, wlev=np.array([850, 500]),
                    u=np.stack([np.full((h, w), 10.0), np.full((h, w), 30.0)]).astype(np.float32),
                    v=np.zeros((2, h, w), np.float32))
    return blk, z_std


def test_box_from_levels_puts_clouds_at_the_right_height():
    blk, z_std = latlon_block()
    box = sky.box_from_block(blk, 35.0, -85.0, sky.SKY_MODELS["gfs"])
    mid = sky.N // 2
    col = box.frac[:, mid, mid]
    cloudy = sky.ZC[col > 0.2]
    # liquid on 850 and 800 hPa (1.46 and 1.95 km): the edges fall halfway to the clear levels either side
    # (925 hPa at 0.76 km, 700 at 3.01 km); ice on 300 and 250 hPa (9.16, 10.36 km), clear at 400 and 200
    low = cloudy[cloudy < 5000]
    high = cloudy[cloudy > 5000]
    assert 1000 < low.min() < 1450 and 1950 < low.max() < 2600
    assert 7900 < high.min() < 9200 and 10350 < high.max() < 11200
    assert box.liq[:, mid, mid].max() > 0.2 and box.ice[sky.ZC > 8000, mid, mid].max() > 0.02
    # wind interpolated between 850 and 500 hPa
    assert box.u[int(1500 / sky.DZ)] == pytest.approx(10.0, abs=1.5) and box.u[int(5600 / sky.DZ)] == pytest.approx(30.0, abs=1.5)
    head, _, _ = sky.unpack(sky.pack(box, {}))
    assert [ly["phase"] for ly in head["layers"]] == ["liquid", "ice"]


def test_region_outside_domain():
    spec = {"type": "lambert", "ni": 1799, "nj": 1059, "la1": 21.138123, "lo1": -122.719528, "lov": -97.5,
            "lad": 38.5, "latin1": 38.5, "latin2": 38.5, "dx": 3000.0, "dy": 3000.0, "jpos": 1}
    grid = register_grid(spec)
    reg = sky.region_for(grid, 35.6, -82.55, 128, 28)
    ri, rj = sky.box_targets(grid, reg, 35.6, -82.55)
    assert 0 <= ri.min() and ri.max() < len(reg.ii) and 0 <= rj.min() and rj.max() < len(reg.jj)
    # the box is 3 km cells on a 3 km grid: neighbouring columns one cell apart
    assert abs(float(ri[20, 21] - ri[20, 20]) - 1.0) < 0.05
    with pytest.raises(sky.NotAvailable):
        sky.region_for(grid, 51.5, -0.1, 128, 28)


def test_coarse_fields_follow_the_full_ones():
    """Temperature and wind come from one coarse, whole-domain copy per hour: resampled onto a region they
    must agree with the full field there (a smooth field, to within the smoothing of a 36 km mean)."""
    spec = {"type": "lambert", "ni": 1799, "nj": 1059, "la1": 21.138123, "lo1": -122.719528, "lov": -97.5,
            "lad": 38.5, "latin1": 38.5, "latin2": 38.5, "dx": 3000.0, "dy": 3000.0, "jpos": 1}
    grid = register_grid(spec)
    f = sky.coarse_factor(spec)
    assert f == 12
    assert sky.coarse_factor({"type": "latlon", "dlon": 0.25, "dlat": 0.25}) == 2
    assert sky.coarse_factor({"type": "latlon", "dlon": 1.0, "dlat": 1.0}) == 1
    j, i = np.mgrid[0:grid.nj, 0:grid.ni].astype(np.float32)
    full = 250.0 + 0.02 * i + 0.01 * j + 3.0 * np.sin(i / 90.0) * np.cos(j / 70.0)
    h, w = (grid.nj // f) * f, (grid.ni // f) * f
    coarse = full[:h, :w].reshape(h // f, f, w // f, f).mean(axis=(1, 3))[None]
    reg = sky.region_for(grid, 35.6, -82.55, 128, 28)
    got = sky.from_coarse(coarse, f, reg)[0]
    want = full[np.ix_(reg.jj, reg.ii)]
    assert got.shape == want.shape
    assert np.abs(got - want).max() < 0.05
    # at the domain's edge the coarse grid is clamped, never read out of range
    edge = sky.region_for(grid, 24.0, -80.6, 128, 28)
    assert np.isfinite(sky.from_coarse(coarse, f, edge)).all()


def test_parallel_decode_switch(monkeypatch):
    from mammatus.data import frames
    for env, expect in (("0", False), ("1", True)):
        monkeypatch.setenv("MAMMATUS_PARALLEL_DECODE", env)
        monkeypatch.setattr(frames, "_PARALLEL_DECODE", None)
        assert frames.parallel_decode() is expect
    # left alone, it goes by what the installed ecCodes says about itself (and remembers the answer)
    monkeypatch.delenv("MAMMATUS_PARALLEL_DECODE")
    monkeypatch.setattr(frames, "_PARALLEL_DECODE", None)
    first = frames.parallel_decode()
    assert first in (True, False) and frames.parallel_decode() is first


def test_sky_fetches_only_what_it_draws():
    """The fields a frame downloads: nothing whole-domain that the picture doesn't use."""
    for dropped in ("pbl", "vis", "mcc", "hcc", "tcc", "ctop"):
        assert dropped not in sky._F2D and dropped not in sky._F2D_CAM
    assert {"psfc", "t2m", "d2m", "cape", "refc"} <= set(sky._F2D)
    assert len(sky.T_LEVELS) <= 9 and len(sky.W_LEVELS) <= 4


def test_profile_fallback():
    z = [100, 800, 1500, 3000, 5500, 9000, 10500]
    cover = [0, 0.9, 0.2, 0, 0, 0.6, 0]
    t = [288, 284, 279, 268, 252, 228, 220]
    box = sky.box_from_profile(z, cover, t, elev=100.0, rain_mmh=1.0)
    head, _, _ = sky.unpack(sky.pack(box, {"estimated": True}))
    assert head["estimated"] is True
    assert [ly["phase"] for ly in head["layers"]][-1] == "ice"
    assert head["precip"]["kind"] == "rain"


JS_FLOW = r"""
import fs from "node:fs";
import { decodeFrame, flow, mergeBands, Loader } from "%(module)s";
const read = (p) => { const raw = fs.readFileSync(p); return decodeFrame(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)); };
const a = read("%(a)s"), b = read("%(b)s"), c = read("%(c)s");
const bands = mergeBands([...a.bands, ...b.bands]);
const out = { bands, filled: Array.from(a.filled).join(""), ab: flow(a, b, bands), ba: flow(b, a, bands), aa: flow(a, a, bands), ac: flow(a, c, mergeBands([...a.bands, ...c.bands])) };
// the loader: one fetch per frame however often it is asked for, what is wanted now ahead of what was fetched in case
const order = [];
globalThis.fetch = async (url) => { order.push(url); await new Promise((r) => setTimeout(r, 5)); return { ok: false, status: 404, statusText: "nope", json: async () => ({ detail: "no such hour" }) }; };
const L = new Loader();
const ids = [1, 2, 3, 4, 5, 6, 7].map((h) => `gfs/2026112712/${h}@35.000,-82.000`);
const ps = ids.map((id) => L.get(id, false).catch((e) => e.status));
const again = L.get(ids[6], true).catch((e) => e.status);         // now wanted: jumps the queue
out.status = await Promise.all([...ps, again]);
out.fetched = order.map((u) => +u.split("/")[6].split("?")[0]);
console.log(JSON.stringify(out));
"""


def test_browser_follows_clouds_between_hours(tmp_path):
    """sky/data.js under Node: the shift it finds between two hours is how far the clouds moved."""
    import json
    import shutil
    import subprocess
    from pathlib import Path

    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    paths = {}
    for name, scene, drift in (("a", "fair", 0.0), ("b", "fair", 1.0), ("c", "clear", 0.0)):
        paths[name] = tmp_path / f"{name}.bin"
        paths[name].write_bytes(gzip.decompress(sky.pack(sky.synth_box(scene, drift), {})))
    module = (Path(__file__).resolve().parents[1] / "mammatus/static/js/sky/data.js").as_posix()
    script = tmp_path / "flow.mjs"
    script.write_text(JS_FLOW % {"module": module, **{k: v.as_posix() for k, v in paths.items()}})
    run = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-2000:]
    out = json.loads(run.stdout)
    assert len(out["bands"]) == 2 and len(out["filled"]) == sky.NZ and "1" in out["filled"] and "0" in out["filled"]
    # an hour of the demo's drift moves the fields 6 cells east-west and 1.5 north-south (3 km cells)
    (lx, ly), (hx, hy) = out["ab"]
    assert abs(abs(lx) - 18.0) < 2.5 and abs(abs(ly) - 4.5) < 2.5
    assert abs(abs(hx) - 18.0) < 2.5
    # backwards it is the same journey the other way, and a frame against itself (or against a clear sky) stays put
    assert out["ba"][0][0] == pytest.approx(-lx, abs=1.5) and out["ba"][0][1] == pytest.approx(-ly, abs=1.5)
    assert out["aa"] == [[0, 0], [0, 0]]
    assert all(v == [0, 0] for v in out["ac"])
    assert out["status"] == [404] * 8
    assert sorted(out["fetched"]) == [1, 2, 3, 4, 5, 6, 7] and out["fetched"].index(7) == 4      # four under way, then the wanted one


JS_OVERHEAD = r"""
import fs from "node:fs";
import { decodeFrame } from "%(module)s";
const out = {};
for (const [name, path] of Object.entries(%(paths)s)) {
  const raw = fs.readFileSync(path);
  const f = decodeFrame(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const base = [], strength = [];
  for (let i = 0; i < f.anvil.length; i += 2) { base.push(f.anvil[i]); strength.push(f.anvil[i + 1]); }
  out[name] = { overhead: f.overhead, mammatus: f.head.mammatus, baseMin: Math.min(...base), baseMax: Math.max(...base),
                strong: strength.filter((x) => x > 0.02).length, cells: strength.length };
}
console.log(JSON.stringify(out));
"""


def test_browser_reads_the_light_under_cloud_and_the_anvil(tmp_path):
    """sky/data.js under Node: how much daylight the cloud overhead lets down, and where an anvil's base is."""
    import json
    import shutil
    import subprocess
    from pathlib import Path

    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    paths = {}
    for scene in ("clear", "fair", "stratus", "front", "storm"):
        paths[scene] = (tmp_path / f"{scene}.bin").as_posix()
        Path(paths[scene]).write_bytes(gzip.decompress(sky.pack(sky.synth_box(scene), {})))
    module = (Path(__file__).resolve().parents[1] / "mammatus/static/js/sky/data.js").as_posix()
    script = tmp_path / "overhead.mjs"
    script.write_text(JS_OVERHEAD % {"module": module, "paths": json.dumps(paths)})
    run = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-2000:]
    out = json.loads(run.stdout)
    # open sky, a broken field, a deck, a deep rain cloud: each lets less through than the last
    assert out["clear"]["overhead"] == {"open": 1, "deck": 1}
    assert 0.5 < out["fair"]["overhead"]["open"] < 1
    assert out["stratus"]["overhead"]["open"] < 0.3 and 0.1 < out["stratus"]["overhead"]["deck"] < 0.6
    assert out["front"]["overhead"]["open"] < 0.3 and out["front"]["overhead"]["deck"] < out["stratus"]["overhead"]["deck"] * 0.6
    # a storm's anvil: pouches under part of the box only, but a base height everywhere (the texture filter
    # must never blend it with "no anvil" at height zero)
    st = out["storm"]
    assert st["mammatus"] > 0 and 0 < st["strong"] < st["cells"]
    assert st["baseMin"] > 5 / 16 and st["baseMax"] < 13 / 16
    assert out["fair"]["baseMax"] == 0


def test_sky_routes_need_login():
    from fastapi.testclient import TestClient

    from mammatus.app import create_app

    with TestClient(create_app()) as c:
        assert c.get("/api/sky/frame/hrrr/2026112700/3?lat=35&lon=-82").status_code == 401
        assert c.get("/api/sky/estimated?lat=35&lon=-82&t=1").status_code == 401
        assert c.get("/api/sky/observed?lat=35&lon=-82").status_code == 401


def test_every_release_has_notes():
    """The release workflow publishes the CHANGELOG section of the version in mammatus/__init__.py."""
    import subprocess
    import sys
    from pathlib import Path

    tool = Path(__file__).resolve().parents[1] / "tools/release_notes.py"
    v = subprocess.run([sys.executable, str(tool), "--version"], capture_output=True, text=True, check=True).stdout.strip()
    out = subprocess.run([sys.executable, str(tool), v], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() and not out.stdout.lstrip().startswith("## ")
    assert f"## {v}" not in out.stdout and "\n## " not in out.stdout
