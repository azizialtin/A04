"""Track the current questionnaire visit without trusting client clock order."""

from alembic import op
import sqlalchemy as sa

revision = "b2e4f6a8c0d3"
down_revision = "a1d3f5b7c9e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Historical visits have no authoritative entry order. Leave the marker
    # unknown until a new visit; never infer it from browser timestamps.
    op.add_column(
        "sessions",
        sa.Column("current_questionnaire_visit_id", sa.String(36), nullable=True),
    )
    op.create_foreign_key(
        "fk_sessions_current_questionnaire_visit",
        "sessions",
        "questionnaire_visits",
        ["current_questionnaire_visit_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_sessions_current_questionnaire_visit", "sessions", type_="foreignkey")
    op.drop_column("sessions", "current_questionnaire_visit_id")
