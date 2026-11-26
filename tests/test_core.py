"""Unit tests: frame codec, GRIB index parsing, projections, password/TOTP helpers, Web Push encryption."""
import base64
import struct

import numpy as np
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from mammatus.data import frames, grib
from mammatus import security, webpush


def test_frame_roundtrip():
    rng = np.random.default_rng(1)
    vals = (rng.normal(280, 8, (37, 53))).astype(np.float32)
    vals[3, 4] = np.nan
    q = frames.quantize(vals, 0.1, 150.0)
    blob = frames.encode({"w": 53, "h": 37, "comps": 1, "scale": 0.1, "offset": 150.0}, [q])
    header, comps = frames.decode(blob)
    assert header["w"] == 53 and len(comps) == 1
    assert np.array_equal(comps[0], q)
    back = frames.dequantize(comps[0], 0.1, 150.0)
    assert np.isnan(back[3, 4])
    ok = ~np.isnan(vals)
    assert np.nanmax(np.abs(back[ok] - vals[ok])) <= 0.051


def test_downsample_shapes():
    a = np.arange(16, dtype=np.float32).reshape(4, 4)
    assert frames.downsample(a, "mean").shape == (2, 2)
    assert frames.downsample(a, "max")[0, 0] == 5


def test_parse_wgrib_idx():
    text = (
        "1:0:d=2026112612:TMP:2 m above ground:anl:\n"
        "2:1000:d=2026112612:APCP:surface:0-6 hour acc fcst:\n"
        "3:2500:d=2026112612:UGRD:10 m above ground:6 hour fcst:\n"
    )
    recs = grib.parse_wgrib_idx(text)
    assert [r.var for r in recs] == ["TMP", "APCP", "UGRD"]
    assert recs[0].start == 0 and recs[0].end == 999
    assert recs[2].end is None


def test_lambert_roundtrip():
    spec = {"type": "lambert", "nx": 1799, "ny": 1059, "la1": 21.138123, "lo1": 237.280472, "lov": 262.5,
            "latin1": 38.5, "latin2": 38.5, "lad": 38.5, "dx": 3000.0, "dy": 3000.0, "jpos": 1}
    c = grib.lambert_constants(spec)
    lat, lon = np.array([35.6, 47.0]), np.array([-82.55, -122.3])
    i, j = grib.lambert_forward(lat, lon, spec, c)
    assert 0 < i[0] < spec["nx"] and 0 < j[0] < spec["ny"]
    lat2, lon2 = grib.lambert_inverse(i * spec["dx"] + c["x1"], j * spec["dy"] + c["y1"], spec, c)
    assert np.allclose(lat2, lat, atol=1e-6)
    assert np.allclose(((lon2 + 180) % 360) - 180, lon, atol=1e-6)


def test_password_hashing():
    h = security.hash_password("correct horse battery")
    assert security.verify_password("correct horse battery", h)
    assert not security.verify_password("wrong", h)
    assert security.password_problem("short") is not None
    assert security.password_problem("adamadamadam", "adam") is not None
    assert security.password_problem("a fine long passphrase") is None


def test_totp_and_replay():
    secret = security.totp_new_secret()
    code = security.totp_code(secret, at=1_800_000_000)
    # the current code is accepted exactly once (replay protection)
    now_code = security.totp_code(secret)
    c1 = security.totp_verify(secret, now_code, 0)
    assert c1 is not None
    assert security.totp_verify(secret, now_code, c1) is None
    assert len(code) == 6


def test_rate_limiter():
    rl = security.RateLimiter(3, 60)
    assert all(rl.hit("k") for _ in range(3))
    assert not rl.hit("k")
    assert rl.retry_after("k") > 0


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def test_webpush_encrypt_decrypts_per_rfc8291():
    ua_priv = ec.generate_private_key(ec.SECP256R1())
    ua_pub = ua_priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = b"0123456789abcdef"
    body = webpush.encrypt_payload(b'{"title":"hi"}', _b64u(ua_pub), _b64u(auth))
    salt, rs, idlen = body[:16], struct.unpack(">I", body[16:20])[0], body[20]
    as_pub = body[21:21 + idlen]
    ct = body[21 + idlen:]
    assert rs == 4096 and idlen == 65
    shared = ua_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    hk = lambda salt_, ikm, info, n: HKDF(hashes.SHA256(), n, salt_, info).derive(ikm)
    ikm = hk(auth, shared, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    cek = hk(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = hk(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    pt = AESGCM(cek).decrypt(nonce, ct, None)
    assert pt == b'{"title":"hi"}\x02'


def test_vapid_jwt(tmp_path):
    keys = webpush.load_or_create_vapid(tmp_path)
    token = keys.jwt("https://fcm.googleapis.com", "mailto:test@example.com")
    head, payload, sig = token.split(".")
    assert len(base64.urlsafe_b64decode(sig + "==")) == 64
    assert len(base64.urlsafe_b64decode(keys.public_b64 + "==")) == 65
