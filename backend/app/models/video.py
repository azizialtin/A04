from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, false, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.enums import PhaseType, pg_enum


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    phase_type: Mapped[PhaseType] = mapped_column(pg_enum(PhaseType), default=PhaseType.training)

    # Content for the right-hand rail of the case screen. With a `use_default_*`
    # flag set the video's own text is ignored and the study's default shows
    # instead, so most clips can share one wording that is edited in one place.
    task_description: Mapped[str] = mapped_column(Text, default="")
    info_text: Mapped[str] = mapped_column(Text, default="")
    student_task_text: Mapped[str] = mapped_column(Text, default="")
    use_default_task: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    use_default_info: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())

    time_limit_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gcp_filename: Mapped[str | None] = mapped_column(String(500), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
