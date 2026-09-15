"""The CK self-assessment as a table, with debugging on its own page

The eight concept items used to be eight lists of the same seven statements.
They now carry a `matrix` key, which the participant screen renders as one
table with the statements listed once; the debugging item, whose statements
differ, moves to a page of its own right after. Studies seeded before this get
the same treatment here — a presentation key on the standard items and a new
page holding the debugging item — with no wording touched.

Everything this needs is frozen into the module below rather than imported
from `app.services.study_content`. A migration is a record of what was done at
one moment: importing live code would make a database migrated next year come
out differently from one migrated today, and renaming any of it would break
every Alembic command, on every database, forever.

WARNING — `downgrade()` folds back only the pages this migration created (it
knows them by the canned title below) and leaves anything a researcher wrote
themselves alone. Even so it is lossy: the debugging item returns at the end of
the concept page rather than wherever it sat, and a study that was seeded in
the split shape after this ran comes back as one page. Production rolls back by
restoring a backup, not by downgrading.

Revision ID: c3d5e7f9a1b2
Revises: a9c1e4f7b2d3
Create Date: 2026-09-13
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "c3d5e7f9a1b2"
down_revision = "a9c1e4f7b2d3"
branch_labels = None
depends_on = None


# --- frozen as of this revision ------------------------------------------

CK_MATRIX = "ck_concepts"
CK_DEBUG_MATRIX = "ck_debug"
CK_DEBUG_ID = "ck_pre_debug"
CK_PREFIX = "ck_pre_"
CK_CONCEPT_ANCHOR = "ck_pre_vars"
CK_DEBUG_TITLE = "Fachwissen Debugging"
CK_DEBUG_DESCRIPTION = (
    "Bitte wählen Sie die Aussage, die Ihre Erfahrung mit der Fehlersuche am besten beschreibt."
)


def _is_ck(question: dict) -> bool:
    return question.get("type") == "multiple_choice" and str(question.get("id", "")).startswith(
        CK_PREFIX
    )


def _without_matrix(questions: list[dict]) -> list[dict]:
    return [{k: v for k, v in q.items() if k != "matrix"} for q in questions]


def _split(questions: list[dict]) -> tuple[list[dict], list[dict]]:
    """The page's questions as (what stays, what moves to its own page)."""
    kept: list[dict] = []
    debugging: list[dict] = []
    for q in questions:
        if not _is_ck(q):
            kept.append(q)
        elif q.get("id") == CK_DEBUG_ID:
            debugging.append({**q, "matrix": CK_DEBUG_MATRIX})
        else:
            kept.append({**q, "matrix": CK_MATRIX})
    return kept, debugging


def plan(questions: list[dict]) -> tuple[str, list[dict], list[dict]]:
    """What to do with one pre-test page: ("skip" | "keep" | "split", …).

    Pure, and the whole decision — the orchestration below only carries it out,
    so the cases that matter can be tested without a database.

    "keep" is the page that is *already* the standalone debugging page, which a
    study seeded by today's code has and a researcher may have made by hand.
    Treating it as a split would empty it and create a second one alongside,
    throwing away whatever title they had chosen.
    """
    kept, debugging = _split(questions)
    if not kept and debugging:
        return ("skip" if debugging == questions else "keep", debugging, [])
    if kept == questions and not debugging:
        return ("skip", kept, [])
    return ("split", kept, debugging)


# --- carrying it out ------------------------------------------------------


def _pre_test_pages(bind):
    return (
        bind.execute(
            sa.text(
                "SELECT id, study_id, order_index, title, questions FROM questionnaires "
                "WHERE placement = 'pre_test' ORDER BY study_id, order_index, id"
            )
        )
        .mappings()
        .all()
    )


def _by_study(pages):
    grouped: dict[int, list] = {}
    for page in pages:
        grouped.setdefault(page["study_id"], []).append(page)
    return grouped


_SET_QUESTIONS = sa.text("UPDATE questionnaires SET questions = :q WHERE id = :id").bindparams(
    sa.bindparam("q", type_=JSONB)
)


def upgrade() -> None:
    bind = op.get_bind()
    make_room = sa.text(
        "UPDATE questionnaires SET order_index = order_index + 1 "
        "WHERE study_id = :study AND placement = 'pre_test' AND order_index > :after"
    )
    add_page = sa.text(
        "INSERT INTO questionnaires "
        "(study_id, placement, title, description, order_index, questions) "
        "VALUES (:study, 'pre_test', :title, :description, :order_index, :q)"
    ).bindparams(sa.bindparam("q", type_=JSONB))

    for study_id, pages in _by_study(_pre_test_pages(bind)).items():
        # Highest index first: inserting shifts everything after it, which would
        # leave an earlier page's snapshot pointing at the wrong slot.
        for page in sorted(pages, key=lambda p: (p["order_index"], p["id"]), reverse=True):
            action, kept, debugging = plan(page["questions"] or [])
            if action == "skip":
                continue
            bind.execute(_SET_QUESTIONS, {"q": kept, "id": page["id"]})
            if action == "split" and debugging:
                bind.execute(make_room, {"study": study_id, "after": page["order_index"]})
                bind.execute(
                    add_page,
                    {
                        "study": study_id,
                        "title": CK_DEBUG_TITLE,
                        "description": CK_DEBUG_DESCRIPTION,
                        "order_index": page["order_index"] + 1,
                        "q": debugging,
                    },
                )


def _is_debug_page(page) -> bool:
    """A page this migration made: our own title, and nothing but the item.

    The title is what keeps the downgrade honest. A researcher who split the
    page by hand and named it themselves gets left alone — folding that away
    would destroy wording this migration never wrote.
    """
    questions = page["questions"] or []
    return (
        page["title"] == CK_DEBUG_TITLE
        and bool(questions)
        and all(q.get("id") == CK_DEBUG_ID for q in questions)
    )


def _concept_page_before(ordered: list, page) -> dict | None:
    """The nearest page before this one that holds the concept ladder.

    Nearest rather than first: a study whose CK page was duplicated has two,
    and folding both debugging pages into the same one would put the item on
    one page twice and lose it from the other.
    """
    found = None
    for candidate in ordered:
        if candidate["id"] == page["id"]:
            break
        if any(q.get("id") == CK_CONCEPT_ANCHOR for q in candidate["questions"] or []):
            found = candidate
    return found


def downgrade() -> None:
    bind = op.get_bind()
    close_gap = sa.text(
        "UPDATE questionnaires SET order_index = order_index - 1 "
        "WHERE study_id = :study AND placement = 'pre_test' AND order_index > :removed"
    )
    drop_page = sa.text("DELETE FROM questionnaires WHERE id = :id")

    for study_id, pages in _by_study(_pre_test_pages(bind)).items():
        ordered = sorted(pages, key=lambda p: (p["order_index"], p["id"]))
        # Highest first again, so closing one gap cannot move a page this loop
        # has yet to reach.
        for page in reversed(ordered):
            if not _is_debug_page(page):
                continue
            concept = _concept_page_before(ordered, page)
            if concept is None:
                # Nothing to fold it into; leave it alone rather than delete a
                # page the researcher may have written themselves.
                continue
            merged = _without_matrix(concept["questions"] or []) + _without_matrix(
                page["questions"] or []
            )
            bind.execute(_SET_QUESTIONS, {"q": merged, "id": concept["id"]})
            bind.execute(drop_page, {"id": page["id"]})
            bind.execute(close_gap, {"study": study_id, "removed": page["order_index"]})

    # Whatever survived keeps its wording but loses the presentation key.
    for page in _pre_test_pages(bind):
        questions = page["questions"] or []
        stripped = _without_matrix(questions)
        if stripped != questions:
            bind.execute(_SET_QUESTIONS, {"q": stripped, "id": page["id"]})
