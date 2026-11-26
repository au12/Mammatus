"""SQLite storage: users, sessions, points, push subscriptions, rules, audit log.

A single connection in WAL mode guarded by a lock. Every query here is a
sub-millisecond local operation, so calling them from the event loop is fine
for a household-sized deployment.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 2

MIGRATIONS: dict[int, str] = {
    1: """
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT,
        pw_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        totp_secret TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        totp_last INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        prefs TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        pw_changed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT,
        mfa INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'invite',
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        target_user INTEGER,
        note TEXT,
        used_by INTEGER,
        used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS points (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        elev_m REAL,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS points_user ON points(user_id);
    CREATE TABLE IF NOT EXISTS push_subs (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_ok_at INTEGER,
        fail_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
        params TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        read INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);
    CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        user_id INTEGER,
        ip TEXT,
        event TEXT NOT NULL,
        detail TEXT
    );
    CREATE TABLE IF NOT EXISTS runs (
        model TEXT NOT NULL,
        run TEXT NOT NULL,
        steps TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (model, run)
    );
    """,
    2: """
    CREATE TABLE IF NOT EXISTS exports (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        model TEXT NOT NULL,
        product TEXT NOT NULL,
        region TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 1280,
        height INTEGER NOT NULL DEFAULT 800,
        fhr_mode TEXT NOT NULL DEFAULT 'next',
        enabled INTEGER NOT NULL DEFAULT 1,
        token TEXT NOT NULL,
        last_run TEXT,
        last_ok_at INTEGER,
        last_error TEXT
    );
    """,
}


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._migrate()

    def _migrate(self) -> None:
        with self._lock:
            self._conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            row = self._conn.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
            current = int(row["value"]) if row else 0
            for version in sorted(MIGRATIONS):
                if version > current:
                    self._conn.executescript("BEGIN;" + MIGRATIONS[version] + "COMMIT;")
                    self._conn.execute(
                        "INSERT INTO meta(key,value) VALUES('schema',?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (str(version),),
                    )

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def execute(self, sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def one(self, sql: str, params: tuple | dict = ()) -> dict | None:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, params: tuple | dict = ()) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def insert(self, sql: str, params: tuple | dict = ()) -> int:
        with self._lock:
            cur = self._conn.execute(sql, params)
            return int(cur.lastrowid)

    # -- key/value settings -------------------------------------------------
    def get_meta(self, key: str, default: Any = None) -> Any:
        row = self.one("SELECT value FROM meta WHERE key=?", (key,))
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return row["value"]

    def set_meta(self, key: str, value: Any) -> None:
        self.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )

    def audit(self, event: str, user_id: int | None = None, ip: str | None = None, detail: str | None = None):
        self.execute(
            "INSERT INTO audit(ts,user_id,ip,event,detail) VALUES(?,?,?,?,?)",
            (int(time.time()), user_id, ip, event, (detail or "")[:500]),
        )
        # keep the audit log bounded
        if int(time.time()) % 50 == 0:
            self.execute("DELETE FROM audit WHERE id < (SELECT MAX(id) - 5000 FROM audit)")

    def close(self) -> None:
        with self._lock:
            self._conn.close()


_db: Database | None = None


def get_db() -> Database:
    global _db
    if _db is None:
        from .config import settings

        _db = Database(settings.db_path)
    return _db


def set_db(db: Database | None) -> None:
    """Testing hook."""
    global _db
    _db = db
