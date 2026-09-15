"""Video sets dealt at first login, and who recorded the screen

A study can now carry a small number of fixed video orders — two, in the design
— and a participant with no hand-picked sequence is dealt one of them the first
time they log in, balanced so the sets end up equal. The set is copied into
`participant_videos` at that moment; `participants.video_set_id` remembers
which one it was.

A screen recording also says which recorder made it. The bridge's ffmpeg capture
is the intended one; a page that captured its own display because no bridge was
running is the fallback, and an analysis should be able to tell them apart.

Revision ID: f2b8c4d1a6e7
Revises: c4a91e27f8d5
Create Date: 2026-09-13
"""

from alembic import op
import sqlalchemy as sa

revision = "f2b8c4d1a6e7"
down_revision = "c4a91e27f8d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "video_sets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "study_id", sa.Integer(), sa.ForeignKey("studies.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("study_id", "name", name="uq_video_set_name"),
    )
    op.create_index("ix_video_sets_study_id", "video_sets", ["study_id"])

    op.create_table(
        "video_set_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "video_set_id",
            sa.Integer(),
            sa.ForeignKey("video_sets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "video_id", sa.Integer(), sa.ForeignKey("videos.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("slot_index", sa.Integer(), nullable=False),
        sa.Column("phase_type", sa.String(length=32), nullable=False),
        sa.UniqueConstraint("video_set_id", "slot_index", name="uq_video_set_slot"),
    )
    op.create_index("ix_video_set_items_video_set_id", "video_set_items", ["video_set_id"])

    op.add_column(
        "participants",
        sa.Column(
            "video_set_id",
            sa.Integer(),
            sa.ForeignKey("video_sets.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_participants_video_set_id", "participants", ["video_set_id"])

    # Everything recorded so far came from the bridge.
    op.add_column(
        "screen_recordings",
        sa.Column("recorder", sa.String(length=16), nullable=False, server_default="bridge"),
    )


def downgrade() -> None:
    op.drop_column("screen_recordings", "recorder")
    op.drop_index("ix_participants_video_set_id", table_name="participants")
    op.drop_column("participants", "video_set_id")
    op.drop_index("ix_video_set_items_video_set_id", table_name="video_set_items")
    op.drop_table("video_set_items")
    op.drop_index("ix_video_sets_study_id", table_name="video_sets")
    op.drop_table("video_sets")
