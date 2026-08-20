from app.services.questionnaires import missing_required_answers, visible_question_ids


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
