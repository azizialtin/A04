"""Keep pre-test section timing and page visits without changing existing runs."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "d9f1a3b5c7e2"
down_revision = "c8e2f4a6b9d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for name, kind in (
        ("section_key", sa.String(64)),
        ("intro_title", sa.String(200)),
        ("intro_body", sa.Text()),
    ):
        op.add_column("questionnaires", sa.Column(name, kind, nullable=False, server_default=""))
    op.add_column(
        "questionnaire_responses",
        sa.Column("response_status", sa.String(16), nullable=False, server_default="submitted"),
    )
    op.create_table(
        "section_attempts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("participant_id", sa.String(64), sa.ForeignKey("participants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("section_key", sa.String(64), nullable=False),
        sa.Column("section", sa.String(255), nullable=False),
        sa.Column("started_client_ts", sa.BigInteger(), nullable=False),
        sa.Column("deadline_ms", sa.BigInteger(), nullable=False),
        sa.Column("ended_client_ts", sa.BigInteger()),
        sa.Column("finished_server_ms", sa.BigInteger()),
        sa.Column("exit_reason", sa.String(32)),
        sa.UniqueConstraint("participant_id", "section_key"),
    )
    op.create_index("ix_section_attempts_participant_id", "section_attempts", ["participant_id"])
    op.create_table(
        "questionnaire_visits",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("participant_id", sa.String(64), sa.ForeignKey("participants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("questionnaire_id", sa.Integer(), sa.ForeignKey("questionnaires.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("section_key", sa.String(64), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("entered_client_ts", sa.BigInteger(), nullable=False),
        sa.Column("exited_client_ts", sa.BigInteger()),
        sa.Column("exit_reason", sa.String(32)),
        sa.Column("is_review", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("submitted_answers", postgresql.JSONB()),
        sa.Column("finish_request_id", sa.String(36), unique=True),
    )
    op.create_index("ix_questionnaire_visits_participant_id", "questionnaire_visits", ["participant_id"])
    op.create_index("ix_questionnaire_visits_questionnaire_id", "questionnaire_visits", ["questionnaire_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if bind.scalar(sa.text("SELECT EXISTS (SELECT 1 FROM questionnaire_visits)")):
        raise RuntimeError("Cannot discard recorded pre-test visits; restore an earlier backup instead.")
    op.drop_table("questionnaire_visits")
    op.drop_table("section_attempts")
    op.drop_column("questionnaire_responses", "response_status")
    for name in ("intro_body", "intro_title", "section_key"):
        op.drop_column("questionnaires", name)
