from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class GazeRecording(Base):
    """Header row for one screen's Tobii samples. The samples themselves
    live in chunk files (local disk or GCS); `storage_prefix` locates them."""

    __tablename__ = "gaze_recordings"
    __table_args__ = (
        # The replay asks for the newest recording of one clip by one participant.
        Index(
            "ix_gaze_recordings_participant_video",
            "participant_id",
            "video_id",
            "started_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE")
    )
    video_id: Mapped[int | None] = mapped_column(
        ForeignKey("videos.id", ondelete="CASCADE"), index=True, nullable=True
    )
    step_kind: Mapped[str] = mapped_column(
        String(32), default="case_video", server_default="case_video"
    )
    step_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    questionnaire_id: Mapped[int | None] = mapped_column(
        ForeignKey("questionnaires.id", ondelete="SET NULL"), nullable=True, index=True
    )
    sampling_rate_hz: Mapped[int] = mapped_column(Integer, default=120)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    storage_mode: Mapped[str] = mapped_column(String(16), default="local")
    storage_prefix: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Where the clip sat on the screen while this was recorded — one timestamped
    # snapshot at the start and another after each resize. The tracker reports
    # gaze against the whole display, so without these the samples cannot be
    # placed on the video at all, now or later.
    geometry: Mapped[list] = mapped_column(JSONB, default=list)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
