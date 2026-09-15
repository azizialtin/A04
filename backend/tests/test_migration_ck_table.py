"""The CK-table data migration's decision, tested without a database.

`c3d5e7f9a1b2` rewrites researcher-authored question pages on the way up and
folds them back on the way down. The orchestration around it is SQL, but what
to do with a given page is a pure function — and it is the part where getting
it wrong destroys wording nobody can recover, so it is pinned here.

The migration deliberately carries its own frozen copy of the rules rather than
importing `app.services.study_content`; this test loads that copy by path, so
it keeps testing the migration even after the application's own content moves
on.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "c3d5e7f9a1b2_ck_ladder_as_a_table.py"
)
_spec = importlib.util.spec_from_file_location("ck_table_migration", _PATH)
assert _spec and _spec.loader
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)


def _concept(qid: str) -> dict:
    return {"id": qid, "type": "multiple_choice", "text": qid, "options": ["A0", "A1"]}


def _debug() -> dict:
    return {"id": "ck_pre_debug", "type": "multiple_choice", "text": "Debugging", "options": ["A0"]}


OLD_PAGE = [_concept("ck_pre_vars"), _concept("ck_pre_loop"), _debug()]


def test_an_old_page_splits_and_keeps_its_wording():
    action, kept, debugging = migration.plan(OLD_PAGE)

    assert action == "split"
    assert [q["id"] for q in kept] == ["ck_pre_vars", "ck_pre_loop"]
    assert all(q["matrix"] == "ck_concepts" for q in kept)
    assert [q["id"] for q in debugging] == ["ck_pre_debug"]
    assert debugging[0]["matrix"] == "ck_debug"
    # Nothing but the key is touched.
    assert all(q["text"] == o["text"] for q, o in zip(kept, OLD_PAGE, strict=False))


def test_a_page_that_is_already_split_is_keyed_in_place_not_emptied():
    """The bug this guards against: a study seeded by today's code already has
    a standalone debugging page. Treating it as a split would blank it and
    create a second one, losing whatever title the researcher gave it."""
    action, kept, debugging = migration.plan([_debug()])

    assert action == "keep"
    assert [q["id"] for q in kept] == ["ck_pre_debug"]
    assert kept[0]["matrix"] == "ck_debug"
    assert debugging == []


def test_a_page_already_carrying_the_keys_is_left_alone():
    done = [{**_concept("ck_pre_vars"), "matrix": "ck_concepts"}]
    assert migration.plan(done) == ("skip", done, [])
    assert migration.plan([{**_debug(), "matrix": "ck_debug"}])[0] == "skip"


@pytest.mark.parametrize(
    "questions",
    [
        pytest.param([], id="empty page"),
        pytest.param([{"id": "age", "type": "number", "text": "Alter"}], id="demographics"),
        pytest.param(
            [{"id": "ck_pre_vars", "type": "free_text", "text": "frei"}], id="not a choice item"
        ),
    ],
)
def test_pages_that_are_none_of_its_business_are_skipped(questions):
    assert migration.plan(questions) == ("skip", questions, [])


def test_a_researchers_own_question_survives_the_split():
    page = [{"id": "note", "type": "free_text", "text": "Anmerkung"}, *OLD_PAGE]
    action, kept, debugging = migration.plan(page)

    assert action == "split"
    assert kept[0] == {"id": "note", "type": "free_text", "text": "Anmerkung"}
    assert [q["id"] for q in debugging] == ["ck_pre_debug"]


def test_the_fold_back_pairs_a_page_with_its_nearest_concept_page():
    """A study whose CK page was duplicated has two of each; folding both into
    the first would put the debugging item on one page twice and lose it from
    the other."""
    pages = [
        {"id": 1, "order_index": 0, "questions": [_concept("ck_pre_vars")]},
        {"id": 2, "order_index": 1, "questions": [_debug()]},
        {"id": 3, "order_index": 2, "questions": [_concept("ck_pre_vars")]},
        {"id": 4, "order_index": 3, "questions": [_debug()]},
    ]

    assert migration._concept_page_before(pages, pages[1])["id"] == 1
    assert migration._concept_page_before(pages, pages[3])["id"] == 3
    # And a debugging page with nothing before it is left where it is.
    assert migration._concept_page_before(pages, pages[0]) is None


def _page(title: str, questions: list[dict]) -> dict:
    return {"title": title, "questions": questions}


def test_only_a_page_this_migration_made_is_folded_back():
    """The title is the guard. A researcher who split the page by hand and
    named it themselves must get it back untouched, not merged away."""
    canned = migration.CK_DEBUG_TITLE
    assert migration._is_debug_page(_page(canned, [_debug()]))
    assert not migration._is_debug_page(_page(canned, []))
    assert not migration._is_debug_page(_page(canned, OLD_PAGE))
    assert not migration._is_debug_page(_page(canned, [_concept("ck_pre_vars")]))
    # Their page, their wording — left alone.
    assert not migration._is_debug_page(_page("Mein eigener Titel", [_debug()]))
