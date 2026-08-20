from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.enums import PhaseType, pg_enum


class ParticipantVideo(Base):
    """One row per slot in a participant's run: the ordered, hand-picked sequence
    of nine videos. That ordering is the entire personalisation."""

    __tablename__ = "participant_videos"
    __table_args__ = (UniqueConstraint("participant_id", "slot_index", name="uq_participant_slot"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE"), index=True
    )
    video_id: Mapped[int] = mapped_column(ForeignKey("videos.id", ondelete="RESTRICT"))
    slot_index: Mapped[int] = mapped_column(Integer)
    phase_type: Mapped[PhaseType] = mapped_column(pg_enum(PhaseType))
