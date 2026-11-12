"""Keep audio capture health separate from successful screen delivery.

Revision ID: e6a2b8c4d0f1
Revises: d9f1a3b5c7e2
"""

from alembic import op
import sqlalchemy as sa

revision = "e6a2b8c4d0f1"
down_revision = "d9f1a3b5c7e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "screen_recordings",
        sa.Column("audio_status", sa.String(16), nullable=False, server_default="unknown"),
    )
    op.add_column(
        "screen_recordings", sa.Column("audio_error", sa.String(500), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("screen_recordings", "audio_error")
    op.drop_column("screen_recordings", "audio_status")
