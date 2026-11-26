"""Security primitives: password hashing, tokens, TOTP, rate limiting, client IP.

Only the standard library and ``cryptography`` are used. Passwords are hashed
with scrypt (memory-hard). Session and invite tokens are random 256-bit values;
only their SHA-256 digests are stored, so a database leak does not leak
working credentials.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import secrets
import struct
import time
from collections import deque
from dataclasses import dataclass

SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_MAXMEM = 96 * 1024 * 1024

COMMON_PASSWORDS = {
    "password", "password1", "password123", "123456789", "1234567890", "qwertyuiop",
    "letmein123", "iloveyou12", "welcome123", "adminadmin", "administrator", "changeme123",
    "baseball12", "football12", "sunshine12", "princess12", "dragon1234", "monkey1234",
    "trustno1234", "passw0rd12", "mammatus123", "weather123", "qwerty1234", "abc1234567",
}


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
        dklen=32, maxmem=SCRYPT_MAXMEM,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64u(salt)}${b64u(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        calc = hashlib.scrypt(
            password.encode("utf-8"), salt=b64u_decode(salt), n=int(n), r=int(r), p=int(p),
            dklen=32, maxmem=SCRYPT_MAXMEM,
        )
        return hmac.compare_digest(calc, b64u_decode(digest))
    except Exception:
        return False


# A fixed hash used to equalize timing when the username does not exist.
_DUMMY_HASH: str | None = None


def dummy_verify(password: str) -> None:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_hex(8))
    verify_password(password, _DUMMY_HASH)


def password_problem(password: str, username: str = "") -> str | None:
    """Return a human-readable reason the password is unacceptable, or None."""
    if len(password) < 10:
        return "Use at least 10 characters."
    if len(password) > 256:
        return "That password is too long."
    low = password.lower()
    if low in COMMON_PASSWORDS:
        return "That password is too common."
    if username and username.lower() in low:
        return "Don't include your username in the password."
    if len(set(password)) < 5:
        return "Use a less repetitive password."
    return None


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# -- TOTP (RFC 6238) --------------------------------------------------------

def totp_new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _hotp(secret_b32: str, counter: int, digits: int = 6) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8), casefold=True)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF) % (10**digits)
    return str(code).zfill(digits)


def totp_code(secret_b32: str, at: float | None = None, step: int = 30) -> str:
    return _hotp(secret_b32, int((at or time.time()) // step))


def totp_verify(secret_b32: str, code: str, last_counter: int = 0, window: int = 1, step: int = 30) -> int | None:
    """Verify a code; returns the matched counter (to prevent replay) or None."""
    code = "".join(ch for ch in (code or "") if ch.isdigit())
    if len(code) != 6:
        return None
    now_counter = int(time.time() // step)
    for delta in range(-window, window + 1):
        counter = now_counter + delta
        if counter <= last_counter:
            continue
        if hmac.compare_digest(_hotp(secret_b32, counter), code):
            return counter
    return None


def totp_uri(secret_b32: str, username: str, issuer: str = "Mammatus") -> str:
    from urllib.parse import quote

    label = quote(f"{issuer}:{username}")
    return f"otpauth://totp/{label}?secret={secret_b32}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30"


# -- rate limiting ------------------------------------------------------------

@dataclass
class _Window:
    hits: deque


class RateLimiter:
    """Sliding-window limiter keyed by arbitrary strings (IP, user, route)."""

    def __init__(self, limit: int, period: float):
        self.limit = limit
        self.period = period
        self._buckets: dict[str, deque] = {}
        self._last_gc = time.monotonic()

    def hit(self, key: str) -> bool:
        """Record a hit; return False if the key is over its limit."""
        now = time.monotonic()
        bucket = self._buckets.setdefault(key, deque())
        while bucket and now - bucket[0] > self.period:
            bucket.popleft()
        if len(bucket) >= self.limit:
            return False
        bucket.append(now)
        if now - self._last_gc > 300:
            self._gc(now)
        return True

    def retry_after(self, key: str) -> int:
        bucket = self._buckets.get(key)
        if not bucket:
            return 0
        return max(1, int(self.period - (time.monotonic() - bucket[0])) + 1)

    def _gc(self, now: float) -> None:
        self._last_gc = now
        for key in list(self._buckets):
            bucket = self._buckets[key]
            while bucket and now - bucket[0] > self.period:
                bucket.popleft()
            if not bucket:
                del self._buckets[key]


def _is_trusted(ip: str, trusted: list) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in trusted)


def client_ip(peer: str | None, headers, trusted: list) -> str:
    """Resolve the real client IP, honoring X-Forwarded-For only from trusted proxies."""
    peer = peer or "0.0.0.0"
    if not _is_trusted(peer, trusted):
        return peer
    xff = headers.get("x-forwarded-for")
    if not xff:
        real = headers.get("x-real-ip")
        return real.strip() if real else peer
    hops = [h.strip() for h in xff.split(",") if h.strip()]
    # Walk from the right; the first untrusted hop is the client.
    for hop in reversed(hops):
        if not _is_trusted(hop, trusted):
            return hop
    return hops[0] if hops else peer


def request_scheme(peer: str | None, headers, trusted: list, default: str) -> str:
    if peer and _is_trusted(peer, trusted):
        proto = headers.get("x-forwarded-proto")
        if proto:
            return proto.split(",")[0].strip().lower()
    return default


def request_host(peer: str | None, headers, trusted: list) -> str:
    if peer and _is_trusted(peer, trusted):
        fwd = headers.get("x-forwarded-host")
        if fwd:
            return fwd.split(",")[0].strip().lower()
    return (headers.get("host") or "").lower()
