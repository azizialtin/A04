"""Freeze default video sequences for started runs, including empty runs."""

from alembic import op
import sqlalchemy as sa

revision = "a1d3f5b7c9e2"
down_revision = "f8b1c3d5e7a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "participants",
        sa.Column("video_sequence_pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute("""
        UPDATE participants SET video_sequence_pinned = true
        WHERE status <> 'registered' OR EXISTS (
            SELECT 1 FROM sessions s WHERE s.participant_id = participants.id
        )
    """)
    # Match the current fallback without changing any existing personal sequence.
    op.execute("""
        INSERT INTO participant_videos (participant_id, video_id, slot_index, phase_type)
        SELECT p.id, v.id,
               row_number() OVER (
                   PARTITION BY p.id ORDER BY
                       CASE v.phase_type WHEN 'pre_test' THEN 0
                                         WHEN 'training' THEN 1
                                         WHEN 'post_test' THEN 2 ELSE 9 END,
                       v.id
               ) - 1,
               v.phase_type
        FROM participants p JOIN videos v ON v.study_id = p.study_id
        WHERE p.video_sequence_pinned AND NOT EXISTS (
            SELECT 1 FROM participant_videos pv WHERE pv.participant_id = p.id
        )
    """)


def downgrade() -> None:
    if op.get_bind().scalar(sa.text("""
        SELECT EXISTS (
            SELECT 1 FROM participants p WHERE p.video_sequence_pinned AND NOT EXISTS (
                SELECT 1 FROM participant_videos pv WHERE pv.participant_id = p.id
            )
        )
    """)):
        raise RuntimeError("Cannot unpin empty runs; restore an earlier backup instead.")
    # Retain copied slots so a rollback does not reorder nonempty runs.
    op.drop_column("participants", "video_sequence_pinned")
