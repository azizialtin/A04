"""gaze recordings carry their screen geometry

Revision ID: e995da929ca6
Revises: 9e673056703e
Create Date: 2026-08-16 12:44:39.534216

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'e995da929ca6'
down_revision: Union[str, None] = '9e673056703e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Recordings made before this have no geometry and can never get one; the
    # empty list is what the replay reads as "positions are not on the video".
    op.add_column(
        'gaze_recordings',
        sa.Column(
            'geometry',
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column('gaze_recordings', 'geometry')
