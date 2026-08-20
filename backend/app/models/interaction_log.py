from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class InteractionLog(Base):
    """Append-only behavioural log — logins, playback events, submissions, etc.
    `payload` carries whatever the event needs (video time, revision counts…)."""

    __tablename__ = "interaction_log"
    __table_args__ = (
        # How the gaze replay reads this table, and it is the one that grows
        # without limit. Leading with participant_id also serves the cascade.
        Index(
            "ix_interaction_log_participant_video",
            "participant_id",
            "video_id",
            "event_type",
            "created_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE")
    )
    event_type: Mapped[str] = mapped_column(String(64))
    video_id: Mapped[int | None] = mapped_column(
        ForeignKey("videos.id", ondelete="SET NULL"), nullable=True
    )
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)

    # Epoch ms as the *browser* saw it. The gaze replay lines these up against
    # sample timestamps from the Tobii bridge, and those two share a clock
    # (both on the lab machine) where created_at — written by the database,
    # after a background task — does not.
    client_ts: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
