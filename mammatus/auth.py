"""Accounts, sessions and the authentication API.

Design:
- Invite-only registration. The first admin is created with a one-time setup
  token printed to the container log (or from MAMMATUS_ADMIN_USER/PASSWORD).
- Sessions are random tokens in an HttpOnly, SameSite=Lax cookie (__Host- prefixed
  over HTTPS); only SHA-256 digests are stored.
- Optional TOTP second factor, with replay protection.
- Login throttling per IP and per username, constant-time responses for
  unknown users.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .config import settings
from .db import get_db
from .security import (
    RateLimiter, dummy_verify, hash_password, new_token, password_problem, request_scheme, token_digest,
    totp_new_secret, totp_uri, totp_verify, verify_password,
)

log = logging.getLogger("mammatus.auth")
router = APIRouter(prefix="/api/auth", tags=["auth"])

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,32}$")
login_ip_limiter = RateLimiter(20, 300)
login_user_limiter = RateLimiter(8, 900)
signup_limiter = RateLimiter(10, 3600)
totp_limiter = RateLimiter(6, 300)
_mfa_tickets: dict[str, tuple[int, float, int]] = {}  # digest -> (user_id, expires, attempts)


@dataclass
class CurrentUser:
    id: int
    username: str
    display_name: str
    role: str
    totp_enabled: bool
    prefs: dict
    session_id: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def public(self) -> dict:
        return {
            "id": self.id, "username": self.username, "displayName": self.display_name or self.username,
            "role": self.role, "totp": self.totp_enabled, "prefs": self.prefs,
        }


# --------------------------------------------------------------------------- cookies

def _secure(request: Request) -> bool:
    mode = settings.cookie_secure
    if mode in ("true", "1", "yes"):
        return True
    if mode in ("false", "0", "no"):
        return False
    default = "https" if (settings.public_url or "").startswith("https") else request.url.scheme
    peer = request.client.host if request.client else None
    return request_scheme(peer, request.headers, settings.trusted_proxies, default) == "https"


def cookie_name(request: Request) -> str:
    return "__Host-mammatus" if _secure(request) else "mammatus"


def set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        cookie_name(request), token, max_age=settings.session_days * 86400, path="/",
        secure=_secure(request), httponly=True, samesite="lax",
    )


def clear_session_cookie(request: Request, response: Response) -> None:
    for name in ("__Host-mammatus", "mammatus"):
        response.delete_cookie(name, path="/", secure=name.startswith("__Host-"), httponly=True, samesite="lax")


def create_session(request: Request, user_id: int, mfa: bool) -> str:
    token = new_token(32)
    now = int(time.time())
    db = get_db()
    db.execute(
        "INSERT INTO sessions(id,user_id,created_at,last_seen_at,expires_at,ip,user_agent,mfa) VALUES(?,?,?,?,?,?,?,?)",
        (token_digest(token), user_id, now, now, now + settings.session_days * 86400,
         getattr(request.state, "client_ip", None), (request.headers.get("user-agent") or "")[:200], int(mfa)),
    )
    db.execute("UPDATE users SET last_login_at=? WHERE id=?", (now, user_id))
    # cap sessions per user
    db.execute(
        "DELETE FROM sessions WHERE user_id=? AND id NOT IN (SELECT id FROM sessions WHERE user_id=? "
        "ORDER BY last_seen_at DESC LIMIT 20)", (user_id, user_id),
    )
    return token


def load_session(request: Request) -> CurrentUser | None:
    token = request.cookies.get("__Host-mammatus") or request.cookies.get("mammatus")
    if not token or len(token) > 128:
        return None
    digest = token_digest(token)
    db = get_db()
    row = db.one(
        "SELECT s.id sid, s.last_seen_at, s.expires_at, u.* FROM sessions s JOIN users u ON u.id=s.user_id "
        "WHERE s.id=?", (digest,),
    )
    now = int(time.time())
    if not row or row["expires_at"] < now or row["disabled"]:
        return None
    if now - row["last_seen_at"] > 300:
        db.execute(
            "UPDATE sessions SET last_seen_at=?, expires_at=?, ip=? WHERE id=?",
            (now, now + settings.session_days * 86400, getattr(request.state, "client_ip", None), digest),
        )
    try:
        prefs = json.loads(row["prefs"] or "{}")
    except json.JSONDecodeError:
        prefs = {}
    return CurrentUser(row["id"], row["username"], row["display_name"] or "", row["role"],
                       bool(row["totp_enabled"]), prefs, digest)


def require_user(request: Request) -> CurrentUser:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(401, "Sign in required")
    return user


def require_admin(user: CurrentUser = Depends(require_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(403, "Admin only")
    return user


# --------------------------------------------------------------------------- bootstrap

def users_exist() -> bool:
    return get_db().one("SELECT 1 x FROM users LIMIT 1") is not None


def bootstrap() -> None:
    """Create the env-provided admin, or print a one-time setup token."""
    db = get_db()
    if users_exist():
        db.set_meta("setup_token", None)
        return
    if settings.admin_user and settings.admin_password:
        problem = password_problem(settings.admin_password, settings.admin_user)
        if problem:
            log.error("MAMMATUS_ADMIN_PASSWORD rejected: %s", problem)
        elif USERNAME_RE.match(settings.admin_user):
            _create_user(settings.admin_user, settings.admin_password, "admin", settings.admin_user)
            log.info("Created admin account %r from environment", settings.admin_user)
            return
    token = db.get_meta("setup_token")
    if not token:
        token = "-".join(secrets.token_hex(3) for _ in range(4))
        db.set_meta("setup_token", token)
    log.warning("=" * 64)
    log.warning(" Mammatus first-run setup: open the web UI and enter this code")
    log.warning("   %s", token)
    log.warning("=" * 64)


def _create_user(username: str, password: str, role: str, display: str | None) -> int:
    now = int(time.time())
    return get_db().insert(
        "INSERT INTO users(username, display_name, pw_hash, role, created_at, pw_changed_at) VALUES(?,?,?,?,?,?)",
        (username, (display or username)[:60], hash_password(password), role, now, now),
    )


# --------------------------------------------------------------------------- schemas

class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class TotpIn(BaseModel):
    ticket: str = Field(max_length=128)
    code: str = Field(max_length=12)


class SetupIn(BaseModel):
    code: str = Field(max_length=64)
    username: str = Field(max_length=32)
    password: str = Field(max_length=256)
    displayName: str | None = Field(default=None, max_length=60)


class RegisterIn(BaseModel):
    token: str = Field(max_length=128)
    username: str = Field(max_length=32)
    password: str = Field(max_length=256)
    displayName: str | None = Field(default=None, max_length=60)


class ResetIn(BaseModel):
    token: str = Field(max_length=128)
    password: str = Field(max_length=256)


class PasswordIn(BaseModel):
    current: str = Field(max_length=256)
    new: str = Field(max_length=256)


class MeIn(BaseModel):
    displayName: str | None = Field(default=None, max_length=60)
    prefs: dict | None = None


class CodeIn(BaseModel):
    code: str = Field(max_length=12)
    password: str | None = Field(default=None, max_length=256)


# --------------------------------------------------------------------------- routes

def _ip(request: Request) -> str:
    return getattr(request.state, "client_ip", "?")


@router.get("/state")
def auth_state(request: Request):
    user = getattr(request.state, "user", None)
    return {"setup": not users_exist(), "user": user.public() if user else None}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response):
    ip = _ip(request)
    uname = body.username.strip().lower()
    if not login_ip_limiter.hit(ip) or not login_user_limiter.hit(uname):
        get_db().audit("login_throttled", ip=ip, detail=uname)
        raise HTTPException(429, "Too many attempts. Wait a few minutes and try again.")
    db = get_db()
    row = db.one("SELECT * FROM users WHERE username=?", (uname,))
    if not row:
        dummy_verify(body.password)
        db.audit("login_failed", ip=ip, detail=uname)
        raise HTTPException(401, "Wrong username or password.")
    if not verify_password(body.password, row["pw_hash"]) or row["disabled"]:
        db.audit("login_failed", user_id=row["id"], ip=ip)
        raise HTTPException(401, "Wrong username or password.")
    if row["totp_enabled"]:
        ticket = new_token(24)
        _mfa_tickets[token_digest(ticket)] = (row["id"], time.time() + 300, 0)
        return {"mfa": True, "ticket": ticket}
    token = create_session(request, row["id"], mfa=False)
    set_session_cookie(request, response, token)
    db.audit("login", user_id=row["id"], ip=ip)
    return {"ok": True}


@router.post("/login/totp")
def login_totp(body: TotpIn, request: Request, response: Response):
    ip = _ip(request)
    if not totp_limiter.hit(ip):
        raise HTTPException(429, "Too many attempts. Wait a few minutes.")
    digest = token_digest(body.ticket)
    entry = _mfa_tickets.get(digest)
    now = time.time()
    for k, (_, exp, _) in list(_mfa_tickets.items()):
        if exp < now:
            _mfa_tickets.pop(k, None)
    if not entry or entry[1] < now or entry[2] >= 5:
        _mfa_tickets.pop(digest, None)
        raise HTTPException(401, "Sign-in expired. Start again.")
    user_id = entry[0]
    db = get_db()
    row = db.one("SELECT * FROM users WHERE id=?", (user_id,))
    counter = totp_verify(row["totp_secret"] or "", body.code, row["totp_last"] or 0) if row else None
    if counter is None:
        _mfa_tickets[digest] = (user_id, entry[1], entry[2] + 1)
        db.audit("totp_failed", user_id=user_id, ip=ip)
        raise HTTPException(401, "That code didn't match.")
    db.execute("UPDATE users SET totp_last=? WHERE id=?", (counter, user_id))
    _mfa_tickets.pop(digest, None)
    token = create_session(request, user_id, mfa=True)
    set_session_cookie(request, response, token)
    db.audit("login", user_id=user_id, ip=ip, detail="totp")
    return {"ok": True}


@router.post("/logout")
def logout(request: Request, response: Response):
    user = getattr(request.state, "user", None)
    if user:
        get_db().execute("DELETE FROM sessions WHERE id=?", (user.session_id,))
    clear_session_cookie(request, response)
    return {"ok": True}


@router.post("/setup")
def setup(body: SetupIn, request: Request, response: Response):
    ip = _ip(request)
    if not signup_limiter.hit(ip):
        raise HTTPException(429, "Too many attempts.")
    db = get_db()
    if users_exist():
        raise HTTPException(409, "Setup is already complete.")
    token = db.get_meta("setup_token")
    if not token or not secrets.compare_digest(body.code.strip().lower(), str(token)):
        db.audit("setup_failed", ip=ip)
        raise HTTPException(403, "That setup code isn't right. Find it in the container log.")
    uname = body.username.strip().lower()
    if not USERNAME_RE.match(uname):
        raise HTTPException(400, "Usernames are 2-32 letters, numbers, dots, dashes or underscores.")
    problem = password_problem(body.password, uname)
    if problem:
        raise HTTPException(400, problem)
    uid = _create_user(uname, body.password, "admin", body.displayName)
    db.set_meta("setup_token", None)
    token = create_session(request, uid, mfa=False)
    set_session_cookie(request, response, token)
    db.audit("setup_admin", user_id=uid, ip=ip)
    return {"ok": True}


def _invite(token: str, kind: str) -> dict | None:
    row = get_db().one("SELECT * FROM invites WHERE id=? AND kind=?", (token_digest(token), kind))
    if not row or row["used_at"] or row["expires_at"] < time.time():
        return None
    return row


@router.get("/invite/{token}")
def invite_info(token: str):
    row = _invite(token, "invite")
    if not row:
        raise HTTPException(404, "This invite link is invalid or has expired.")
    return {"role": row["role"], "expires": row["expires_at"], "note": row["note"]}


@router.post("/register")
def register(body: RegisterIn, request: Request, response: Response):
    ip = _ip(request)
    if not signup_limiter.hit(ip):
        raise HTTPException(429, "Too many attempts.")
    row = _invite(body.token, "invite")
    if not row:
        raise HTTPException(404, "This invite link is invalid or has expired.")
    uname = body.username.strip().lower()
    if not USERNAME_RE.match(uname):
        raise HTTPException(400, "Usernames are 2-32 letters, numbers, dots, dashes or underscores.")
    db = get_db()
    if db.one("SELECT 1 x FROM users WHERE username=?", (uname,)):
        raise HTTPException(409, "That username is taken.")
    problem = password_problem(body.password, uname)
    if problem:
        raise HTTPException(400, problem)
    uid = _create_user(uname, body.password, row["role"], body.displayName)
    db.execute("UPDATE invites SET used_by=?, used_at=? WHERE id=?", (uid, int(time.time()), row["id"]))
    token = create_session(request, uid, mfa=False)
    set_session_cookie(request, response, token)
    db.audit("register", user_id=uid, ip=ip, detail=f"invite by {row['created_by']}")
    return {"ok": True}


@router.get("/reset/{token}")
def reset_info(token: str):
    row = _invite(token, "reset")
    if not row:
        raise HTTPException(404, "This reset link is invalid or has expired.")
    user = get_db().one("SELECT username FROM users WHERE id=?", (row["target_user"],))
    return {"username": user["username"] if user else None}


@router.post("/reset")
def reset_password(body: ResetIn, request: Request, response: Response):
    ip = _ip(request)
    if not signup_limiter.hit(ip):
        raise HTTPException(429, "Too many attempts.")
    row = _invite(body.token, "reset")
    if not row:
        raise HTTPException(404, "This reset link is invalid or has expired.")
    db = get_db()
    user = db.one("SELECT * FROM users WHERE id=?", (row["target_user"],))
    if not user:
        raise HTTPException(404, "Account not found.")
    problem = password_problem(body.password, user["username"])
    if problem:
        raise HTTPException(400, problem)
    now = int(time.time())
    db.execute("UPDATE users SET pw_hash=?, pw_changed_at=? WHERE id=?", (hash_password(body.password), now, user["id"]))
    db.execute("UPDATE invites SET used_by=?, used_at=? WHERE id=?", (user["id"], now, row["id"]))
    db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
    db.audit("password_reset", user_id=user["id"], ip=ip)
    if user["totp_enabled"]:
        return {"ok": True, "signin": True}
    token = create_session(request, user["id"], mfa=False)
    set_session_cookie(request, response, token)
    return {"ok": True}


@router.get("/me")
def me(user: CurrentUser = Depends(require_user)):
    return user.public()


@router.patch("/me")
def update_me(body: MeIn, user: CurrentUser = Depends(require_user)):
    db = get_db()
    if body.displayName is not None:
        db.execute("UPDATE users SET display_name=? WHERE id=?", (body.displayName.strip()[:60], user.id))
    if body.prefs is not None:
        blob = json.dumps(body.prefs)
        if len(blob) > 8000:
            raise HTTPException(400, "Preferences too large.")
        db.execute("UPDATE users SET prefs=? WHERE id=?", (blob, user.id))
    return {"ok": True}


@router.post("/password")
def change_password(body: PasswordIn, request: Request, user: CurrentUser = Depends(require_user)):
    db = get_db()
    row = db.one("SELECT pw_hash FROM users WHERE id=?", (user.id,))
    if not row or not verify_password(body.current, row["pw_hash"]):
        raise HTTPException(400, "Your current password is wrong.")
    problem = password_problem(body.new, user.username)
    if problem:
        raise HTTPException(400, problem)
    db.execute("UPDATE users SET pw_hash=?, pw_changed_at=? WHERE id=?", (hash_password(body.new), int(time.time()), user.id))
    db.execute("DELETE FROM sessions WHERE user_id=? AND id<>?", (user.id, user.session_id))
    db.audit("password_changed", user_id=user.id, ip=_ip(request))
    return {"ok": True}


@router.get("/sessions")
def sessions(user: CurrentUser = Depends(require_user)):
    rows = get_db().all(
        "SELECT id, created_at, last_seen_at, ip, user_agent, mfa FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC",
        (user.id,),
    )
    return [
        {"id": r["id"][:16], "created": r["created_at"], "lastSeen": r["last_seen_at"], "ip": r["ip"],
         "agent": r["user_agent"], "mfa": bool(r["mfa"]), "current": r["id"] == user.session_id}
        for r in rows
    ]


@router.delete("/sessions/{sid}")
def revoke_session(sid: str, user: CurrentUser = Depends(require_user)):
    if not re.fullmatch(r"[0-9a-f]{16}", sid):
        raise HTTPException(400, "Bad id")
    get_db().execute("DELETE FROM sessions WHERE user_id=? AND substr(id,1,16)=?", (user.id, sid))
    return {"ok": True}


@router.post("/totp/setup")
def totp_setup(user: CurrentUser = Depends(require_user)):
    if user.totp_enabled:
        raise HTTPException(409, "Two-factor sign-in is already on.")
    secret = totp_new_secret()
    get_db().execute("UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?", (secret, user.id))
    return {"secret": secret, "uri": totp_uri(secret, user.username)}


@router.post("/totp/enable")
def totp_enable(body: CodeIn, request: Request, user: CurrentUser = Depends(require_user)):
    if not totp_limiter.hit(f"u{user.id}"):
        raise HTTPException(429, "Too many attempts.")
    db = get_db()
    row = db.one("SELECT totp_secret FROM users WHERE id=?", (user.id,))
    counter = totp_verify((row or {}).get("totp_secret") or "", body.code)
    if counter is None:
        raise HTTPException(400, "That code didn't match. Check your phone's clock.")
    db.execute("UPDATE users SET totp_enabled=1, totp_last=? WHERE id=?", (counter, user.id))
    db.execute("DELETE FROM sessions WHERE user_id=? AND id<>?", (user.id, user.session_id))
    db.audit("totp_enabled", user_id=user.id, ip=_ip(request))
    return {"ok": True}


@router.post("/totp/disable")
def totp_disable(body: CodeIn, request: Request, user: CurrentUser = Depends(require_user)):
    db = get_db()
    row = db.one("SELECT * FROM users WHERE id=?", (user.id,))
    if not row or not verify_password(body.password or "", row["pw_hash"]):
        raise HTTPException(400, "Your password is wrong.")
    if totp_verify(row["totp_secret"] or "", body.code, row["totp_last"] or 0) is None:
        raise HTTPException(400, "That code didn't match.")
    db.execute("UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?", (user.id,))
    db.audit("totp_disabled", user_id=user.id, ip=_ip(request))
    return {"ok": True}
