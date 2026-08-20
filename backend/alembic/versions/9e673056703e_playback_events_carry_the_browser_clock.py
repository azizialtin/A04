"""playback events carry the browser clock

Revision ID: 9e673056703e
Revises: 24a725c0edef
Create Date: 2026-08-16 12:39:11.977127

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '9e673056703e'
down_revision: Union[str, None] = '24a725c0edef'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: rows written before this exists fall back to created_at.
    op.add_column('interaction_log', sa.Column('client_ts', sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column('interaction_log', 'client_ts')
