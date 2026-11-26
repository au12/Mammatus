"""Lightning (GOES GLM) and fronts (WPC coded bulletins) parsing and wire formats."""
import io
from datetime import datetime, timezone

import h5py
import numpy as np

from mammatus.data import lightning as L
from mammatus.data.fronts import decode_point, parse_bulletin

UTC = timezone.utc


def _glm_file(lat, lon, offsets, energy_j) -> bytes:
    """A minimal GLM L2 LCFA file with the same packing conventions as NOAA's."""
    buf = io.BytesIO()
    with h5py.File(buf, "w") as f:
        f.attrs["time_coverage_start"] = b"2026-11-26T21:00:00.0Z"
        f.create_dataset("flash_lat", data=np.asarray(lat, np.float32))
        f.create_dataset("flash_lon", data=np.asarray(lon, np.float32))
        sf, ao = 0.00038147560553625226, -5.0
        raw = np.round((np.asarray(offsets) - ao) / sf).astype(np.uint16).view(np.int16)
        t = f.create_dataset("flash_time_offset_of_first_event", data=raw)
        t.attrs["scale_factor"] = np.array([sf], np.float32)
        t.attrs["add_offset"] = np.array([ao], np.float32)
        t.attrs["_Unsigned"] = b"true"
        t.attrs["units"] = b"seconds since 2026-11-26 21:00:00.000"
        esf, eao = 9.999959802209943e-16, 2.8514998886357517e-16
        eraw = np.round((np.asarray(energy_j) - eao) / esf).astype(np.uint16).view(np.int16)
        e = f.create_dataset("flash_energy", data=eraw)
        e.attrs["scale_factor"] = np.array([esf], np.float32)
        e.attrs["add_offset"] = np.array([eao], np.float32)
        e.attrs["_Unsigned"] = b"true"
        e.attrs["_FillValue"] = np.array([-1], np.int16)
    return buf.getvalue()


def test_parse_glm_unpacks_time_and_energy():
    blob = _glm_file([35.6, -10.2], [-82.5, -60.1], [-0.5, 19.25], [2e-14, 1.5e-12])
    arr = L.parse_glm(blob)
    t0 = datetime(2026, 11, 26, 21, tzinfo=UTC).timestamp()
    assert len(arr) == 2
    assert np.allclose(arr["t"] - t0, [-0.5, 19.25], atol=0.002)
    assert np.allclose(arr["lat"], [35.6, -10.2], atol=1e-4)
    assert arr["e"][1] > arr["e"][0]  # brighter flash, higher energy class


def test_parse_name():
    s, e = L.parse_name("GLM-L2-LCFA/2026/330/21/OR_GLM-L2-LCFA_G19_s20263302159400_e20263302200000_c20263302200014.nc")
    assert datetime.fromtimestamp(s, UTC) == datetime(2026, 11, 26, 21, 59, 40, tzinfo=UTC)
    assert e - s == 20
    assert L.parse_name("something-else.nc") is None


def test_chunk_roundtrip_and_tail():
    t0 = 1_795_730_400
    arr = np.zeros(3, L.DTYPE)
    arr["t"] = [t0 + 599.5, t0 + 1.25, t0 + 300]
    arr["lat"], arr["lon"], arr["e"] = [10, -20.5, 45.1], [-60, -179.9, 179.5], [10, 200, 90]
    header, back = L.decode_chunk(L.encode_chunk(t0, arr, final=True, latest=None, now=t0 + 900))
    assert header["n"] == 3 and header["final"]
    assert list(np.round(back["t"] - t0, 2)) == [1.25, 300.0, 599.5]  # sorted by time
    assert np.allclose(back["lon"], [-179.9, 179.5, -60], atol=0.006)  # follows the time order


def test_coverage_intervals():
    iv: list = []
    L.add_interval(iv, 0, 20)
    L.add_interval(iv, 40, 60)
    assert not L.covers(iv, 0, 60)
    L.add_interval(iv, 20, 40)
    assert iv == [[0, 60]] and L.covers(iv, 0, 60)


def test_satellite_seam_is_exclusive_and_complete():
    lon = np.linspace(-180, 180, 721)
    east = L.nearest_satellite_mask(lon, "east", ["west"])
    west = L.nearest_satellite_mask(lon, "west", ["east"])
    assert not (east & west).any() and (east | west).all()
    assert east[np.searchsorted(lon, -80)] and west[np.searchsorted(lon, 170)]


ANALYSIS = """000
ASUS02 KWBC 261800
CODSUS

CODED SURFACE FRONTAL POSITIONS
NWS WEATHER PREDICTION CENTER COLLEGE PARK MD

VALID 112618Z
HIGHS 1037 4490630 1021 6381053
LOWS 995 3690769 1005
3730862
COLD 5241270 4981233 4801230 4641235
WARM WK 3790753 3760732 3670708
STNRY 6951481 6881548 6961635 6951665 7101749
COLD 1480824 1480824
TROF 3690769 3670772
$$
"""

FORECAST = """FSUS02 KWBC 261925
CODSRP

12HR PROG VALID 270600Z
HIGHS 1027 36128
LOWS 1001 53105
COLD 4171 3770 3072 2575
24HR PROG VALID 271800Z
TROF 3583 3681 3879
"""


def test_parse_analysis_bulletin():
    sets = parse_bulletin(ANALYSIS, datetime(2026, 11, 26, 18, tzinfo=UTC))
    assert len(sets) == 1
    s = sets[0]
    assert s["kind"] == "analysis" and s["valid"] == datetime(2026, 11, 26, 18, tzinfo=UTC)
    assert s["highs"][0] == [-63.0, 44.9, 1037]
    assert s["lows"][1] == [-86.2, 37.3, 1005]  # value continued on the next line
    types = [f["type"] for f in s["fronts"]]
    assert types == ["cold", "warm", "stationary", "trough"]  # single-point COLD dropped
    assert s["fronts"][1]["strength"] == "weak"
    assert s["fronts"][0]["coords"][0] == [-127.0, 52.4]


def test_parse_forecast_bulletin():
    sets = parse_bulletin(FORECAST, datetime(2026, 11, 26, 19, 25, tzinfo=UTC))
    assert [(s["kind"], s["hours"]) for s in sets] == [("forecast", 12), ("forecast", 24)]
    assert sets[0]["valid"] == datetime(2026, 11, 27, 6, tzinfo=UTC)
    assert sets[0]["fronts"][0]["coords"][:2] == [[-71.0, 41.0], [-70.0, 37.0]]


def test_decode_point_and_dateline():
    assert decode_point("4731193") == (-119.3, 47.3)
    assert decode_point("38102") == (-102.0, 38.0)
    assert decode_point("6571850") == (175.0, 65.7)  # 185 W is 175 E
    assert decode_point("12") is None
