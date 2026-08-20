"""record eye-tracker calibration

Revision ID: 3b1c9e6c9bc1
Revises: e995da929ca6
Create Date: 2026-08-16 12:51:55.027012

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '3b1c9e6c9bc1'
down_revision: Union[str, None] = 'e995da929ca6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('gaze_calibrations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('mean_offset', sa.Float(), nullable=True),
    sa.Column('mean_offset_degrees', sa.Float(), nullable=True),
    sa.Column('points', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_gaze_calibrations_participant_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_gaze_calibrations'))
    )
    op.create_index(op.f('ix_gaze_calibrations_participant_id'), 'gaze_calibrations', ['participant_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_gaze_calibrations_participant_id'), table_name='gaze_calibrations')
    op.drop_table('gaze_calibrations')
