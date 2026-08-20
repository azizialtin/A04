"""The standard A04 batteries, as a study gets them on day one.

The wording is transcribed from `A04_DataCollection.xlsx` — the sheet names are
noted on each block, and the `id` of every question is the variable name from
that data dictionary, so an export column and a spreadsheet row are the same
thing. Seeding them is a convenience, not a lock-in: once they are rows the
researcher edits them in the admin like any other questionnaire.

German, like the rest of the study content (task texts, clips). The *interface*
around them is translated; the instrument is not.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire

Question = dict[str, Any]


def _yes_no(qid: str, text: str) -> Question:
    return {
        "id": qid,
        "type": "multiple_choice",
        "text": text,
        "options": [{"value": 1, "label": "ja"}, {"value": 0, "label": "nein"}],
    }


def _years(qid: str, text: str, trigger: str) -> Question:
    return {
        "id": qid,
        "type": "number",
        "text": text,
        "min": 0,
        "max": 50,
        "show_if": {"question": trigger, "equals": 1},
    }


# --- Demographics (sheet "Demographics") ---------------------------------
# participant_id and study_id are not asked: the run already knows both.

DEMOGRAPHICS: list[Question] = [
    {
        "id": "sex",
        "type": "multiple_choice",
        "text": "Geschlecht",
        "options": [
            {"value": 1, "label": "weiblich"},
            {"value": 2, "label": "männlich"},
            {"value": 3, "label": "divers"},
            {"value": 4, "label": "keine Angabe"},
        ],
    },
    {"id": "age", "type": "number", "text": "Alter (Jahre)", "min": 16, "max": 99},
    {
        "id": "participant_group",
        "type": "multiple_choice",
        "text": "Welche Rolle beschreibt Sie derzeit am besten?",
        "options": [
            {"value": 1, "label": "Lehramtsstudierende:r"},
            {"value": 2, "label": "Lehrkraft"},
            {"value": 3, "label": "Sonstiges"},
        ],
    },
    {"id": "st_degree", "type": "free_text", "text": "Höchster erreichter Abschluss"},
    _yes_no("st_enrollment", "Sind Sie derzeit an einer Hochschule eingeschrieben?"),
    {
        "id": "st_subject",
        "type": "free_text",
        "text": "Studiengang",
        "show_if": {"question": "st_enrollment", "equals": 1},
    },
    {
        "id": "st_semester",
        "type": "number",
        "text": "Fachsemester",
        "min": 1,
        "max": 30,
        "show_if": {"question": "st_enrollment", "equals": 1},
    },
    {
        "id": "st_schulform",
        "type": "multiple_choice",
        "text": "Für welche Schulform qualifizieren Sie sich bzw. an welcher unterrichten Sie?",
        "options": [
            {"value": 1, "label": "Grundschule"},
            {"value": 2, "label": "Mittelschule"},
            {"value": 3, "label": "Realschule"},
            {"value": 4, "label": "Gymnasium"},
            {"value": 5, "label": "Förderschule"},
            {"value": 6, "label": "Berufsschule"},
            {"value": 7, "label": "andere"},
        ],
    },
    {
        "id": "dupl1_st_schulform",
        "type": "free_text",
        "text": "Welche andere Schulform?",
        "show_if": {"question": "st_schulform", "equals": 7},
    },
    {"id": "st_fach1", "type": "free_text", "text": "Unterrichtsfach 1"},
    {"id": "st_fach2", "type": "free_text", "text": "Unterrichtsfach 2", "required": False},
    {"id": "st_fach3", "type": "free_text", "text": "Unterrichtsfach 3", "required": False},
    {
        "id": "st_schulpraktikum",
        "type": "number",
        "text": "Tage Schulpraktikum insgesamt",
        "min": 0,
        "max": 999,
    },
    {
        "id": "st_unterricht",
        "type": "number",
        "text": "Selbst gehaltene Unterrichtsstunden (geschätzt)",
        "min": 0,
        "max": 9999,
        "show_if": {"question": "participant_group", "equals": 1},
    },
    _yes_no("teach_inf_ex", "Haben Sie Erfahrung im Informatikunterricht (inkl. Referendariat)?"),
    _years("teach_inf_year", "Jahre Erfahrung im Informatikunterricht", "teach_inf_ex"),
    _yes_no("teach_prog_ex", "Haben Sie Erfahrung darin, Programmieren zu unterrichten?"),
    _years("teach_prog_year", "Jahre Erfahrung im Programmierunterricht", "teach_prog_ex"),
    _yes_no("java_ex", "Haben Sie Erfahrung mit Java?"),
    _years("java_years", "Jahre Erfahrung mit Java", "java_ex"),
    {
        "id": "teach_class",
        "type": "free_text",
        "text": "In welchen Jahrgangsstufen haben Sie unterrichtet?",
        "required": False,
    },
]


# --- CK pre-test (sheets "TODO Pre-Test Inside Tool", "1/2 CK Options") ---
# Self-assessment against the CEFR-style ladder: one statement per level, and
# the participant picks the highest one that still describes them.

_CK_LEVELS: list[tuple[str, str]] = [
    ("A0", "Dieses Konzept ist mir nicht bekannt."),
    ("A1", "Im Allgemeinen weiß ich, was dieses Konzept bedeutet."),
    (
        "A2",
        "Ich kann die Syntax erkennen, die die Programmiersprache verwendet, um dieses "
        "Konzept darzustellen.",
    ),
    (
        "B1",
        "Ich kann Code lesen und nachvollziehen, der dieses Konzept mit wenigen Elementen "
        "verwendet. Ich kann die Ausgabe korrekt vorhersagen, wenn konkrete Werte und "
        "aussagekräftige Namen verwendet werden.",
    ),
    (
        "B2",
        "Ich kann Code lesen und nachvollziehen, der dieses Konzept mit verschiedenen "
        "Elementen verwendet. Ich kann die Ausgabe korrekt vorhersagen, wenn konkrete Werte "
        "und aussagekräftige Namen verwendet werden.",
    ),
    (
        "C1",
        "Ich kann Muster meist erkennen, die dieses Konzept in verschiedenen Arten von Code "
        "verwenden, auch wenn die Benennung nicht immer klar ist. Ich verstehe den Zweck und "
        "das Verhalten des Codes, der dieses Konzept nutzt und eine Reihe unterschiedlicher "
        "Eingaben erhält.",
    ),
    (
        "C2",
        "Ich kann die Logik von Code, der dieses Konzept verwendet, leicht erkennen und "
        "erklären, auch wenn die Benennung unklar ist. Ich kann den Zweck und das Verhalten "
        "von Code, der dieses Konzept verwendet, bei verschiedenen Eingaben verallgemeinern "
        "und in einfachen Worten zusammenfassen.",
    ),
]

_CK_DEBUG_LEVELS: list[tuple[str, str]] = [
    (
        "A0",
        "Ich habe keine Erfahrung mit der Fehlersuche und weiß nicht, wie ich mit Fehlern im "
        "Code umgehen soll.",
    ),
    (
        "A1",
        "Im Allgemeinen weiß ich, dass Debugging bedeutet, Fehler in einem Programm zu finden "
        "und zu beheben.",
    ),
    (
        "A2",
        "Im Allgemeinen merke ich, wenn ein Programm nicht richtig funktioniert (z. B. "
        "Fehlverhalten oder falsche Ausgabe), aber ich weiß nicht, wie ich das beheben kann.",
    ),
    (
        "B1",
        "Ich kann sehr einfache Programme, die nur wenige Zeilen Code enthalten, debuggen. Ich "
        "kann den Programmablauf anhand konkreter Werte verfolgen und einfache Korrekturen "
        "ausprobieren, verlasse mich dabei jedoch auf trial-and-error.",
    ),
    (
        "B2",
        "Ich kann einfache Programme (z. B. mit nur wenigen Klassen, einfache Algorithmen) "
        "debuggen. Ich kann eine Hypothese aufstellen, den relevanten Code ausfindig machen "
        "und das Problem durch Tracing oder Tests eingrenzen.",
    ),
    (
        "C1",
        "Ich bin in der Lage, komplexe Programme (z. B. umfangreicher Quellcode, mehrere "
        "Klassen, verschiedene Entwurfsmuster) größtenteils zu debuggen, indem ich mehrere "
        "Hypothesen zur Ursache des Fehlers aufstelle. Ich kann den relevanten Codeabschnitt "
        "ausfindig machen, den Fehler beheben und die Korrektur überprüfen.",
    ),
    (
        "C2",
        "Ich kann komplexe Programme problemlos debuggen, indem ich mehrere Hypothesen zur "
        "Ursache des Fehlers aufstelle und diese erläutere. Ich kann den entsprechenden "
        "Codeabschnitt ausfindig machen, die Hypothesen gründlich prüfen, den Fehler beheben "
        "und die Korrektur verifizieren. Ich kann den Debugging-Prozess nachvollziehbar "
        "beschreiben.",
    ),
]


def _ck(qid: str, concept: str, levels: list[tuple[str, str]] = _CK_LEVELS) -> Question:
    return {
        "id": qid,
        "type": "multiple_choice",
        "text": concept,
        "options": [{"value": value, "label": label} for value, label in levels],
    }


CK_PRE_TEST: list[Question] = [
    _ck("ck_pre_vars", "Variablen und Zuweisung"),
    _ck("ck_pre_inout", "Benutzereingaben lesen und Ausgaben erzeugen"),
    _ck("ck_pre_arithm", "Arithmetische, relationale und logische Operatoren"),
    _ck("ck_pre_if", "Entscheidungen mit bedingten Anweisungen"),
    _ck("ck_pre_loop", "Schleifen und Iterationen"),
    _ck("ck_pre_datastructures", "Datenstrukturen wie Arrays und Listen"),
    _ck("ck_pre_methods", "Methoden und Funktionen"),
    _ck("ck_pre_obj", "Klassen und Objekte"),
    _ck("ck_pre_debug", "Debugging", _CK_DEBUG_LEVELS),
]


# --- Written diagnosis (sheet "Final Diagnosis on Written Diag") ----------
# The free text itself is the diagnosis screen's own field; this is what sits
# under it.

DIAGNOSIS_RATINGS: list[Question] = [
    {
        "id": "confidence",
        "type": "slider",
        "text": "Wie sicher sind Sie sich bei Ihrer Diagnose?",
        "min": 1,
        "max": 5,
        "labels": {"min": "unsicher", "max": "sicher"},
    },
]


# --- Case outro (sheet "Case Outro Screen Questions") ---------------------

_EFFORT_ANCHORS = {"min": "sehr, sehr wenig", "max": "sehr, sehr viel"}
_AGREEMENT_ANCHORS = {"min": "trifft überhaupt nicht zu", "max": "trifft voll und ganz zu"}

CASE_OUTRO: list[Question] = [
    {
        "id": "td_demand",
        "type": "slider",
        "text": (
            "Wie viel Anstrengung müssen Sie in die eben bearbeiteten Fälle investieren, "
            "um die bestmögliche Leistung zu erzielen?"
        ),
        "min": 0,
        "max": 9,
        "labels": _EFFORT_ANCHORS,
    },
    {
        "id": "td_effort",
        "type": "slider",
        "text": (
            "Im Vergleich dazu: Wie viel Anstrengung haben Sie in die eben bearbeiteten "
            "Fälle investiert?"
        ),
        "min": 0,
        "max": 9,
        "labels": _EFFORT_ANCHORS,
    },
    {
        "id": "auth1",
        "type": "likert",
        "text": "Ich empfand die Simulation als authentisch.",
        "scale_min": 1,
        "scale_max": 6,
        "labels": _AGREEMENT_ANCHORS,
    },
    {
        "id": "auth2",
        "type": "likert",
        "text": "Die Simulation hat wie eine echte berufliche Anforderungssituation gewirkt.",
        "scale_min": 1,
        "scale_max": 6,
        "labels": _AGREEMENT_ANCHORS,
    },
]


@dataclass(frozen=True)
class Battery:
    """One seeded questionnaire: what it is, where it goes, and its questions."""

    placement: QuestionnairePlacement
    order_index: int
    title: str
    description: str
    questions: list[Question]


# The pre-test pages come out in `order_index` order, one screen each. PCK is
# seeded empty on purpose: the items are still being written, and the step
# script skips a page with no questions, so an unfinished page is never shown to
# a participant.
DEFAULT_BATTERIES: list[Battery] = [
    Battery(
        QuestionnairePlacement.pre_test,
        0,
        "Angaben zur Person",
        "Bitte machen Sie einige Angaben zu sich und zu Ihrer Ausbildung.",
        DEMOGRAPHICS,
    ),
    Battery(
        QuestionnairePlacement.pre_test,
        1,
        "Fachdidaktisches Wissen",
        "Bitte beantworten Sie die folgenden Fragen.",
        [],
    ),
    Battery(
        QuestionnairePlacement.pre_test,
        2,
        "Fachwissen Programmierung",
        "Bitte wählen Sie zu jedem Konzept die Aussage, die am besten auf Sie zutrifft.",
        CK_PRE_TEST,
    ),
    Battery(
        QuestionnairePlacement.diagnosis,
        0,
        "Sicherheit der Diagnose",
        "",
        DIAGNOSIS_RATINGS,
    ),
    Battery(
        QuestionnairePlacement.case_outro,
        0,
        "Nach dem Fall",
        "Bitte beurteilen Sie die folgenden Aussagen.",
        CASE_OUTRO,
    ),
]


async def seed_batteries(db: AsyncSession, study_id: int) -> list[Questionnaire]:
    """Give a study the standard batteries it does not already have.

    Runs when a study is created and again on request, so a study made before
    this content existed can be brought up to date, and a battery that was
    deleted can be put back.

    A placement the study already uses is left alone entirely — including the
    pre-test block, which is seeded as a whole or not at all. Anything finer
    would either overwrite edited wording or, worse, add a second copy of a page
    the researcher had merely renamed or reordered, and the participant would
    answer it twice.
    """
    taken = set(
        (
            await db.execute(
                select(Questionnaire.placement).where(Questionnaire.study_id == study_id)
            )
        )
        .scalars()
        .all()
    )

    created = []
    for battery in DEFAULT_BATTERIES:
        if battery.placement in taken:
            continue
        q = Questionnaire(
            study_id=study_id,
            placement=battery.placement,
            title=battery.title,
            description=battery.description,
            order_index=battery.order_index,
            # A copy: two studies seeded in one process must not end up sharing
            # a question list that either of them can then edit.
            questions=deepcopy(battery.questions),
        )
        db.add(q)
        created.append(q)
    return created
