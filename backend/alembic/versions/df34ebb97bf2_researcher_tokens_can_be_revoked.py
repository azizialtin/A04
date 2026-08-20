"""researcher tokens can be revoked

Revision ID: df34ebb97bf2
Revises: 3b1c9e6c9bc1
Create Date: 2026-08-16 13:36:48.140024

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'df34ebb97bf2'
down_revision: Union[str, None] = '3b1c9e6c9bc1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Existing accounts start at 0, matching tokens that carry no `ver` claim.
    op.add_column('researchers', sa.Column('token_version', sa.Integer(), server_default='0', nullable=False))


def downgrade() -> None:
    op.drop_column('researchers', 'token_version')
