"""Questionnaire logic shared with the frontend: which questions are visible
given current answers, and which required ones are still unanswered.

A question is a dict with at least an `id` and `type`. Optional keys:
  - required: bool (default True)
  - show_if: {"question": <id>, "equals": <value>} — conditional visibility,
    resolved transitively (a hidden question hides everything gated on it).
"""

from __future__ import annotations

from sys import float_info
from typing import Any

Question = dict[str, Any]

QUESTION_TYPES = {
    "likert",
    "multiple_choice",
    "multi_select",
    "free_text",
    "slider",
    "number",
    "line_numbers",
    "debugging",
    "ranking",
}


def validate_question_definitions(questions: Any) -> list[str]:
    """Validate authored fields without dropping extension keys from existing instruments."""
    if not isinstance(questions, list):
        return ["Fragen müssen eine Liste sein."]
    errors = []
    ids = set()
    available_ids = {
        question["id"]
        for question in questions
        if isinstance(question, dict) and isinstance(question.get("id"), str)
    }
    for index, question in enumerate(questions):
        prefix = f"Frage {index + 1}"
        if not isinstance(question, dict):
            errors.append(f"{prefix}: Ein Objekt wird erwartet.")
            continue
        qid = question.get("id")
        if not isinstance(qid, str) or not qid.strip():
            errors.append(f"{prefix}: Eine ID fehlt.")
        elif qid in ids:
            errors.append(f"{prefix}: Die ID {qid} ist doppelt vergeben.")
        else:
            ids.add(qid)
        kind = question.get("type")
        if not isinstance(kind, str) or kind not in QUESTION_TYPES:
            errors.append(f"{prefix}: Unbekannter Fragetyp.")
            kind = ""
        if not isinstance(question.get("text"), str):
            errors.append(f"{prefix}: Fragetext fehlt.")
        if "required" in question and not isinstance(question["required"], bool):
            errors.append(f"{prefix}: required muss wahr oder falsch sein.")
        condition = question.get("show_if")
        if condition is not None and (
            not isinstance(condition, dict)
            or not isinstance(condition.get("question"), str)
            or not condition["question"].strip()
            or condition["question"] not in available_ids
            or "equals" not in condition
        ):
            errors.append(
                f"{prefix}: Bedingung braucht eine Frage dieser Seite und einen Vergleichswert."
            )
        for field in ("max_entries", "code_start_line"):
            if field in question and not _positive_integer(question[field]):
                errors.append(f"{prefix}: {field} muss eine positive ganze Zahl sein.")
        for field in ("min", "max", "scale_min", "scale_max"):
            if field in question:
                value = question[field]
                if not _finite_number(value) or (
                    kind in {"line_numbers", "debugging"} and not _positive_integer(value)
                ):
                    errors.append(f"{prefix}: {field} ist ungültig.")
        minimum, maximum = question.get("min"), question.get("max")
        if (
            isinstance(minimum, (int, float))
            and isinstance(maximum, (int, float))
            and minimum > maximum
        ):
            errors.append(f"{prefix}: min darf nicht größer als max sein.")
        if kind == "likert":
            lower, upper = question.get("scale_min", 1), question.get("scale_max", 5)
            if (
                not _finite_number(lower)
                or not _finite_number(upper)
                or lower % 1 != 0
                or upper % 1 != 0
                or lower > upper
            ):
                errors.append(f"{prefix}: Likert-Grenzen müssen aufsteigende ganze Zahlen sein.")
        if "code" in question and not _valid_code(question["code"]):
            errors.append(f"{prefix}: Code muss Text oder eine Liste von Textzeilen sein.")
        if "code_blocks" in question:
            blocks = question["code_blocks"]
            if not isinstance(blocks, list):
                errors.append(f"{prefix}: code_blocks muss eine Liste sein.")
            else:
                for block in blocks:
                    if (
                        not isinstance(block, dict)
                        or not _valid_code(block.get("code"))
                        or ("filename" in block and not isinstance(block["filename"], str))
                        or ("start_line" in block and not _positive_integer(block["start_line"]))
                    ):
                        errors.append(f"{prefix}: Ein Codeblock ist ungültig.")
        if kind in {"multiple_choice", "multi_select", "ranking"}:
            options = question.get("options")
            if not isinstance(options, list) or not options:
                errors.append(f"{prefix}: Antwortoptionen fehlen.")
            else:
                values = []
                valid = True
                for option in options:
                    if isinstance(option, str):
                        values.append(option)
                    elif (
                        isinstance(option, dict)
                        and isinstance(option.get("label"), str)
                        and _option_value(option.get("value"))
                    ):
                        values.append(option["value"])
                    else:
                        valid = False
                if not valid or len(set(values)) != len(values):
                    errors.append(f"{prefix}: Antwortoptionen brauchen eindeutige Werte und Text.")
    return errors


def _positive_integer(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and 1 <= value <= 9_007_199_254_740_991
        and value % 1 == 0
    )


def _valid_code(value: Any) -> bool:
    return isinstance(value, str) or (
        isinstance(value, list) and all(isinstance(line, str) for line in value)
    )


def _option_value(value: Any) -> bool:
    return isinstance(value, str) or _finite_number(value)


def _finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and -float_info.max <= value <= float_info.max
    )


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
        if not qid or qid not in visible:
            continue
        value = answers.get(qid)
        if q.get("type") == "multi_select":
            if qid not in answers:
                if q.get("required", True) is not False:
                    missing.append(qid)
            elif not valid_multi_select(q, value) or (
                q.get("required", True) is not False and not value
            ):
                missing.append(qid)
        elif q.get("type") == "line_numbers" and value is not None and value != []:
            if not valid_line_numbers(q, value):
                missing.append(qid)
        elif q.get("type") == "debugging" and value is not None:
            if not valid_debugging_answer(q, value):
                missing.append(qid)
        elif q.get("type") == "ranking" and value is not None:
            if not valid_ranking(q, value):
                missing.append(qid)
        elif not _answered(value) and q.get("required", True) is not False:
            missing.append(qid)
    return missing


def valid_line_numbers(question: Question, value: Any) -> bool:
    """One error may reference many lines; retain support for old scalar answers."""
    lines = value if isinstance(value, list) else [value]
    minimum = max(1, question.get("min", 1))
    maximum = question.get("max")
    max_entries = question.get("max_entries")
    if max_entries is None and question.get("type") == "debugging":
        max_entries = 5
    return (
        bool(lines)
        and (max_entries is None or len(lines) <= max_entries)
        and all(
            isinstance(line, (int, float))
            and not isinstance(line, bool)
            and line % 1 == 0
            and minimum <= line <= 9_007_199_254_740_991
            and (maximum is None or line <= maximum)
            for line in lines
        )
    )


def valid_debugging_answer(question: Question, value: Any, *, partial: bool = False) -> bool:
    if not isinstance(value, dict) or value.keys() - {"lines", "explanation"}:
        return False
    lines = value.get("lines")
    explanation = value.get("explanation")
    if not partial:
        return (
            isinstance(lines, list)
            and valid_line_numbers(question, lines)
            and isinstance(explanation, str)
            and bool(explanation.strip())
        )
    if explanation is not None and not isinstance(explanation, str):
        return False
    if lines is None:
        return True
    return isinstance(lines, list) and _valid_partial_lines(question, lines)


def valid_ranking(question: Question, value: Any) -> bool:
    options = [
        option.get("value") if isinstance(option, dict) else option
        for option in question.get("options", [])
    ]
    if not options or not isinstance(value, list) or len(value) != len(options):
        return False
    for values in (options, value):
        if any(
            not isinstance(item, (str, int, float)) or isinstance(item, bool) for item in values
        ):
            return False
        if any(isinstance(item, (int, float)) and not _finite_number(item) for item in values):
            return False
        if len(set(values)) != len(values):
            return False
    return set(options) == set(value)


def valid_multi_select(question: Question, value: Any) -> bool:
    """Checkbox selections are a unique subset, with number/string types preserved."""
    options = [
        option.get("value") if isinstance(option, dict) else option
        for option in question.get("options", [])
    ]
    if not options or not isinstance(value, list):
        return False
    for values in (options, value):
        if any(not _option_value(item) for item in values):
            return False
        if len(set(values)) != len(values):
            return False
    return set(value).issubset(set(options))


def _valid_partial_lines(question: Question, lines: list) -> bool:
    max_entries = question.get("max_entries")
    if max_entries is None and question.get("type") == "debugging":
        max_entries = 5
    if max_entries is not None and len(lines) > max_entries:
        return False
    filled = [line for line in lines if line is not None]
    return not filled or valid_line_numbers(question, filled)


def invalid_partial_answers(questions: list[Question], answers: dict[str, Any]) -> list[str]:
    """A supervisor exit retains incomplete input without accepting malformed values."""
    visible = visible_question_ids(questions, answers)
    invalid = []
    for question in questions:
        qid = question.get("id")
        if not qid or qid not in visible or qid not in answers:
            continue
        value = answers[qid]
        kind = question.get("type")
        if kind == "multi_select":
            if not valid_multi_select(question, value):
                invalid.append(qid)
        elif value is None:
            continue
        elif kind == "debugging" and not valid_debugging_answer(question, value, partial=True):
            invalid.append(qid)
        elif kind == "line_numbers":
            lines = value if isinstance(value, list) else [value]
            if not _valid_partial_lines(question, lines):
                invalid.append(qid)
        elif (kind == "ranking" and not valid_ranking(question, value)) or (
            kind == "free_text" and not isinstance(value, str)
        ):
            invalid.append(qid)
    return invalid
