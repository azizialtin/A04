import json
from pathlib import Path

import pytest

from app.services.questionnaires import invalid_partial_answers, missing_required_answers

CASES = json.loads(
    (
        Path(__file__).resolve().parents[2] / "frontend/testdata/questionnaire-scalar-cases.json"
    ).read_text()
)


@pytest.mark.parametrize("case", CASES)
def test_scalar_contract(case):
    questions = [case["question"]]
    answers = {"answer": case["value"]}
    assert missing_required_answers(questions, answers) == (["answer"] if case["missing"] else [])
    assert invalid_partial_answers(questions, answers) == (
        ["answer"] if case["partial_invalid"] else []
    )
    hidden = [{**case["question"], "show_if": {"question": "absent", "equals": 1}}]
    assert missing_required_answers(hidden, answers) == []
    assert invalid_partial_answers(hidden, answers) == []
    assert missing_required_answers(questions, {}) == (
        ["answer"] if case["question"]["required"] else []
    )
    assert invalid_partial_answers(questions, {}) == []


@pytest.mark.parametrize("kind", ["number", "slider", "likert", "multiple_choice"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf"), 10**400])
def test_nonfinite_answers_are_invalid(kind, value):
    question = {"id": "answer", "type": kind, "options": ["yes"]}
    assert missing_required_answers([question], {"answer": value}) == ["answer"]
    assert invalid_partial_answers([question], {"answer": value}) == ["answer"]
