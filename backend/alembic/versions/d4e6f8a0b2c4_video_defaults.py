"""Study-wide defaults for new videos

A study keeps a default timer and a default task and info text. The timer is
copied into a video as it is uploaded; the texts stay the study's, and a video
that opts in (`use_default_task`, `use_default_info`) shows them instead of its
own — so one wording can be edited in one place for every clip that shares it.

Revision ID: d4e6f8a0b2c4
Revises: c3d5e7f9a1b2
Create Date: 2026-09-13
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "d4e6f8a0b2c4"
down_revision = "c3d5e7f9a1b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "studies",
        sa.Column(
            "video_defaults",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    # Every existing clip carries its own text, as it always has.
    op.add_column(
        "videos",
        sa.Column("use_default_task", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "videos",
        sa.Column("use_default_info", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("videos", "use_default_info")
    op.drop_column("videos", "use_default_task")
    op.drop_column("studies", "video_defaults")
