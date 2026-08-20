"""Pre-test pages, diagnosis ratings, and no questions inside a case

The run gains a block of question pages before the SoSci hand-off, the written
diagnosis gains its confidence rating, and the questions that used to sit
between the case intro and the clip are gone — the intro is text only now.

Responses can therefore have no case attached, which makes `video_id` nullable;
the old unique constraint would not have caught a duplicate pre-test page,
because Postgres counts every NULL as distinct, so it becomes two partial
indexes instead.

Revision ID: c4a91e27f8d5
Revises: b7f2a1c4d9e3
Create Date: 2026-08-16
"""

from alembic import op
import sqlalchemy as sa

revision = "c4a91e27f8d5"
down_revision = "b7f2a1c4d9e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The intro batteries have nowhere left to be shown, and a row that can
    # never be reached is worse than none. Their answers go with them.
    op.execute(
        "DELETE FROM questionnaire_responses WHERE questionnaire_id IN "
        "(SELECT id FROM questionnaires WHERE placement = 'case_intro')"
    )
    op.execute("DELETE FROM questionnaires WHERE placement = 'case_intro'")

    op.alter_column(
        "questionnaire_responses", "video_id", existing_type=sa.Integer(), nullable=True
    )
    op.drop_constraint("uq_qresponse_per_case", "questionnaire_responses", type_="unique")
    op.create_index(
        "uq_qresponse_per_case",
        "questionnaire_responses",
        ["questionnaire_id", "participant_id", "video_id"],
        unique=True,
        postgresql_where=sa.text("video_id IS NOT NULL"),
    )
    op.create_index(
        "uq_qresponse_pre_test",
        "questionnaire_responses",
        ["questionnaire_id", "participant_id"],
        unique=True,
        postgresql_where=sa.text("video_id IS NULL"),
    )

    # The diagnosis and outro batteries are rendered inside a screen of their
    # own; a second of either would have nowhere to go.
    op.create_index(
        "uq_questionnaire_single_placement",
        "questionnaires",
        ["study_id", "placement"],
        unique=True,
        postgresql_where=sa.text("placement IN ('diagnosis', 'case_outro')"),
    )


def downgrade() -> None:
    op.drop_index("uq_questionnaire_single_placement", table_name="questionnaires")
    op.drop_index("uq_qresponse_pre_test", table_name="questionnaire_responses")
    op.drop_index("uq_qresponse_per_case", table_name="questionnaire_responses")

    # Nothing downstream can hold a case-less response, or a placement the old
    # schema never had.
    op.execute(
        "DELETE FROM questionnaire_responses WHERE video_id IS NULL OR questionnaire_id IN "
        "(SELECT id FROM questionnaires WHERE placement IN ('pre_test', 'diagnosis'))"
    )
    op.execute("DELETE FROM questionnaires WHERE placement IN ('pre_test', 'diagnosis')")
    op.alter_column(
        "questionnaire_responses", "video_id", existing_type=sa.Integer(), nullable=False
    )
    op.create_unique_constraint(
        "uq_qresponse_per_case",
        "questionnaire_responses",
        ["questionnaire_id", "participant_id", "video_id"],
    )
