"""Discovers which model runs and forecast hours are published, using one
bucket listing per run, and keeps the result in memory and in SQLite."""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable

from .http import FetchError
from .models import REGISTRY, Model, parse_run, run_id

log = logging.getLogger("mammatus.runs")


@dataclass
class RunInfo:
    model: str
    run: str
    steps: list[int]
    complete: bool
    updated: float = field(default_factory=time.time)

    def client(self) -> dict:
        dt = parse_run(self.run)
        return {
            "run": self.run, "steps": self.steps, "complete": self.complete,
            "init": dt.strftime("%Y-%m-%dT%H:%M:%SZ"), "cycle": dt.hour,
        }


Listener = Callable[[str, RunInfo, list[int]], Awaitable[None]]


class RunsService:
    def __init__(self, db, models: tuple[str, ...]):
        self.db = db
        self.models = [REGISTRY[m] for m in models if m in REGISTRY]
        self._runs: dict[str, list[RunInfo]] = {m.id: [] for m in self.models}
        self._listeners: list[Listener] = []
        self._task: asyncio.Task | None = None
        self.last_poll: dict[str, float] = {}
        self.errors: dict[str, str] = {}
        self._load()

    def _load(self) -> None:
        rows = self.db.all("SELECT model, run, steps, complete, updated_at FROM runs ORDER BY run DESC")
        for r in rows:
            if r["model"] in self._runs:
                self._runs[r["model"]].append(
                    RunInfo(r["model"], r["run"], json.loads(r["steps"]), bool(r["complete"]), r["updated_at"])
                )

    def on_update(self, fn: Listener) -> None:
        self._listeners.append(fn)

    def runs(self, model: str) -> list[RunInfo]:
        return self._runs.get(model, [])

    def latest(self, model: str, min_steps: int = 1) -> RunInfo | None:
        for r in self._runs.get(model, []):
            if len(r.steps) >= min_steps:
                return r
        return None

    def steps(self, model: str, run: str) -> list[int]:
        for r in self._runs.get(model, []):
            if r.run == run:
                return r.steps
        return []

    def known(self, model: str, run: str) -> bool:
        return any(r.run == run for r in self._runs.get(model, []))

    def snapshot(self) -> dict:
        return {m: [r.client() for r in runs] for m, runs in self._runs.items()}

    async def refresh(self, model: Model) -> None:
        candidates = model.candidate_runs()
        existing = {r.run: r for r in self._runs.get(model.id, [])}
        found: dict[str, RunInfo] = {}
        for dt in candidates:
            rid = run_id(dt)
            prev = existing.get(rid)
            if prev and prev.complete:
                found[rid] = prev
                continue
            try:
                steps = await model.list_steps(dt)
            except FetchError as exc:
                self.errors[model.id] = str(exc)
                log.warning("run listing failed for %s %s: %s", model.id, rid, exc)
                if prev:
                    found[rid] = prev
                continue
            if not steps:
                continue
            expected = model.expected_steps(dt.hour)
            complete = set(expected).issubset(steps)
            info = RunInfo(model.id, rid, steps, complete)
            found[rid] = info
            new_steps = sorted(set(steps) - set(prev.steps if prev else []))
            if new_steps:
                self._persist(info)
                for fn in self._listeners:
                    try:
                        await fn(model.id, info, new_steps)
                    except Exception:  # listeners must not break discovery
                        log.exception("run listener failed")
        ordered = sorted(found.values(), key=lambda r: r.run, reverse=True)[: model.keep_runs]
        keep = {r.run for r in ordered}
        for rid in existing:
            if rid not in keep:
                self.db.execute("DELETE FROM runs WHERE model=? AND run=?", (model.id, rid))
        self._runs[model.id] = ordered
        self.last_poll[model.id] = time.time()
        self.errors.pop(model.id, None)

    def _persist(self, info: RunInfo) -> None:
        self.db.execute(
            "INSERT INTO runs(model, run, steps, complete, updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(model, run) DO UPDATE SET steps=excluded.steps, complete=excluded.complete, "
            "updated_at=excluded.updated_at",
            (info.model, info.run, json.dumps(info.steps), int(info.complete), int(info.updated)),
        )

    async def refresh_all(self) -> None:
        await asyncio.gather(*(self._safe_refresh(m) for m in self.models))

    async def _safe_refresh(self, model: Model) -> None:
        try:
            await self.refresh(model)
        except Exception as exc:
            self.errors[model.id] = str(exc)
            log.exception("refresh failed for %s", model.id)

    async def loop(self) -> None:
        intervals = {"cam": 150, "global": 300}
        await self.refresh_all()
        next_due = {m.id: time.time() + intervals[m.kind] for m in self.models}
        while True:
            await asyncio.sleep(15)
            now = time.time()
            due = [m for m in self.models if next_due[m.id] <= now]
            if due:
                await asyncio.gather(*(self._safe_refresh(m) for m in due))
                for m in due:
                    next_due[m.id] = now + intervals[m.kind] + random.uniform(0, 20)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self.loop(), name="runs-discovery")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
