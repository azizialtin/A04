"""A sliding-window limiter, in memory.

Sized for a single-instance research deployment: it is not shared between
processes and it resets on restart, which is fine for slowing down guesses at a
login form and is not a substitute for anything stronger. Keys are pruned as
they expire so a long-running process cannot accumulate one entry per address
that ever tried.
"""

from __future__ import annotations

import time
from collections import OrderedDict

from fastapi import HTTPException, status


class RateLimiter:
    def __init__(self, limit: int, window_seconds: int = 60, max_keys: int = 10_000) -> None:
        self.limit = limit
        self.window = window_seconds
        self.max_keys = max_keys
        self._hits: OrderedDict[str, list[float]] = OrderedDict()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window
        for key in [k for k, times in self._hits.items() if not times or times[-1] <= cutoff]:
            del self._hits[key]
        # Backstop against a flood of distinct addresses: drop the coldest.
        while len(self._hits) > self.max_keys:
            self._hits.popitem(last=False)

    def check(
        self, key: str, message: str = "Too many attempts. Wait a minute and try again."
    ) -> None:
        """Record an attempt, or raise 429 if this key has had too many."""
        now = time.monotonic()
        self._prune(now)

        times = self._hits.setdefault(key, [])
        times[:] = [t for t in times if t > now - self.window]
        if len(times) >= self.limit:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, message)

        times.append(now)
        self._hits.move_to_end(key)

    def reset(self) -> None:
        self._hits.clear()

    def __len__(self) -> int:
        return len(self._hits)
