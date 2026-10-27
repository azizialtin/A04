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
from app.services.pretest_content import load_pretest_manifest, mapped_ck_tasks

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


# Consecutive single-choice questions that carry the same `matrix` key and the
# same options are shown as one table — a row per concept, the statements
# listed once above it — instead of the seven statements repeated eight times.
CK_MATRIX = "ck_concepts"
CK_DEBUG_MATRIX = "ck_debug"


def _ck(
    qid: str,
    concept: str,
    levels: list[tuple[str, str]] = _CK_LEVELS,
    matrix: str = CK_MATRIX,
) -> Question:
    return {
        "id": qid,
        "type": "multiple_choice",
        "text": concept,
        "options": [{"value": value, "label": label} for value, label in levels],
        "matrix": matrix,
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
]

# Its own page: the debugging ladder is a different set of statements, and
# next to the concept table it read as an eighth row that did not fit.
CK_DEBUG_PRE_TEST: list[Question] = [
    _ck("ck_pre_debug", "Debugging", _CK_DEBUG_LEVELS, matrix=CK_DEBUG_MATRIX),
]

CK_DEBUG_TITLE = "Fachwissen Debugging"
CK_DEBUG_DESCRIPTION = (
    "Bitte wählen Sie die Aussage, die Ihre Erfahrung mit der Fehlersuche am besten beschreibt."
)


# --- MSK (file "MSK_items.docx", 2026-10-09) --------------------------------
# A situational judgement test: seven learning situations, each with five or
# six ways of handling it, every one rated on its own from 1 (very suitable)
# to 6 (very unsuitable). One page per situation, shown as a table with the
# scale listed once above it; the general instruction opens the first page.
# Wording is the instrument's own, typos included — it is not ours to edit.
# The data dictionary has no MSK sheet yet; the variable names follow its
# `ck_pre_…` pattern, `msk_pre_<task><letter>`, until the researchers say.

MSK_SECTION = "MSK"

MSK_SCALE: list[tuple[int, str]] = [
    (1, "sehr geeignete Handlungsmöglichkeit für diese Situation"),
    (2, "geeignete Handlungsmöglichkeit für diese Situation"),
    (3, "eher geeignete Handlungsmöglichkeit für diese Situation"),
    (4, "eher ungeeignete Handlungsmöglichkeit für diese Situation"),
    (5, "ungeeignete Handlungsmöglichkeit für diese Situation"),
    (6, "sehr ungeeignete Handlungsmöglichkeit für diese Situation"),
]

MSK_INSTRUCTION = "\n\n".join(
    [
        "Die folgenden Aufgaben beschreiben verschiedene Lernsituationen. Für jede Situation "
        "werden Ihnen mehrere Handlungsmöglichkeiten vorgestellt, die eine Person in dieser "
        "Situation anwenden könnte. Nachdem Sie die Beschreibung gelesen und sich mit dieser "
        "vertraut gemacht haben, bewerten Sie bitte jede dieser Handlungsmöglichkeiten für sich "
        "alleinstehend danach, wie gut sie für den Umgang mit dieser konkreten Situation "
        "geeignet ist.",
        "Bitte beachten Sie bei der Bewertung der Handlungsmöglichkeiten Folgendes:",
        # The instrument's bullet points; the screen draws a "- " line as one.
        "- Bewerten Sie jede Handlungsmöglichkeit danach, wie gut sie für das Erreichen des "
        "Ziels in dieser konkreten Situation geeignet ist, und nicht danach, wie Sie persönlich "
        "normalerweise in der alltäglichen Praxis handeln würden.\n"
        "- Jede Handlungsmöglichkeit steht für sich allein. Gehen Sie bei der Bewertung einer "
        "Handlungsmöglichkeit davon aus, dass diese in keinem Zusammenhang mit einer anderen "
        "aufgeführten Handlungsmöglichkeit steht, nicht mit ihr kombiniert wird und nicht von "
        "ihr abhängt.\n"
        "- Sie können dieselbe Bewertung innerhalb einer Aufgabe mehrmals vergeben. Es ist nicht "
        "erforderlich, jede Zahl (1–6) nur einmal zu verwenden. Wenn Sie der Meinung sind, dass "  # noqa: RUF001
        "mehrere Handlungsmöglichkeiten gleichermaßen geeignet sind, können Sie ihnen dieselbe "
        "Bewertung geben.",
        "Verwenden Sie für Ihre Bewertungen die folgende Skala:",
        "\n".join(f"- {value} = {label}" for value, label in MSK_SCALE),
    ]
)

MSK_QUESTION = "Wie beurteilen Sie die folgenden Vorgehensweisen?"

# (situation, the ways of handling it in the order the instrument lists them)
MSK_TASKS: list[tuple[str, list[str]]] = [
    (
        "Stellen Sie sich vor, Sie und Ihre Kommilitoninnen und Kommilitonen müssen einzeln an "
        "Programmieraufgaben arbeiten. Computer stehen dafür zur Verfügung. Die Lösung wird am "
        "Ende jeder Aufgabe angezeigt. Auch diese Lösung muss verstanden werden.",
        [
            "Die Aufgaben gemeinsam mit Kommilitoninnen und Kommilitonen betrachten.",
            "Die Aufgaben allein lösen und anschließend die Lösungen und Ergebnisse überprüfen.",
            "Während der Bearbeitung der Aufgaben wichtige Aspekte notieren, die später für die "
            "Prüfung wichtig sind.",
            "Die Musterlösungen und Ergebnisse vor der Bearbeitung der Aufgaben lesen.",
            "Kürzlich besprochene Programmierkonzepte anhand der eigenen Notizen wiederholen, um "
            "Zusammenhänge zu erkennen, und anschließend die Aufgaben selbstständig bearbeiten.",
        ],
    ),
    (
        "Stellen Sie sich vor, Sie erhalten die Möglichkeit, sich selbstständig mit einem neuen "
        "Thema zu beschäftigen und im Unterricht zu präsentieren. Dafür müssen sie selbstständig "
        "Informationen zum Thema recherchieren. Die Lehrkraft schlägt ihnen dafür verschiedene "
        "Websites vor.",
        [
            "Vor Beginn der Recherche überlegen, welche Informationen für die Präsentation "
            "benötigt werden.",
            "Die empfohlenen Websites überfliegen und sortieren, um einen Überblick zu erhalten.",
            "Alle Informationen gründlich lesen und sich die Begriffe sofort einprägen.",
            "Die gefundenen Informationen mit dem eigenen Vorwissen vergleichen.",
            "Gemeinsam mit Kommilitoninnen und Kommilitonen die schriftlichen Notizen aus anderen "
            "Schulfächern durchgehen.",
        ],
    ),
    (
        "Stellen Sie sich vor, in zwei Wochen steht eine schwierige Prüfung mit "
        "Programmieraufgabe an. Zur Vorbereitung erhalten Sie von der Lehrkraft einen Link, über "
        "den Sie online Programmieraufgaben aus alten Prüfungen bearbeiten können.",
        [
            "Alle Prüfungsaufgaben mehrmals durchlesen, ohne sie zu lösen.",
            "Nach den Lösungen der Aufgaben suchen und diese auswendig lernen.",
            "Die verschiedenen Aufgabentypen sortieren.",
            "Während der Bearbeitung der Prüfungsaufgaben immer wieder überprüfen, ob alles "
            "verstanden wurde.",
            "Sich mehr Zeit nehmen, wenn die Prüfungsaufgaben schwieriger werden.",
        ],
    ),
    (
        "Stellen Sie sich vor, Sie belegen einen E-Learning-Kurs, in dem die Inhalte eines "
        "Seminars in Informatik aufbereitet und mit Hyperlinks verknüpft sind. Sie müssen sich nun "
        "auf die anstehende Klausur vorbereiten und einige zentrale Konzepte lernen.",
        [
            "Der vorgegebenen Gliederung möglichst genau folgen.",
            "Sich die Lernziele zunächst bewusst machen – auch wenn dies etwas Zeit in Anspruch "  # noqa: RUF001
            "nimmt – und sich dann nur auf die zentralen Inhalte konzentrieren.",  # noqa: RUF001
            "Die wichtigsten Konzepte für jeden Abschnitt aufschreiben und prüfen, ob alles "
            "verstanden wurde.",
            "Zuerst alle Überschriften der Abschnitte durchlesen, bevor man die Lektion gründlich "
            "bearbeitet.",
            "Gleich dem Hyperlink zum Glossar folgen, wenn ein Begriff nicht verstanden wird.",
            "Möglichst alle Inhalte und Beispiele während der Bearbeitung der Lektion notieren.",
        ],
    ),
    (
        "Stellen Sie sich vor, Sie sollen eine Präsentation zu einem Thema halten. Dazu "
        "recherchieren Sie im Internet.",
        [
            "Die Aufgabe strukturieren und Teilziele formulieren.",
            "Nach Seiten suchen, die einen Überblick über das Thema geben.",
            "Allen empfohlenen Links folgen und sich umfassend informieren.",
            "Zusammengehörige Informationen gruppieren und sie in Beziehung setzen.",
            "Versuchen, sich an Informationen zu erinnern, denen Sie beim Durchklicken begegnet "
            "sind.",
            "Zuerst einen sehr genauen Überblick darüber verschaffen, wie die einzelnen Inhalte "
            "miteinander verknüpft sind.",
        ],
    ),
    (
        "Stellen Sie sich vor, Sie sollen eine Präsentation zu einer Modellierungsart "
        "vorbereiten. Ihr Kursleiter gibt Ihnen als Quelle eine Lernsoftware, welche nicht "
        "linear, sondern individuell durchgearbeitet werden kann.",
        [
            "Sich auf die Texte der Lernsoftware konzentrieren, die besonders gut verständlich "
            "sind.",
            "Die Texte, die Sie für besonders relevant halten, genau durchlesen und sich "
            "stichpunktartig die wichtigsten Aussagen aufschreiben.",
            "Die Gliederung nach bereits bekannten Inhalten absuchen und anschließend dort "
            "aufgeführte Texte lesen, um sich an das gesuchte Modell heranzuarbeiten.",
            "Die Texte ausdrucken und genau durchlesen.",
            "Sich einen Überblick über die Struktur der Lernsoftware verschaffen und die Texte "
            "aufarbeiten, welche Sie für relevant erachten.",
            "Sich einige markante Seiten, die mit vielen anderen Inhalten verknüpft sind, "
            "einprägen, um sich schnell orientieren zu können.",
        ],
    ),
    (
        "Stellen Sie sich vor, Sie sollen an einer Programmieraufgabe arbeiten und stoßen auf "
        "ein Problem. Sie entscheiden sich, im Internet, z. B. bei Stack Overflow oder GitHub, "
        "nach Lösungen zu suchen.",
        [
            "Nach relevanten Seiten suchen und diese nach ihrer Vertrauenswürdigkeit bewerten.",
            "Möglichst viele Informationen sammeln und diese überfliegen.",
            "Den Informationen folgen, die auf den Seiten besonders ins Auge fallen.",
            "Sich auf Inhalte konzentrieren, für die Sie sich besonders interessieren.",
            "Sich zunächst grob mit dem Thema vertraut machen und dann Details erarbeiten.",
            "Den Inhalt mit einigen Schlüsselwörtern beschreiben und gezielt nach diesen suchen.",
        ],
    ),
]


def msk_questions(number: int, options: list[str]) -> list[Question]:
    """One situation's ratings: a row per way of handling it, all sharing the
    scale, so the page shows one table. Variable names are `msk_pre_<task><letter>`,
    the letters as the instrument labels them."""
    return [
        {
            "id": f"msk_pre_{number}{'abcdef'[i]}",
            "type": "multiple_choice",
            "text": text,
            "options": [{"value": value, "label": label} for value, label in MSK_SCALE],
            "matrix": f"msk_pre_{number}",
        }
        for i, text in enumerate(options)
    ]


def msk_description(number: int, scenario: str) -> str:
    lead = f"{scenario}\n\n{MSK_QUESTION}"
    return f"{MSK_INSTRUCTION}\n\n{lead}" if number == 1 else lead


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
    # The instrument the page belongs to, as the researchers name it; the time
    # on a section's pages is added up under this. Empty: a section of its own.
    section: str = ""
    section_key: str = ""
    intro_title: str = ""
    intro_body: str = ""


# Source order is instrument order. The approved ID corrections do not sort
# or group the thirteen independent debugging exercises.
OCTOBER_PRETEST = load_pretest_manifest()
CK_TASKS = mapped_ck_tasks()
PCK_EXAMPLE = OCTOBER_PRETEST["pck_example"]

DEFAULT_BATTERIES: list[Battery] = [
    Battery(
        QuestionnairePlacement.pre_test,
        0,
        "Angaben zur Person",
        "Bitte machen Sie einige Angaben zu sich und zu Ihrer Ausbildung.",
        DEMOGRAPHICS,
        section="Demographics",
        section_key="demographics",
    ),
    Battery(
        QuestionnairePlacement.pre_test,
        1,
        "Fachwissen Programmierung",
        "Bitte wählen Sie zu jedem Konzept die Aussage, die am besten auf Sie zutrifft.",
        CK_PRE_TEST,
        section="CK-Pretest",
        section_key="ck_self",
    ),
    Battery(
        QuestionnairePlacement.pre_test,
        2,
        CK_DEBUG_TITLE,
        CK_DEBUG_DESCRIPTION,
        CK_DEBUG_PRE_TEST,
        section="CK-Pretest",
        section_key="ck_self",
    ),
    *(
        Battery(
            QuestionnairePlacement.pre_test,
            3 + index,
            f"CK: Aufgabe {index + 1}",
            "",
            [question],
            section="CK-Debugging",
            section_key="ck_tasks",
            intro_title=OCTOBER_PRETEST["ck_intro"]["title"] if index == 0 else "",
            intro_body=OCTOBER_PRETEST["ck_intro"]["body"] if index == 0 else "",
        )
        for index, question in enumerate(CK_TASKS)
    ),
    Battery(
        QuestionnairePlacement.pre_test,
        3 + len(CK_TASKS),
        PCK_EXAMPLE["title"],
        PCK_EXAMPLE["description"],
        PCK_EXAMPLE["questions"],
        section="PCK-Pretest",
        section_key="pck",
        intro_title=PCK_EXAMPLE["title"],
        intro_body="Bitte beantworten Sie die folgenden Fragen.",
    ),
    *(
        Battery(
            QuestionnairePlacement.pre_test,
            3 + len(CK_TASKS) + number,
            f"MSK: Aufgabe {number}",
            msk_description(number, scenario),
            msk_questions(number, options),
            section=MSK_SECTION,
            section_key="msk",
        )
        for number, (scenario, options) in enumerate(MSK_TASKS, start=1)
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
            section=battery.section,
            section_key=battery.section_key,
            intro_title=battery.intro_title,
            intro_body=battery.intro_body,
            order_index=battery.order_index,
            # A copy: two studies seeded in one process must not end up sharing
            # a question list that either of them can then edit.
            questions=deepcopy(battery.questions),
        )
        db.add(q)
        created.append(q)
    return created
