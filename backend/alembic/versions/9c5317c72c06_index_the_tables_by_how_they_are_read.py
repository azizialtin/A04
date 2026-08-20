"""index the tables by how they are read

Each single-column index is replaced by a composite whose leading column is the
same, so the foreign-key cascades it was serving are still covered — Postgres
uses a leading-column prefix. The gaze replay and the notes recap were both
scanning where they now seek.

Revision ID: 9c5317c72c06
Revises: 1d93f3017f60
Create Date: 2026-08-16 14:05:53.991176

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '9c5317c72c06'
down_revision: Union[str, None] = '1d93f3017f60'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index('ix_gaze_recordings_participant_id', table_name='gaze_recordings')
    op.create_index('ix_gaze_recordings_participant_video', 'gaze_recordings', ['participant_id', 'video_id', 'started_at'], unique=False)
    op.drop_index('ix_interaction_log_event_type', table_name='interaction_log')
    op.drop_index('ix_interaction_log_participant_id', table_name='interaction_log')
    op.create_index('ix_interaction_log_participant_video', 'interaction_log', ['participant_id', 'video_id', 'event_type', 'created_at'], unique=False)
    op.drop_index('ix_notes_participant_id', table_name='notes')
    op.create_index('ix_notes_participant_video', 'notes', ['participant_id', 'video_id', 'video_time_seconds'], unique=False)
    op.drop_index('ix_text_entries_participant_id', table_name='text_entries')
    op.create_index('ix_text_entries_participant_video', 'text_entries', ['participant_id', 'video_id', 'kind'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_text_entries_participant_video', table_name='text_entries')
    op.create_index('ix_text_entries_participant_id', 'text_entries', ['participant_id'], unique=False)
    op.drop_index('ix_notes_participant_video', table_name='notes')
    op.create_index('ix_notes_participant_id', 'notes', ['participant_id'], unique=False)
    op.drop_index('ix_interaction_log_participant_video', table_name='interaction_log')
    op.create_index('ix_interaction_log_participant_id', 'interaction_log', ['participant_id'], unique=False)
    op.create_index('ix_interaction_log_event_type', 'interaction_log', ['event_type'], unique=False)
    op.drop_index('ix_gaze_recordings_participant_video', table_name='gaze_recordings')
    op.create_index('ix_gaze_recordings_participant_id', 'gaze_recordings', ['participant_id'], unique=False)
