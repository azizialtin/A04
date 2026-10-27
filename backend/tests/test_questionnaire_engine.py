import pytest

from app.services.questionnaires import (
    invalid_partial_answers,
    missing_required_answers,
    valid_line_numbers,
    validate_question_definitions,
    visible_question_ids,
)


def test_required_field_must_be_answered():
    qs = [{"id": "a", "type": "free_text", "text": "why?"}]
    assert missing_required_answers(qs, {}) == ["a"]
    assert missing_required_answers(qs, {"a": "because"}) == []


MULTI_SELECT = {
    "id": "multi",
    "type": "multi_select",
    "text": "Welche Maßnahmen?",
    "options": [{"value": 1, "label": "Zahl"}, {"value": "1", "label": "Text"}, "trace"],
}


def test_multi_select_requires_a_nonempty_typed_subset_but_optional_and_partial_can_be_empty():
    assert missing_required_answers([MULTI_SELECT], {}) == ["multi"]
    assert missing_required_answers([MULTI_SELECT], {"multi": []}) == ["multi"]
    assert missing_required_answers([MULTI_SELECT], {"multi": [1, "1"]}) == []
    optional = {**MULTI_SELECT, "required": False}
    assert missing_required_answers([optional], {}) == []
    assert missing_required_answers([optional], {"multi": []}) == []
    assert invalid_partial_answers([MULTI_SELECT], {}) == []
    assert invalid_partial_answers([MULTI_SELECT], {"multi": []}) == []
    assert invalid_partial_answers([MULTI_SELECT], {"multi": ["trace", 1]}) == []


@pytest.mark.parametrize(
    "value",
    [None, 1, "1", {}, [1, 1], ["unknown"], [True], [None], [[]], [float("nan")], [float("inf")]],
)
def test_multi_select_rejects_malformed_optional_and_partial_values(value):
    optional = {**MULTI_SELECT, "required": False}
    assert missing_required_answers([optional], {"multi": value}) == ["multi"]
    assert invalid_partial_answers([MULTI_SELECT], {"multi": value}) == ["multi"]


@pytest.mark.parametrize(
    "options", [None, [], ["a", "a"], [{"value": True, "label": "Boolean"}], [1]]
)
def test_multi_select_definitions_need_nonempty_unique_typed_options(options):
    assert validate_question_definitions([MULTI_SELECT]) == []
    assert validate_question_definitions([{**MULTI_SELECT, "options": options}])


def test_multi_select_selections_drive_conditional_visibility_without_coercing_strings():
    followup = {
        "id": "why",
        "type": "free_text",
        "text": "Warum?",
        "show_if": {"question": "multi", "equals": "1"},
    }
    assert missing_required_answers([MULTI_SELECT, followup], {"multi": [1]}) == []
    assert missing_required_answers([MULTI_SELECT, followup], {"multi": ["1"]}) == ["why"]


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


DEBUGGING = {"id": "ck", "type": "debugging", "text": "Fehler?", "min": 1, "max": 29}
RANKING = {
    "id": "order",
    "type": "ranking",
    "text": "Ordnen",
    "options": [
        {"value": "inspect", "label": "Prüfen"},
        {"value": "test", "label": "Testen"},
        {"value": 3, "label": "Korrigieren"},
    ],
}


def test_entry_count_is_independent_of_code_line_bounds():
    capped = {**LINES, "max_entries": 5}
    assert missing_required_answers([capped], {"lines": [3, 4, 5, 6, 10]}) == []
    assert missing_required_answers([capped], {"lines": [3, 4, 5, 6, 7, 8]}) == ["lines"]
    assert valid_line_numbers(LINES, [3, 4, 5, 6, 7, 8])


@pytest.mark.parametrize(
    "value",
    [
        {},
        {"lines": [6]},
        {"explanation": "Falscher Typ"},
        {"lines": 6, "explanation": "Falscher Typ"},
        {"lines": [1, 2, 3, 4, 5, 6], "explanation": "Fehler"},
        {"lines": [30], "explanation": "Fehler"},
        {"lines": [6], "explanation": "   "},
        {"lines": [6], "explanation": "Fehler", "unexpected": True},
    ],
)
def test_debugging_requires_both_components_and_defaults_to_five_locations(value):
    assert missing_required_answers([DEBUGGING], {"ck": value}) == ["ck"]
    assert (
        missing_required_answers([DEBUGGING], {"ck": {"lines": [6], "explanation": "Falscher Typ"}})
        == []
    )


@pytest.mark.parametrize(
    "value",
    [
        {},
        {"lines": [6, None]},
        {"explanation": "Unfertig"},
        {"lines": None, "explanation": None},
    ],
)
def test_partial_debugging_keeps_incomplete_components(value):
    assert invalid_partial_answers([DEBUGGING], {"ck": value}) == []


@pytest.mark.parametrize(
    "value",
    [
        {"lines": [0]},
        {"lines": ["6"]},
        {"lines": [None] * 6},
        {"explanation": 3},
    ],
)
def test_partial_debugging_rejects_malformed_components(value):
    assert invalid_partial_answers([DEBUGGING], {"ck": value}) == ["ck"]


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        ["test"],
        ["test", "test", 3],
        ["test", "inspect", "3"],
        ["test", "inspect", True],
    ],
)
def test_ranking_requires_an_exact_permutation(value):
    assert missing_required_answers([RANKING], {"order": value}) == ["order"]
    assert missing_required_answers([RANKING], {"order": [3, "test", "inspect"]}) == []


def test_definition_validation_preserves_extensions_and_rejects_duplicate_ids():
    question = {
        **DEBUGGING,
        "max_entries": 5,
        "code_blocks": [{"filename": "A.java", "code": ["", "class A {", "}"], "start_line": 1}],
        "research_extension": {"version": 1},
    }
    assert validate_question_definitions([question, RANKING, LINES]) == []
    assert "research_extension" in question
    assert validate_question_definitions([DEBUGGING, DEBUGGING]) == [
        "Frage 2: Die ID ck ist doppelt vergeben."
    ]


@pytest.mark.parametrize("value", [0, -1, 2.5, True, "5", None])
def test_invalid_entry_limit_definitions_are_rejected(value):
    assert validate_question_definitions([{**DEBUGGING, "max_entries": value}])


def test_invalid_code_options_and_type_definitions_are_rejected():
    assert validate_question_definitions([{**DEBUGGING, "code_blocks": [{"code": [1]}]}])
    assert validate_question_definitions([{**RANKING, "options": ["x", "x"]}])
    assert validate_question_definitions([{**DEBUGGING, "type": {}}])


@pytest.mark.parametrize(
    "condition",
    [
        "yes",
        [],
        {"question": "absent", "equals": True},
        {"question": "ck"},
        {"question": "", "equals": 1},
    ],
)
def test_invalid_condition_definitions_are_rejected(condition):
    assert validate_question_definitions([{**DEBUGGING, "show_if": condition}])


def test_valid_condition_can_reference_a_later_question_on_the_page():
    assert (
        validate_question_definitions(
            [
                {**DEBUGGING, "show_if": {"question": "trigger", "equals": 1}},
                {"id": "trigger", "type": "number", "text": "Trigger"},
            ]
        )
        == []
    )


@pytest.mark.parametrize(
    "bounds", [{"scale_min": 5, "scale_max": 1}, {"scale_min": 1.5}, {"scale_max": float("inf")}]
)
def test_likert_bounds_must_produce_an_answerable_integer_scale(bounds):
    assert validate_question_definitions(
        [{"id": "scale", "type": "likert", "text": "Scale", **bounds}]
    )


def test_extremely_large_json_numbers_return_errors_instead_of_overflowing():
    assert validate_question_definitions(
        [{"id": "n", "type": "number", "text": "N", "min": 10**1000}]
    )
    assert validate_question_definitions(
        [{**RANKING, "options": [{"value": 10**1000, "label": "Too large"}]}]
    )
