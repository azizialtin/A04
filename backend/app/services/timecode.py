"""Video positions as a person reads them off a player.

The raw seconds stay in the export — they are what an analysis computes with —
but a column of `9.499047` is unreadable next to a clip someone is watching, so
every video time is mirrored as a timecode.
"""

from __future__ import annotations

import math


def timecode(seconds: float | None) -> str:
    """`mm:ss`, or `h:mm:ss` past the hour. Empty when there is no time.

    Truncated rather than rounded, so it reads the same as the player's own
    clock: 9.9 s into the clip still shows 00:09.
    """
    if seconds is None or not math.isfinite(seconds):
        return ""
    total = max(0, int(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"
