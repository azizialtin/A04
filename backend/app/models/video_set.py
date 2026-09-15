from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.enums import PhaseType, pg_enum


class VideoSet(Base):
    """One of a study's fixed video orders — typically two, "A" and "B".

    A participant who has no hand-picked sequence is dealt one of these at their
    first login, balanced so the sets end up with equal numbers. The set's items
    are *copied* into `participant_videos` at that moment, so editing a set
    afterwards changes only the runs that have not started yet.
    """

    __tablename__ = "video_sets"
    __table_args__ = (UniqueConstraint("study_id", "name", name="uq_video_set_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class VideoSetItem(Base):
    """One slot of a set: the same shape as a participant's slot, minus the participant."""

    __tablename__ = "video_set_items"
    __table_args__ = (UniqueConstraint("video_set_id", "slot_index", name="uq_video_set_slot"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    video_set_id: Mapped[int] = mapped_column(
        ForeignKey("video_sets.id", ondelete="CASCADE"), index=True
    )
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="RESTRICT"))
    slot_index: Mapped[int] = mapped_column(Integer)
    phase_type: Mapped[PhaseType] = mapped_column(pg_enum(PhaseType))
