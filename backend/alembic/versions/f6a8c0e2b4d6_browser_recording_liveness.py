"""Track browser recording liveness without changing stored captures."""

from alembic import op
import sqlalchemy as sa

revision = "f6a8c0e2b4d6"
down_revision = "d9f1a3b5c7e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("screen_recordings", sa.Column("last_seen_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.drop_column("screen_recordings", "last_seen_at")
