"""consent is recorded outside the app

Consent is taken on paper / in the first SoSci survey, and that record is the
one that counts. The table and columns here were never written to, and a schema
that implies a control the application does not have is worse than no schema at
all. Verified empty before this was written.

Revision ID: 1d93f3017f60
Revises: df34ebb97bf2
Create Date: 2026-08-16 13:45:48.454670

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '1d93f3017f60'
down_revision: Union[str, None] = 'df34ebb97bf2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index('ix_consent_records_participant_id', table_name='consent_records')
    op.drop_table('consent_records')
    op.drop_column('participants', 'consented_at')
    op.drop_column('participants', 'consent_version')


def downgrade() -> None:
    op.add_column('participants', sa.Column('consent_version', sa.VARCHAR(length=64), autoincrement=False, nullable=True))
    op.add_column('participants', sa.Column('consented_at', postgresql.TIMESTAMP(timezone=True), autoincrement=False, nullable=True))
    op.create_table('consent_records',
    sa.Column('id', sa.INTEGER(), autoincrement=True, nullable=False),
    sa.Column('participant_id', sa.VARCHAR(length=64), autoincrement=False, nullable=False),
    sa.Column('consent_version', sa.VARCHAR(length=64), autoincrement=False, nullable=False),
    sa.Column('consented_at', postgresql.TIMESTAMP(timezone=True), server_default=sa.text('now()'), autoincrement=False, nullable=False),
    sa.Column('ip_address', sa.VARCHAR(length=64), autoincrement=False, nullable=True),
    sa.Column('user_agent', sa.VARCHAR(length=512), autoincrement=False, nullable=True),
    sa.ForeignKeyConstraint(['participant_id'], ['participants.id'], name='fk_consent_records_participant_id', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name='pk_consent_records')
    )
    op.create_index('ix_consent_records_participant_id', 'consent_records', ['participant_id'], unique=False)
