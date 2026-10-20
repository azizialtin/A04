import pytest

from app.services.questionnaires import (
    missing_required_answers,
    valid_line_numbers,
    visible_question_ids,
)


def test_required_field_must_be_answered():
    qs = [{"id": "a", "type": "free_text", "text": "why?"}]
    assert missing_required_answers(qs, {}) == ["a"]
    assert missing_required_answers(qs, {"a": "because"}) == []


def test_blank_string_does_not_count():
    qs = [{"id": "a", "type": "free_text", "text": "why?"}]
    assert missing_required_answers(qs, {"a": "   "}) == ["a"]


def test_optional_field_is_never_missing():
    qs = [{"id": "a", "type": "free_text", "text": "why?", "required": False}]
    assert missing_required_answers(qs, {}) == []


def test_zero_is_a_valid_answer():
    qs = [{"id": "a", "type": "number", "text": "count"}]
    assert missing_required_answers(qs, {"a": 0}) == []


def test_show_if_gates_visibility_and_requirement():
    qs = [
        {"id": "a", "type": "likert", "text": "a"},
        {"id": "b", "type": "free_text", "text": "b", "show_if": {"question": "a", "equals": 3}},
    ]
    assert missing_required_answers(qs, {"a": 1}) == []  # b hidden
    assert missing_required_answers(qs, {"a": 3}) == ["b"]  # b now shown
    assert missing_required_answers(qs, {}) == ["a"]


def test_show_if_resolves_transitively():
    qs = [
        {"id": "a", "type": "likert", "text": "a"},
        {"id": "b", "type": "free_text", "text": "b", "show_if": {"question": "a", "equals": 1}},
        {
            "id": "c",
            "type": "free_text",
            "text": "c",
            "show_if": {"question": "b", "equals": "yes"},
        },
    ]
    hidden = visible_question_ids(qs, {"a": 2})
    assert "b" not in hidden and "c" not in hidden
    shown = visible_question_ids(qs, {"a": 1, "b": "yes"})
    assert shown == {"a", "b", "c"}


LINES = {"id": "lines", "type": "line_numbers", "text": "Which lines?", "min": 3, "max": 10}


def test_line_references_accept_arrays_and_legacy_scalar_answers():
    assert missing_required_answers([LINES], {"lines": [3, 5, 10]}) == []
    assert missing_required_answers([LINES], {"lines": 5}) == []
    assert valid_line_numbers(LINES, [3, 3, 4, 5, 6, 7, 8])


@pytest.mark.parametrize("value", [[], [None], [3, 0], [2], [11], [3.5], ["3"], [True], {}, ""])
def test_invalid_line_references_are_rejected(value):
    assert missing_required_answers([LINES], {"lines": value}) == ["lines"]


def test_optional_line_references_may_be_omitted_but_supplied_values_must_be_valid():
    optional = {**LINES, "required": False}
    assert missing_required_answers([optional], {}) == []
    assert missing_required_answers([optional], {"lines": []}) == []
    for value in ([0], {}, ""):
        assert missing_required_answers([optional], {"lines": value}) == ["lines"]


def test_hidden_lines_do_not_block_and_positive_whole_numbers_are_the_default():
    gated = {**LINES, "show_if": {"question": "other", "equals": 1}}
    assert missing_required_answers([gated], {"lines": [0]}) == []
    unbounded = {"id": "lines", "type": "line_numbers", "text": "Lines"}
    assert valid_line_numbers(unbounded, [1, 1000])
    assert not valid_line_numbers(unbounded, [-1, 0])
    assert not valid_line_numbers(unbounded, [float("inf")])
