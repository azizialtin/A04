"""Keep retry identities for participant notes and events."""

from alembic import op
import sqlalchemy as sa

revision = "c3f5a7b9d1e4"
down_revision = "b2e4f6a8c0d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Historical snapshots stay intact; only new writes claim a retry identity.
    op.add_column("notes", sa.Column("request_key", sa.String(80), nullable=True))
    op.create_index(
        "uq_notes_participant_request", "notes", ["participant_id", "request_key"], unique=True
    )
    op.add_column("interaction_log", sa.Column("request_id", sa.String(36), nullable=True))
    op.create_index(
        "uq_interaction_log_participant_request",
        "interaction_log",
        ["participant_id", "request_id"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_interaction_log_participant_request", table_name="interaction_log")
    op.drop_column("interaction_log", "request_id")
    op.drop_index("uq_notes_participant_request", table_name="notes")
    op.drop_column("notes", "request_key")
