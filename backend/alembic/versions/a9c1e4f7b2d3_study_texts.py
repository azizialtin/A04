"""Editable participant-facing wording per study

The welcome page's title, introduction, list of steps and the note under the
participant id can now be written by the researcher in the admin. Stored as one
JSON object keyed by field, so the next piece of wording that needs editing is a
key, not a migration. Empty means the app's built-in text.

Revision ID: a9c1e4f7b2d3
Revises: f2b8c4d1a6e7
Create Date: 2026-09-13
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "a9c1e4f7b2d3"
down_revision = "f2b8c4d1a6e7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "studies",
        sa.Column(
            "texts",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("studies", "texts")
