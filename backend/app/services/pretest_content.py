"""Versioned pre-test content with its original CSV provenance."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from app.services.questionnaires import validate_question_definitions

SOURCE_KEY = "a04-pretest-2026-11-02"
LEGACY_SOURCE_KEY = "a04-pretest-2026-10-27"
_DATA_DIR = Path(__file__).parents[1] / "data"
MANIFEST_PATHS = {
    SOURCE_KEY: _DATA_DIR / "pretest_nov2026.json",
    LEGACY_SOURCE_KEY: _DATA_DIR / "pretest_oct2026.json",
}


class ContentImportError(ValueError):
    pass


def load_pretest_manifest(source_key: str = SOURCE_KEY) -> dict[str, Any]:
    if source_key not in MANIFEST_PATHS:
        raise ContentImportError(f"Unknown pre-test source: {source_key}.")
    return json.loads(MANIFEST_PATHS[source_key].read_text(encoding="utf-8"))


def mapped_ck_tasks(mapping: Any = None, *, source_key: str = SOURCE_KEY) -> list[dict]:
    manifest = load_pretest_manifest(source_key)
    tasks = manifest["ck_tasks"]
    if mapping is None:
        mapping = manifest["ck_id_mapping"]["rows"]
    expected = {str(task["source_row"]) for task in tasks}
    if not isinstance(mapping, dict) or set(mapping) != expected:
        raise ContentImportError(
            "Mapping must contain exactly these CSV row keys: "
            + ", ".join(sorted(expected, key=int))
        )
    values = list(mapping.values())
    if any(
        not isinstance(value, str) or not value.strip() or value != value.strip()
        for value in values
    ):
        raise ContentImportError("Every CSV row needs a nonempty variable ID without outer spaces.")
    if len(set(values)) != len(values):
        raise ContentImportError(
            "Mapped CK variable IDs must be unique; resolve the source duplicates first."
        )
    questions = []
    for task in tasks:
        question = deepcopy(task["question"])
        question["id"] = mapping[str(task["source_row"])]
        question["source_ref"] = {
            "instrument": source_key,
            "row": task["source_row"],
            "variable": task["source_variable"],
        }
        questions.append(question)
    errors = validate_question_definitions(questions)
    if errors:
        raise ContentImportError("; ".join(errors))
    return questions
