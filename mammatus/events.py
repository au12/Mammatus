"""Server-sent events hub: run updates for everyone, notifications per user."""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict


class EventHub:
    def __init__(self):
        self._subs: dict[int, set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, user_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._subs[user_id].add(q)
        return q

    def unsubscribe(self, user_id: int, q: asyncio.Queue) -> None:
        self._subs[user_id].discard(q)
        if not self._subs[user_id]:
            self._subs.pop(user_id, None)

    def _put(self, q: asyncio.Queue, msg: str) -> None:
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass

    def publish(self, event: str, data: dict, user_id: int | None = None) -> None:
        msg = f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
        targets = [self._subs.get(user_id, set())] if user_id is not None else list(self._subs.values())
        for subs in targets:
            for q in list(subs):
                self._put(q, msg)

    @property
    def listeners(self) -> int:
        return sum(len(s) for s in self._subs.values())
