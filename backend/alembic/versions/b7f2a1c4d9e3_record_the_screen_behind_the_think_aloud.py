"""record the screen behind the think-aloud

Revision ID: b7f2a1c4d9e3
Revises: 9c5317c72c06
Create Date: 2026-08-16 15:02:11.884210

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'b7f2a1c4d9e3'
down_revision: Union[str, None] = '9c5317c72c06'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'screen_recordings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('participant_id', sa.String(length=64), nullable=False),
        sa.Column('video_id', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='recording'),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('storage_mode', sa.String(length=16), nullable=False, server_default='local'),
        sa.Column('storage_path', sa.String(length=500), nullable=True),
        # Wall-clock ms at video position 0, on the clock the gaze samples use.
        sa.Column('epoch_ms', sa.BigInteger(), nullable=True),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('fps', sa.Float(), nullable=True),
        sa.Column('byte_size', sa.BigInteger(), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['video_id'], ['videos.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_screen_recordings_participant_video',
        'screen_recordings',
        ['participant_id', 'video_id', 'started_at'],
    )
    op.create_index('ix_screen_recordings_video_id', 'screen_recordings', ['video_id'])

    # Notes taken before this have only a playhead position, which is enough for
    # the clip-based replay and the diagnosis recap but not for placing them in a
    # screen recording. Those recordings do not exist yet either, so nothing is
    # losing anything.
    op.add_column('notes', sa.Column('client_ts', sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column('notes', 'client_ts')
    op.drop_index('ix_screen_recordings_video_id', table_name='screen_recordings')
    op.drop_index('ix_screen_recordings_participant_video', table_name='screen_recordings')
    op.drop_table('screen_recordings')
