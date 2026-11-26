"""HTTP-level checks of the auth flow and the security guard (no network: background polling is off)."""
import pytest
from fastapi.testclient import TestClient

from mammatus.app import create_app
from mammatus.db import get_db

H = {"X-Mammatus": "1", "Origin": "http://testserver"}


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


def test_health_and_headers(client):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json()["ok"]
    assert r.headers["x-frame-options"] == "DENY"
    assert "script-src 'self'" in r.headers["content-security-policy"]


def test_csrf_guard(client):
    assert client.post("/api/auth/login", json={"username": "x", "password": "y"}).status_code == 403
    r = client.post("/api/auth/login", json={"username": "x", "password": "y"}, headers={**H, "Origin": "https://evil.example"})
    assert r.status_code == 403


def test_setup_login_and_invite(client):
    st = client.get("/api/auth/state").json()
    assert st["setup"] is True and st["user"] is None
    code = get_db().get_meta("setup_token")
    assert client.post("/api/auth/setup", json={"code": "nope", "username": "adam", "password": "a fine long passphrase"}, headers=H).status_code in (400, 403)
    r = client.post("/api/auth/setup", json={"code": code, "username": "adam", "password": "a fine long passphrase"}, headers=H)
    assert r.status_code == 200, r.text
    me = client.get("/api/auth/me").json()
    assert me["username"] == "adam" and me["role"] == "admin"
    inv = client.post("/api/admin/invites", json={"note": "brother", "days": 2}, headers=H).json()
    token = inv["url"].split("#invite=")[1]
    client.post("/api/auth/logout", headers=H)
    assert client.get("/api/auth/me").status_code == 401
    weak = client.post("/api/auth/register", json={"token": token, "username": "bro", "password": "password1"}, headers=H)
    assert weak.status_code == 400
    ok = client.post("/api/auth/register", json={"token": token, "username": "bro", "password": "another long passphrase"}, headers=H)
    assert ok.status_code == 200, ok.text
    assert client.get("/api/auth/me").json()["role"] == "user"
    client.post("/api/auth/logout", headers=H)
    again = client.post("/api/auth/register", json={"token": token, "username": "bro2", "password": "another long passphrase"}, headers=H)
    assert again.status_code in (400, 404, 410)


def test_requires_login(client):
    client.post("/api/auth/logout", headers=H)
    assert client.get("/api/catalog").status_code == 401
    assert client.get("/api/points").status_code == 401
