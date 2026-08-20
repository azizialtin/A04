from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class GazeCalibration(Base):
    """One calibration attempt, with the validation that followed it.

    Kept per attempt rather than per participant: a repeat calibration is
    itself a fact about the session, and the accuracy figure is what decides
    whether a participant's gaze data can be used at all.
    """

    __tablename__ = "gaze_calibrations"

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("participants.id", ondelete="CASCADE"), index=True
    )
    # "success" | "failed" | "skipped" — skipped means the study ran without a
    # tracker, which the analysis has to be able to see.
    status: Mapped[str] = mapped_column(String(16))

    # Mean distance between target and measured gaze across the validation
    # points, as a fraction of screen width. Degrees needs the physical screen
    # size and the participant's distance, which the bridge only sometimes has.
    mean_offset: Mapped[float | None] = mapped_column(Float, nullable=True)
    mean_offset_degrees: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Per-point detail, so a bad corner can be told from a bad calibration.
    points: Mapped[list] = mapped_column(JSONB, default=list)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
