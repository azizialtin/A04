"""Questionnaire logic shared with the frontend: which questions are visible
given current answers, and which required ones are still unanswered.

A question is a dict with at least an `id` and `type`. Optional keys:
  - required: bool (default True)
  - show_if: {"question": <id>, "equals": <value>} — conditional visibility,
    resolved transitively (a hidden question hides everything gated on it).
"""

from __future__ import annotations

from typing import Any

Question = dict[str, Any]


def _matches(answer: Any, expected: Any) -> bool:
    if isinstance(answer, list):
        return expected in answer
    return answer == expected


def visible_question_ids(questions: list[Question], answers: dict[str, Any]) -> set[str]:
    by_id = {q["id"]: q for q in questions if "id" in q}
    visible = set(by_id)

    # Prune to a fixpoint: a gated question survives only while its trigger is
    # itself visible and answered as required. Removing one can cascade.
    changed = True
    while changed:
        changed = False
        for qid, q in by_id.items():
            cond = q.get("show_if")
            if not cond or qid not in visible:
                continue
            trigger = cond.get("question")
            ok = trigger in visible and _matches(answers.get(trigger), cond.get("equals"))
            if not ok:
                visible.discard(qid)
                changed = True
    return visible


def _answered(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, dict)):
        return len(value) > 0
    return True  # numbers, booleans


def missing_required_answers(questions: list[Question], answers: dict[str, Any]) -> list[str]:
    visible = visible_question_ids(questions, answers)
    missing = []
    for q in questions:
        qid = q.get("id")
        if not qid or qid not in visible or q.get("required", True) is False:
            continue
        if not _answered(answers.get(qid)):
            missing.append(qid)
    return missing
