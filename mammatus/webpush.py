"""Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).

Implemented directly on ``cryptography`` so the image does not need pywebpush
or ``requests``. Keys are generated on first start and stored in the data dir.
"""

from __future__ import annotations

import json
import logging
import os
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .security import b64u, b64u_decode

log = logging.getLogger("mammatus.push")


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def _public_bytes(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def encrypt_payload(payload: bytes, p256dh_b64: str, auth_b64: str, record_size: int = 4096) -> bytes:
    """Encrypt ``payload`` for a push subscription using aes128gcm."""
    ua_public_bytes = b64u_decode(p256dh_b64)
    auth_secret = b64u_decode(auth_b64)
    ua_public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public_bytes)

    as_private = ec.generate_private_key(ec.SECP256R1())
    as_public_bytes = _public_bytes(as_private.public_key())
    shared = as_private.exchange(ec.ECDH(), ua_public)

    key_info = b"WebPush: info\x00" + ua_public_bytes + as_public_bytes
    ikm = _hkdf(auth_secret, shared, key_info, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)

    if len(payload) > record_size - 17 - 86:
        raise ValueError("push payload too large")
    plaintext = payload + b"\x02"
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext, None)
    header = salt + struct.pack(">I", record_size) + bytes([len(as_public_bytes)]) + as_public_bytes
    return header + ciphertext


@dataclass
class VapidKeys:
    private_key: ec.EllipticCurvePrivateKey

    @property
    def public_b64(self) -> str:
        return b64u(_public_bytes(self.private_key.public_key()))

    def jwt(self, audience: str, subject: str, ttl: int = 12 * 3600) -> str:
        header = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
        claims = b64u(json.dumps(
            {"aud": audience, "exp": int(time.time()) + ttl, "sub": subject}, separators=(",", ":")
        ).encode())
        signing_input = f"{header}.{claims}".encode("ascii")
        der = self.private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return f"{header}.{claims}.{b64u(sig)}"


def load_or_create_vapid(keys_dir: Path) -> VapidKeys:
    keys_dir.mkdir(parents=True, exist_ok=True)
    path = keys_dir / "vapid_private.pem"
    if path.exists():
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        assert isinstance(key, ec.EllipticCurvePrivateKey)
        return VapidKeys(key)
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(pem)
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    log.info("Generated new VAPID key pair")
    return VapidKeys(key)


class PushGone(Exception):
    """The subscription is expired or unsubscribed (HTTP 404/410)."""


async def send_push(
    client: httpx.AsyncClient,
    vapid: VapidKeys,
    subject: str,
    endpoint: str,
    p256dh: str,
    auth: str,
    message: dict,
    ttl: int = 6 * 3600,
    urgency: str = "normal",
    topic: str | None = None,
) -> None:
    parsed = urlparse(endpoint)
    if parsed.scheme != "https":
        raise ValueError("push endpoint must be https")
    audience = f"{parsed.scheme}://{parsed.netloc}"
    body = encrypt_payload(json.dumps(message, separators=(",", ":")).encode("utf-8"), p256dh, auth)
    headers = {
        "TTL": str(ttl),
        "Urgency": urgency,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Authorization": f"vapid t={vapid.jwt(audience, subject)}, k={vapid.public_b64}",
    }
    if topic:
        # Topic must be <= 32 URL-safe base64 chars; it collapses pending duplicates.
        headers["Topic"] = "".join(ch for ch in topic if ch.isalnum() or ch in "-_")[:32]
    resp = await client.post(endpoint, content=body, headers=headers, timeout=20)
    if resp.status_code in (404, 410):
        raise PushGone(resp.status_code)
    if resp.status_code >= 400:
        raise RuntimeError(f"push service returned {resp.status_code}: {resp.text[:200]}")
