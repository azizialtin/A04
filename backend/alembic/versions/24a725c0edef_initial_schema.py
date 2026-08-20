"""initial schema

Revision ID: 24a725c0edef
Revises: 
Create Date: 2026-07-21 15:20:52.135356

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '24a725c0edef'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('audit_log',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('actor_email', sa.String(length=255), nullable=True),
    sa.Column('actor_type', sa.Enum('admin', 'participant', 'system', name='actortype', native_enum=False, length=32), nullable=False),
    sa.Column('action', sa.String(length=128), nullable=False),
    sa.Column('ip_address', sa.String(length=64), nullable=True),
    sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_audit_log'))
    )
    op.create_table('researchers',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_researchers'))
    )
    op.create_index(op.f('ix_researchers_email'), 'researchers', ['email'], unique=True)
    op.create_table('studies',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('sosci_pretest_url', sa.String(length=1000), nullable=False),
    sa.Column('sosci_posttest_url', sa.String(length=1000), nullable=False),
    sa.Column('sosci_id_param', sa.String(length=64), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('created_by', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['researchers.id'], name=op.f('fk_studies_created_by'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_studies'))
    )
    op.create_table('participants',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('study_id', sa.Integer(), nullable=False),
    sa.Column('status', sa.Enum('registered', 'active', 'completed', name='participantstatus', native_enum=False, length=32), nullable=False),
    sa.Column('consented_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('consent_version', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['study_id'], ['studies.id'], name=op.f('fk_participants_study_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_participants'))
    )
    op.create_index(op.f('ix_participants_study_id'), 'participants', ['study_id'], unique=False)
    op.create_table('questionnaires',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('study_id', sa.Integer(), nullable=False),
    sa.Column('placement', sa.Enum('case_intro', 'case_outro', name='questionnaireplacement', native_enum=False, length=32), nullable=False),
    sa.Column('title', sa.String(length=255), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('order_index', sa.Integer(), nullable=False),
    sa.Column('questions', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['study_id'], ['studies.id'], name=op.f('fk_questionnaires_study_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_questionnaires'))
    )
    op.create_index(op.f('ix_questionnaires_study_id'), 'questionnaires', ['study_id'], unique=False)
    op.create_table('videos',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('study_id', sa.Integer(), nullable=False),
    sa.Column('title', sa.String(length=255), nullable=False),
    sa.Column('phase_type', sa.Enum('pre_test', 'training', 'post_test', name='phasetype', native_enum=False, length=32), nullable=False),
    sa.Column('task_description', sa.Text(), nullable=False),
    sa.Column('info_text', sa.Text(), nullable=False),
    sa.Column('student_task_text', sa.Text(), nullable=False),
    sa.Column('time_limit_seconds', sa.Integer(), nullable=True),
    sa.Column('gcp_filename', sa.String(length=500), nullable=True),
    sa.Column('duration_seconds', sa.Float(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['study_id'], ['studies.id'], name=op.f('fk_videos_study_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_videos'))
    )
    op.create_index(op.f('ix_videos_study_id'), 'videos', ['study_id'], unique=False)
    op.create_table('consent_records',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('consent_version', sa.String(length=64), nullable=False),
    sa.Column('consented_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('ip_address', sa.String(length=64), nullable=True),
    sa.Column('user_agent', sa.String(length=512), nullable=True),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_consent_records_participant_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_consent_records'))
    )
    op.create_index(op.f('ix_consent_records_participant_id'), 'consent_records', ['participant_id'], unique=False)
    op.create_table('gaze_recordings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('video_id', sa.Integer(), nullable=False),
    sa.Column('sampling_rate_hz', sa.Integer(), nullable=False),
    sa.Column('sample_count', sa.Integer(), nullable=False),
    sa.Column('storage_mode', sa.String(length=16), nullable=False),
    sa.Column('storage_prefix', sa.String(length=500), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_gaze_recordings_participant_id'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['video_id'], ['videos.id'], name=op.f('fk_gaze_recordings_video_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_gaze_recordings'))
    )
    op.create_index(op.f('ix_gaze_recordings_participant_id'), 'gaze_recordings', ['participant_id'], unique=False)
    op.create_index(op.f('ix_gaze_recordings_video_id'), 'gaze_recordings', ['video_id'], unique=False)
    op.create_table('interaction_log',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('event_type', sa.String(length=64), nullable=False),
    sa.Column('video_id', sa.Integer(), nullable=True),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_interaction_log_participant_id'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['video_id'], ['videos.id'], name=op.f('fk_interaction_log_video_id'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_interaction_log'))
    )
    op.create_index(op.f('ix_interaction_log_event_type'), 'interaction_log', ['event_type'], unique=False)
    op.create_index(op.f('ix_interaction_log_participant_id'), 'interaction_log', ['participant_id'], unique=False)
    op.create_table('notes',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('video_id', sa.Integer(), nullable=False),
    sa.Column('video_time_seconds', sa.Float(), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_notes_participant_id'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['video_id'], ['videos.id'], name=op.f('fk_notes_video_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_notes'))
    )
    op.create_index(op.f('ix_notes_participant_id'), 'notes', ['participant_id'], unique=False)
    op.create_index(op.f('ix_notes_video_id'), 'notes', ['video_id'], unique=False)
    op.create_table('participant_videos',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('video_id', sa.Integer(), nullable=False),
    sa.Column('slot_index', sa.Integer(), nullable=False),
    sa.Column('phase_type', sa.Enum('pre_test', 'training', 'post_test', name='phasetype', native_enum=False, length=32), nullable=False),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_participant_videos_participant_id'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['video_id'], ['videos.id'], name=op.f('fk_participant_videos_video_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_participant_videos')),
    sa.UniqueConstraint('participant_id', 'slot_index', name='uq_participant_slot')
    )
    op.create_index(op.f('ix_participant_videos_participant_id'), 'participant_videos', ['participant_id'], unique=False)
    op.create_table('questionnaire_responses',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('questionnaire_id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('video_id', sa.Integer(), nullable=False),
    sa.Column('answers', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('time_spent_seconds', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_questionnaire_responses_participant_id'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['questionnaire_id'], ['questionnaires.id'], name=op.f('fk_questionnaire_responses_questionnaire_id'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['video_id'], ['videos.id'], name=op.f('fk_questionnaire_responses_video_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_questionnaire_responses')),
    sa.UniqueConstraint('questionnaire_id', 'participant_id', 'video_id', name='uq_qresponse_per_case')
    )
    op.create_index(op.f('ix_questionnaire_responses_participant_id'), 'questionnaire_responses', ['participant_id'], unique=False)
    op.create_index(op.f('ix_questionnaire_responses_questionnaire_id'), 'questionnaire_responses', ['questionnaire_id'], unique=False)
    op.create_index(op.f('ix_questionnaire_responses_video_id'), 'questionnaire_responses', ['video_id'], unique=False)
    op.create_table('sessions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('current_step_index', sa.Integer(), nullable=False),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_sessions_participant_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sessions'))
    )
    op.create_index(op.f('ix_sessions_participant_id'), 'sessions', ['participant_id'], unique=True)
    op.create_table('text_entries',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('participant_id', sa.String(length=64), nullable=False),
    sa.Column('video_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('time_spent_seconds', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name=op.f('fk_text_entries_participant_id'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['video_id'], ['videos.id'], name=op.f('fk_text_entries_video_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_text_entries'))
    )
    op.create_index(op.f('ix_text_entries_participant_id'), 'text_entries', ['participant_id'], unique=False)
    op.create_index(op.f('ix_text_entries_video_id'), 'text_entries', ['video_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_text_entries_video_id'), table_name='text_entries')
    op.drop_index(op.f('ix_text_entries_participant_id'), table_name='text_entries')
    op.drop_table('text_entries')
    op.drop_index(op.f('ix_sessions_participant_id'), table_name='sessions')
    op.drop_table('sessions')
    op.drop_index(op.f('ix_questionnaire_responses_video_id'), table_name='questionnaire_responses')
    op.drop_index(op.f('ix_questionnaire_responses_questionnaire_id'), table_name='questionnaire_responses')
    op.drop_index(op.f('ix_questionnaire_responses_participant_id'), table_name='questionnaire_responses')
    op.drop_table('questionnaire_responses')
    op.drop_index(op.f('ix_participant_videos_participant_id'), table_name='participant_videos')
    op.drop_table('participant_videos')
    op.drop_index(op.f('ix_notes_video_id'), table_name='notes')
    op.drop_index(op.f('ix_notes_participant_id'), table_name='notes')
    op.drop_table('notes')
    op.drop_index(op.f('ix_interaction_log_participant_id'), table_name='interaction_log')
    op.drop_index(op.f('ix_interaction_log_event_type'), table_name='interaction_log')
    op.drop_table('interaction_log')
    op.drop_index(op.f('ix_gaze_recordings_video_id'), table_name='gaze_recordings')
    op.drop_index(op.f('ix_gaze_recordings_participant_id'), table_name='gaze_recordings')
    op.drop_table('gaze_recordings')
    op.drop_index(op.f('ix_consent_records_participant_id'), table_name='consent_records')
    op.drop_table('consent_records')
    op.drop_index(op.f('ix_videos_study_id'), table_name='videos')
    op.drop_table('videos')
    op.drop_index(op.f('ix_questionnaires_study_id'), table_name='questionnaires')
    op.drop_table('questionnaires')
    op.drop_index(op.f('ix_participants_study_id'), table_name='participants')
    op.drop_table('participants')
    op.drop_table('studies')
    op.drop_index(op.f('ix_researchers_email'), table_name='researchers')
    op.drop_table('researchers')
    op.drop_table('audit_log')
