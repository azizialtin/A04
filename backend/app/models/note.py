from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Note(Base):
    """A snapshot of the notes box taken at a given point in the clip. Storing
    the playhead position lets the think-aloud replay reveal notes in sync."""

    __tablename__ = "notes"
    __table_args__ = (
        # Every read of this table is "one participant's notes on one clip, in
        # video-time order" — the diagnosis recap and the think-aloud replay.
        Index("ix_notes_participant_video", "participant_id", "video_id", "video_time_seconds"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE")
    )
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)
    video_time_seconds: Mapped[float] = mapped_column(Float)
    # Browser wall clock, on the same machine as the bridge. The playhead alone
    # cannot place a note in a screen recording, which runs on wall time.
    client_ts: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
