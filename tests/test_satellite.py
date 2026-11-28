"""Satellite composite stitching: tile grid and polar smoothing."""
import io

import numpy as np
from PIL import Image

from mammatus.data import satellite as S


def _tile(value: int) -> bytes:
    buf = io.BytesIO()
    Image.new("LA", (256, 256), (value, 255)).save(buf, "PNG")
    return buf.getvalue()


def test_stitch_covers_the_globe_once():
    # RealEarth's EPSG:4326 grid is 2^z x 2^z; each column must be a different slice of longitude
    n = 2 ** S.ZOOM
    results = [(x, y, _tile(40 + 40 * x)) for y in range(n) for x in range(n)]
    im = np.asarray(Image.open(io.BytesIO(S._stitch(results, n, n, "globalir"))).convert("L"), np.float32)
    assert im.shape == (n * 256, n * 256)
    eq = im[im.shape[0] // 2]
    cols = [float(np.median(eq[x * 256 + 64:x * 256 + 192])) for x in range(n)]
    assert cols == sorted(cols) and len(set(round(c) for c in cols)) == n


def test_polar_smooth_meets_the_pole_in_one_value():
    rng = np.random.default_rng(3)
    h, w = 512, 1024
    lum = rng.uniform(0, 255, (h, w)).astype(np.float32)   # worst case: noise in every row
    cov = np.full((h, w), 255.0, np.float32)
    out, c = S.polar_smooth(lum, cov)
    # the rows touching each pole collapse to (nearly) one value: no spikes radiating from the pole
    assert out[0].std() < 1.0 and out[-1].std() < 1.0
    # rows whose pixels are still as wide on the ground as they are tall are untouched
    lat = 90 - (np.arange(h) + 0.5) * 180 / h
    mid = np.abs(lat) < 35  # 1/cos(lat) < 1.25 on this 2:1 image
    assert np.array_equal(out[mid], lum[mid])
    # east-west variation fades steadily toward the pole (no rows skipped, no banding);
    # rows run pole -> equator here, so it should only grow
    sd = out[: h // 2].std(axis=1).reshape(-1, 8).mean(axis=1)
    assert np.all(np.diff(sd) >= -1.0)
    assert np.allclose(c, 255.0)


def test_polar_smooth_weights_by_coverage():
    h, w = 256, 512
    lum = np.full((h, w), 200.0, np.float32)
    cov = np.zeros((h, w), np.float32)
    cov[:, ::4] = 255.0   # sparse coverage; uncovered pixels hold junk luminance
    lum[:, 1::4] = 0.0
    out, c = S.polar_smooth(lum, cov)
    covered = c[0] > 1
    assert np.allclose(out[0][covered], 200.0, atol=0.5)   # gaps don't darken the clouds
