from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ScreenRecording(Base):
    """One case's screen capture, recorded by the bridge on the lab machine.

    Deliberately not a column on `gaze_recording`: the tracker can fail without
    costing us the capture, and a recording of what the participant actually did
    — the clip, the cursor, the notes box, every click — is worth having on its
    own. The think-aloud plays this back with the gaze dot on top.
    """

    __tablename__ = "screen_recordings"
    __table_args__ = (
        # The replay wants the newest stored capture of one clip by one participant.
        Index(
            "ix_screen_recordings_participant_video",
            "participant_id",
            "video_id",
            "started_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE")
    )
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)

    # recording -> stored, or recording -> failed. Anything left at "recording"
    # is a capture whose upload never arrived.
    status: Mapped[str] = mapped_column(String(16), default="recording")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    storage_mode: Mapped[str] = mapped_column(String(16), default="local")
    storage_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # "bridge": ffmpeg on the lab machine, the intended path. "browser": the
    # page captured its own display because no bridge could — the fallback,
    # whose clock anchor is the browser's and a frame or two less exact.
    recorder: Mapped[str] = mapped_column(String(16), default="bridge", server_default="bridge")

    # Wall-clock ms on the lab machine at video position 0. Gaze samples carry
    # that same clock, so a sample's position in this recording is just
    # `ts - epoch_ms` — no playback spans to reconstruct, and a sample taken
    # while the clip was paused is still a real thing the participant looked at.
    epoch_ms: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    byte_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
