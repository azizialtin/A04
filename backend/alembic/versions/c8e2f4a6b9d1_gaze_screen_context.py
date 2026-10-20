"""Record gaze on case and questionnaire screens without inventing old AOIs.

Revision ID: c8e2f4a6b9d1
Revises: b3d8f2a6c4e1
"""

from alembic import op
import sqlalchemy as sa

revision = "c8e2f4a6b9d1"
down_revision = "b3d8f2a6c4e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "gaze_recordings", "video_id", existing_type=sa.Integer(), nullable=True
    )
    op.add_column(
        "gaze_recordings",
        sa.Column(
            "step_kind", sa.String(32), nullable=False, server_default="case_video"
        ),
    )
    op.add_column(
        "gaze_recordings", sa.Column("step_index", sa.Integer(), nullable=True)
    )
    op.add_column(
        "gaze_recordings", sa.Column("questionnaire_id", sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        "fk_gaze_recordings_questionnaire_id",
        "gaze_recordings",
        "questionnaires",
        ["questionnaire_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_gaze_recordings_questionnaire_id", "gaze_recordings", ["questionnaire_id"]
    )


def downgrade() -> None:
    # A downgrade must not discard questionnaire gaze to restore a NOT NULL constraint.
    bind = op.get_bind()
    if bind.scalar(
        sa.text("SELECT count(*) FROM gaze_recordings WHERE video_id IS NULL")
    ):
        raise RuntimeError(
            "Cannot downgrade while questionnaire gaze recordings exist."
        )
    op.drop_index("ix_gaze_recordings_questionnaire_id", table_name="gaze_recordings")
    op.drop_constraint(
        "fk_gaze_recordings_questionnaire_id", "gaze_recordings", type_="foreignkey"
    )
    op.drop_column("gaze_recordings", "questionnaire_id")
    op.drop_column("gaze_recordings", "step_index")
    op.drop_column("gaze_recordings", "step_kind")
    op.alter_column(
        "gaze_recordings", "video_id", existing_type=sa.Integer(), nullable=False
    )
