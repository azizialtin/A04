import hashlib
from copy import deepcopy

import pytest
from sqlalchemy import func, select

from app.models.enums import QuestionnairePlacement
from app.models.questionnaire import Questionnaire, QuestionnaireResponse
from app.models.session import Session
from app.services.pretest_content import (
    FIRST_PILOT_SOURCE_KEY,
    LEGACY_SOURCE_KEY,
    MANIFEST_PATHS,
    PILOT_SOURCE_KEY,
    SOURCE_KEY,
    load_pretest_manifest,
    mapped_ck_tasks,
)
from app.services.questionnaires import (
    invalid_partial_answers,
    missing_required_answers,
    validate_question_definitions,
)
from app.services.study_content import (
    CASE_OUTRO,
    DEFAULT_BATTERIES,
    PILOT_BATTERIES,
    PILOT_CASE_OUTRO,
    refresh_unstarted_case_outro,
    seed_batteries,
)
from app.services.study_content_import import ContentImportError, import_ck_pretest


def test_pilot_ck_uses_the_approved_order_without_changing_historical_instruments():
    pilot = load_pretest_manifest(PILOT_SOURCE_KEY)
    previous = load_pretest_manifest(SOURCE_KEY)
    mapping = [1, 6, 4, 13, 2, 5, 7, 8, 9, 10, 11, 12, 3]
    assert [row["previous_variable"] for row in pilot["ck_version_crosswalk"]["rows"]] == [
        f"ck_pre_{number:02}" for number in mapping
    ]
    for number, old_number in enumerate(mapping, 1):
        question = pilot["ck_tasks"][number - 1]["question"]
        old = previous["ck_tasks"][old_number - 1]["question"]
        assert question["id"] == f"ck_pre_{number:02}"
        assert question["allow_skip"] is True
        if number not in {2, 3, 4}:
            assert question["text"].replace("\n", " ") == old["text"]
            assert question["code_blocks"] == old["code_blocks"]
    ck2, ck3, ck4 = [task["question"] for task in pilot["ck_tasks"][1:4]]
    assert "weiteresBuchAusleihbar" in "\n".join(ck2["code_blocks"][0]["code"])
    assert ck3["code_blocks"][0]["code"][1] == "public class Rechner {"
    assert "for (int i = 1; i < werte.length; i++)" in "\n".join(ck3["code_blocks"][0]["code"])
    assert "for (int i = 0; i < stärken.length - 1; i++)" in "\n".join(
        ck4["code_blocks"][0]["code"]
    )
    assert (
        "ausgelieheneBücher < maximaleBücherzahl" in pilot["ck_tasks"][1]["solution"]["explanation"]
    )
    assert "noch nicht erreicht" in pilot["ck_tasks"][1]["solution"]["explanation"]
    assert all(
        "solution" not in question for question in mapped_ck_tasks(source_key=PILOT_SOURCE_KEY)
    )
    for source in (LEGACY_SOURCE_KEY, SOURCE_KEY):
        historical = load_pretest_manifest(source)
        assert all("allow_skip" not in task["question"] for task in historical["ck_tasks"])
        assert "pck_example" in historical
        assert "mesp_pages" not in historical
    assert len([battery for battery in DEFAULT_BATTERIES if battery.section_key == "msk"]) == 7


@pytest.mark.parametrize("battery", PILOT_BATTERIES, ids=lambda battery: battery.title)
def test_pilot_questions_are_valid_and_have_unique_variables(battery):
    assert validate_question_definitions(battery.questions) == []
    ids = [question["id"] for question in battery.questions]
    assert len(ids) == len(set(ids))


PCK_VARIABLES = [
    "pck_pre_1a",
    "pck_pre_1b",
    "pck_pre_1c",
    "pck_pre_3a",
    "pck_pre_3b",
    "pck_pre_3c",
    "pck_pre_5a",
    "pck_pre_5b",
    "pck_pre_5c",
    "pck_pre_5d",
]
PLAUSIBLE = [
    "Sehr plausibel",
    "Plausibel",
    "Eher plausibel",
    "Eher nicht plausibel",
    "Nicht plausibel",
    "Gar nicht plausibel",
]
SUITABLE = [
    "Sehr geeignet",
    "Geeignet",
    "Eher geeignet",
    "Eher nicht geeignet",
    "Nicht geeignet",
    "Gar nicht geeignet",
]


def _pck_questions(source_key=PILOT_SOURCE_KEY):
    pages = load_pretest_manifest(source_key)["pck_pages"]
    return {question["id"]: question for page in pages for question in page["questions"]}


def _code(description):
    return description.split("```java\n", 1)[1].split("\n```", 1)[0].split("\n")


def test_ck_questions_break_the_line_after_their_common_sentence():
    lead = "Debugging-Aufgabe – In welcher Zeile befindet sich der Fehler? Was ist der Fehler?"  # noqa: RUF001
    first = load_pretest_manifest(FIRST_PILOT_SOURCE_KEY)["ck_tasks"]
    tasks = load_pretest_manifest(PILOT_SOURCE_KEY)["ck_tasks"]
    assert len(tasks) == 13
    for task, earlier in zip(tasks, first, strict=True):
        text = task["question"]["text"]
        own = text.removeprefix(lead + "\n")
        assert own != text and "\n" not in own and own == own.strip() and own
        # Only the break is new: same wording, code, IDs and solutions as the first pilot.
        assert text.replace("\n", " ") == earlier["question"]["text"]
        assert {**task["question"], "text": ""} == {**earlier["question"], "text": ""}
        assert task["solution"] == earlier["solution"]
        assert task["source_row"] == earlier["source_row"]


def test_pck_has_a_page_per_item_group_under_its_task_heading():
    pages = load_pretest_manifest(PILOT_SOURCE_KEY)["pck_pages"]
    assert [(page["source_task"], page["title"]) for page in pages] == [
        *[(1, "Fachdidaktisches Wissen - Aufgabe 1")] * 3,
        *[(3, "Fachdidaktisches Wissen - Aufgabe 2")] * 3,
        *[(5, "Fachdidaktisches Wissen - Aufgabe 3")] * 4,
    ]
    assert [
        sorted({question["source_ref"]["variable"] for question in page["questions"]})
        for page in pages
    ] == [[variable] for variable in PCK_VARIABLES]
    assert [[question["id"] for question in page["questions"]] for page in pages] == [
        ["pck_pre_1a"],
        ["pck_pre_1b_1", "pck_pre_1b_2", "pck_pre_1b_3"],
        [f"pck_pre_1c_{item}" for item in range(1, 7)],
        ["pck_pre_3a_1", "pck_pre_3a_2", "pck_pre_3a_3"],
        ["pck_pre_3b", "pck_pre_3b_justification"],
        [f"pck_pre_3c_{item}" for item in range(1, 5)],
        ["pck_pre_5a"],
        ["pck_pre_5b_1", "pck_pre_5b_2", "pck_pre_5b_3"],
        ["pck_pre_5c"],
        [f"pck_pre_5d_{item}" for item in range(1, 6)],
    ]
    # The situation and its code are the task's, repeated above each of its pages.
    for task in (1, 3, 5):
        assert len({page["description"] for page in pages if page["source_task"] == task}) == 1
    for page in pages:
        letters = [question["source_ref"]["variable"][-1] for question in page["questions"]]
        prompt = page["questions"][0].get("matrix_prompt") or page["questions"][0]["text"]
        assert prompt.startswith(f"{letters[0]}) ")
        assert all(
            question["source_ref"]["instrument"] == PILOT_SOURCE_KEY
            for question in page["questions"]
        )
    for battery in PILOT_BATTERIES:
        assert all("layout_column" not in question for question in battery.questions)


def test_pck_shows_the_situations_and_code_as_the_worksheet_has_them():
    pages = load_pretest_manifest(PILOT_SOURCE_KEY)["pck_pages"]
    first, second, third = (
        next(page["description"] for page in pages if page["source_task"] == task)
        for task in (1, 3, 5)
    )
    assert first.startswith(
        "Ein Schüler soll die Summe aller Werte eines Arrays berechnen. Sein Programm gibt 15 "
        "statt der erwarteten 18 aus. Die Lehrkraft hat bereits gemerkt, dass der Schüler die "
        "Schleife falsch initialisiert hat und deshalb das erste Element des Arrays übersprungen "
        "wird. Im Gespräch mit dem Schüler möchte sie herausfinden, weshalb der Schüler seinen "
        "Fehler nicht bemerkt.\n\n```java\n"
    )
    assert _code(first) == [
        "public class Rechner",
        "{",
        "public void sum(){",
        "",
        "int[] werte = {3, 5, 2, 8};",
        "int summe = 0;",
        "",
        "for (int i = 1; i < werte.länge; i++) {",
        "    summe = summe + werte[i];",
        "}",
        'System.out.println("Summe: " + summe);',
        "}",
        "}",
    ]
    assert first.endswith(
        "\n```\n\nDer Schüler sagt: „Die Schleife funktioniert. Sie geht alle Werte durch und "
        "addiert sie. Ich verstehe nicht, warum das Ergebnis falsch ist.“"
    )
    assert _code(second) == [
        "public class Bibliothekskonto {",
        "",
        "    private int maximaleBücherzahl = 5;",
        "",
        "    public boolean weiteresBuchAusleihbar(int ausgelieheneBücher) {",
        "",
        "        if (ausgelieheneBücher <= maximaleBücherzahl) {",
        "",
        "            return true;",
        "",
        "        } else {",
        "",
        "            return false;",
        "",
        "        }",
        "    }",
        "}",
    ]
    assert "Die Variable currentlyBorrowed enthält" in second.split("```")[0]
    assert second.endswith(
        "Die Schülerin erklärt: „Wenn man fünf Bücher ausgeliehen hat, ist das Limit noch nicht "
        "überschritten. Deshalb muss die Methode true zurückgeben.“"
    )
    for description in (first, second):
        code = "\n".join(_code(description))
        assert code.count("{") == code.count("}") and description.count("```") == 2
    assert "```" not in third
    assert third == next(
        page["description"]
        for page in load_pretest_manifest(FIRST_PILOT_SOURCE_KEY)["pck_pages"]
        if page["source_task"] == 5
    )


def test_pck_ratings_have_six_labelled_points_under_the_worksheet_prompts():
    questions = _pck_questions()
    ratings = {
        "pck_pre_1b": (PLAUSIBLE, 3, "Aussage", "plausibel"),
        "pck_pre_1c": (SUITABLE, 6, "Maßnahme", "geeignet"),
        "pck_pre_3a": (PLAUSIBLE, 3, "Aussage", "plausibel"),
        "pck_pre_3c": (SUITABLE, 4, "Maßnahme", "geeignet"),
        "pck_pre_5b": (PLAUSIBLE, 3, "Aussage", "plausibel"),
        "pck_pre_5d": (SUITABLE, 5, "Maßnahme", "geeignet"),
    }
    for variable, (labels, count, noun, quality) in ratings.items():
        rows = [question for question in questions.values() if question.get("matrix") == variable]
        assert [row["id"] for row in rows] == [f"{variable}_{item}" for item in range(1, count + 1)]
        assert [row["source_ref"]["item"] for row in rows] == list(range(1, count + 1))
        for row in rows:
            assert row["type"] == "multiple_choice"
            assert [option["value"] for option in row["options"]] == [1, 2, 3, 4, 5, 6]
            assert [option["label"] for option in row["options"]] == labels
        assert ["matrix_prompt" in row for row in rows] == [True] + [False] * (count - 1)
        assert rows[0]["matrix_prompt"].endswith(
            f"Bewerten Sie jede {noun} auf einer sechsstufigen Skala "
            f"(1 = sehr {quality}, 6 = überhaupt nicht {quality})."
        )
        answers = {row["id"]: 6 for row in rows}
        assert missing_required_answers(rows, answers) == []
        assert invalid_partial_answers(rows, {rows[0]["id"]: 7}) == [rows[0]["id"]]
        assert missing_required_answers(rows, {**answers, rows[-1]["id"]: 0}) == [rows[-1]["id"]]
    assert sum(len(question.get("options", [])) == 6 for question in questions.values()) == 24
    assert "fünfstufig" not in str(load_pretest_manifest(PILOT_SOURCE_KEY)["pck_pages"])


def test_pck_carries_the_revised_statements_and_step_order():
    questions = _pck_questions()
    earlier = _pck_questions(FIRST_PILOT_SOURCE_KEY)
    revised = {
        "pck_pre_1b_2": "Der Schüler nimmt möglicherweise an, dass die Schleife immer beim ersten "
        "Element des Arrays beginnt.",
        "pck_pre_1c_2": "Die Lehrkraft erklärt dem Schüler noch einmal die allgemeine "
        "Funktionsweise und Syntax von for-Schleifen.",
        "pck_pre_1c_5": "Die Lehrkraft gibt dem Schüler den Hinweis: „Überlege einmal, bei welchem "
        'Index die Nummerierung eines Arrays beginnt."',
        "pck_pre_3a_2": "Die Schülerin versteht möglicherweise nicht, dass geprüft werden soll, ob "
        "nach einer weiteren Ausleihe das Limit eingehalten wird.",
        "pck_pre_5d_5": "Die Lehrkraft zeigt dem Schüler, wie er mithilfe des Debuggers das "
        "Programm Schritt für Schritt ausführen und die Werte einzelner Variablen beobachten kann.",
    }
    for variable, text in revised.items():
        assert questions[variable]["text"] == text
    assert set(questions) - set(earlier) == {"pck_pre_5d_5"}
    assert set(earlier) <= set(questions)
    # Every other statement and prompt reads as it did in the first pilot.
    for variable in set(earlier) - set(revised):
        assert questions[variable]["text"] == earlier[variable]["text"]
        assert questions[variable]["type"] == earlier[variable]["type"]
    for variable in ("pck_pre_1a", "pck_pre_3b", "pck_pre_3b_justification", "pck_pre_5a"):
        ignored = {"source_ref": None, "layout_column": None}
        assert {**questions[variable], **ignored} == {**earlier[variable], **ignored}

    ranking = questions["pck_pre_5c"]
    assert ranking["type"] == "ranking"
    assert ranking["text"].endswith("\n\nOrdnen Sie die Schritte von 1 (zuerst) bis 4 (zuletzt).")
    assert ranking["options"] == [
        {
            "value": "step_1",
            "label": "Den Schüler erläutern lassen, woran er erkannt hat, ob eine Änderung die "
            "vermutete Fehlerursache bestätigt oder widerlegt.",
        },
        {
            "value": "step_2",
            "label": "Den Schüler erklären lassen, welche Veränderungen er am Programm "
            "vorgenommen hat.",
        },
        {
            "value": "step_3",
            "label": "Die Erklärungen des Schülers mit den tatsächlichen Änderungen und den "
            "beobachteten Programmergebnissen vergleichen.",
        },
        {
            "value": "step_4",
            "label": "Den Schüler beschreiben lassen, welches Ergebnis er durch die jeweilige "
            "Änderung erwartet hat.",
        },
    ]
    assert sorted(option["label"] for option in ranking["options"]) == sorted(
        option["label"] for option in earlier["pck_pre_5c"]["options"]
    )

    pick_two = questions["pck_pre_3b"]
    assert pick_two["min_selections"] == pick_two["max_selections"] == 2
    assert len(pick_two["options"]) == 4
    pair = [pick_two, questions["pck_pre_3b_justification"]]
    assert missing_required_answers(pair, {"pck_pre_3b": [1, 3]}) == ["pck_pre_3b_justification"]
    assert (
        missing_required_answers(
            pair, {"pck_pre_3b": [1, 3], "pck_pre_3b_justification": "Begründung"}
        )
        == []
    )
    assert "pck_pre_3b" in missing_required_answers(
        pair, {"pck_pre_3b": [1], "pck_pre_3b_justification": "Begründung"}
    )
    assert "pck_pre_3b" in missing_required_answers(
        pair, {"pck_pre_3b": [1, 2, 3], "pck_pre_3b_justification": "Begründung"}
    )


def test_revised_instrument_records_its_source_and_what_changed():
    content = load_pretest_manifest(PILOT_SOURCE_KEY)
    assert content["version"] == "2026-11-20"
    assert content["previous_instrument"] == FIRST_PILOT_SOURCE_KEY
    sheet = next(source for source in content["sources"] if source["kind"] == "spreadsheet")
    assert sheet["sheet"] == "TODO Pre-Test Inside Tool"
    assert sheet["format"] == "csv"
    assert sheet["sha256"] == content["source_sha256"]
    assert sheet["sha256"] == "e85f8f88b6575189178c8762786af2cd4b759ddf56ccfb92282972e043cc1516"
    mockup = next(source for source in content["sources"] if source["kind"] == "mockup")
    assert set(range(11, 21)) <= set(mockup["slides"])
    assert len(content["changes_from_previous"]) == 4
    decisions = "\n".join(content["editorial_decisions"])
    for kept in ("currentlyBorrowed", "werte.länge", "Gar nicht plausibel/geeignet", "step_1"):
        assert kept in decisions
    assert (
        content["ck_id_mapping"]["rows"]
        == (load_pretest_manifest(FIRST_PILOT_SOURCE_KEY)["ck_id_mapping"]["rows"])
    )
    assert content["mesp_intro"] == load_pretest_manifest(FIRST_PILOT_SOURCE_KEY)["mesp_intro"]


def test_first_pilot_instrument_is_kept_exactly_as_its_studies_were_seeded():
    path = MANIFEST_PATHS[FIRST_PILOT_SOURCE_KEY]
    assert (
        hashlib.sha256(path.read_bytes()).hexdigest()
        == "a2d875a5f9ac7b5799494b2657b76faaad3f7ee4c9b3b235d1eaedf814aa37f7"
    )
    content = load_pretest_manifest(FIRST_PILOT_SOURCE_KEY)
    pages = content["pck_pages"]
    assert [page["source_task"] for page in pages] == [1, 3, 5]
    assert [page["title"] for page in pages] == ["Fachdidaktisches Wissen"] * 3
    assert {
        question["source_ref"]["variable"] for page in pages for question in page["questions"]
    } == set(PCK_VARIABLES)
    assert _code(pages[1]["description"]) == [
        "public class LibraryAccount {",
        "",
        "  private int maxBooks = 5;",
        "",
        "  public boolean canBorrowMoreBooks (int currentlyBorrowed) {",
        "",
        "    if (currentlyBorrowed <= maxBooks) {",
        "",
        "        return true;",
        "",
        "    } else {",
        "",
        "    return false;",
        "",
        "    }",
        "  }",
        "}",
    ]
    refresh = next(source for source in content["sources"] if source.get("cells") == ["J31"])
    assert refresh["sheet"] == "TODO Pre-Test Inside Tool"
    assert refresh["sha256"] == "bb3cc546b210e37ee90ddfdf50b7272a8ab1f8abd30743f985651bb251c377ee"
    assert content["source_sha256"] != refresh["sha256"]
    assert "Base spreadsheet snapshot" in content["source_sha256_scope"]

    questions = _pck_questions(FIRST_PILOT_SOURCE_KEY)
    for variable in ("pck_pre_1b_1", "pck_pre_3a_1", "pck_pre_5b_1"):
        assert [option["label"] for option in questions[variable]["options"]] == [
            "sehr plausibel",
            "plausibel",
            "neutral",
            "eher nicht plausibel",
            "gar nicht plausibel",
        ]
    for variable in ("pck_pre_1c_1", "pck_pre_3c_1", "pck_pre_5d_1"):
        assert "(1 = sehr geeignet, 5 = gar nicht geeignet)" in questions[variable]["matrix_prompt"]
        assert [option["label"] for option in questions[variable]["options"]] == list("12345")
    assert questions["pck_pre_5c"]["options"][1]["label"].startswith("Den Schüler beschreiben")
    # Its three-column pages: task 1 a/b/c; task 3 a/b/c; task 5 a with b/c/d.
    columns = {
        1: {"a": 1, "b": 2, "c": 3},
        3: {"a": 1, "b": 2, "c": 3},
        5: {"a": 1, "b": 1, "c": 2, "d": 3},
    }
    for page in pages:
        expected = columns[page["source_task"]]
        for question in page["questions"]:
            assert question["layout_column"] == expected[question["source_ref"]["variable"][-1]]
        authored = [question["layout_column"] for question in page["questions"]]
        assert authored == sorted(authored)
    for page in pages:
        assert validate_question_definitions(page["questions"]) == []
    assert mapped_ck_tasks(source_key=FIRST_PILOT_SOURCE_KEY)[0]["source_ref"] == {
        "instrument": FIRST_PILOT_SOURCE_KEY,
        "row": 14,
        "variable": "ck_pre_01",
    }


@pytest.mark.parametrize("column", [1, 2, 3])
def test_question_layout_column_accepts_the_three_authored_columns(column):
    assert (
        validate_question_definitions(
            [{"id": "answer", "type": "free_text", "text": "Antwort", "layout_column": column}]
        )
        == []
    )


@pytest.mark.parametrize("column", [None, True, False, -1, 0, 4, 1.5, "1", []])
def test_question_layout_column_rejects_invalid_positions(column):
    errors = validate_question_definitions(
        [{"id": "answer", "type": "free_text", "text": "Antwort", "layout_column": column}]
    )
    assert any("layout_column" in error for error in errors)


def test_mesp_has_six_fixed_situations_with_independent_six_point_ratings():
    content = load_pretest_manifest(PILOT_SOURCE_KEY)
    pages = content["mesp_pages"]
    assert len(pages) == 6
    assert [len(page["questions"]) for page in pages] == [5] * 6
    assert "jede Zahl (1–6) nur einmal" in content["mesp_intro"]["body"]  # noqa: RUF001
    assert "nicht mit ihr kombiniert" in content["mesp_intro"]["body"]
    assert [question["source_ref"]["source_label"] for question in pages[1]["questions"]] == [
        "a",
        "b",
        "d",
        "e",
        "F",
    ]
    assert [question["id"] for question in pages[1]["questions"]] == [
        "mesp_pre_2a",
        "mesp_pre_2b",
        "mesp_pre_2c",
        "mesp_pre_2d",
        "mesp_pre_2e",
    ]
    assert "Ihre?" not in pages[4]["questions"][0]["text"]
    for number, page in enumerate(pages, 1):
        assert page["title"] == f"MESP: Aufgabe {number}"
        for question in page["questions"]:
            assert question["type"] == "multiple_choice"
            assert [option["value"] for option in question["options"]] == list(range(1, 7))
            assert question["options"][0]["label"].startswith("sehr geeignete")
            assert question["options"][-1]["label"].startswith("sehr ungeeignete")
        assert (
            missing_required_answers(page["questions"], {q["id"]: 2 for q in page["questions"]})
            == []
        )
    seeded = [battery for battery in PILOT_BATTERIES if battery.section_key == "mesp"]
    assert seeded[0].intro_body == content["mesp_intro"]["body"]
    assert all(not battery.intro_body for battery in seeded[1:])
    assert content["mesp_intro"]["body"] not in seeded[0].description


async def test_new_study_uses_pilot_manifest_and_import_is_idempotent(client, db, admin_headers):
    response = await client.post("/admin/studies", json={"name": "Pilot"}, headers=admin_headers)
    assert response.status_code == 201
    study_id = response.json()["id"]
    pages = list(
        await db.scalars(
            select(Questionnaire)
            .where(
                Questionnaire.study_id == study_id,
                Questionnaire.placement == QuestionnairePlacement.pre_test,
            )
            .order_by(Questionnaire.order_index)
        )
    )
    assert [page.section_key for page in pages] == [
        "demographics",
        "ck_self",
        "ck_self",
        *(["ck_tasks"] * 13),
        *(["pck"] * 10),
        *(["mesp"] * 6),
    ]
    assert [page.order_index for page in pages] == list(range(32))
    assert [page.questions[0] for page in pages[3:16]] == mapped_ck_tasks(
        source_key=PILOT_SOURCE_KEY
    )
    manifest = load_pretest_manifest(PILOT_SOURCE_KEY)
    assert [(page.title, page.description, page.questions) for page in pages[16:26]] == [
        (page["title"], page["description"], page["questions"]) for page in manifest["pck_pages"]
    ]
    assert [page.title for page in pages[26:]] == [f"MESP: Aufgabe {n}" for n in range(1, 7)]
    # One introduction per section, on its first page.
    assert [bool(page.intro_body) for page in pages[16:26]] == [True] + [False] * 9
    assert pages[16].intro_title == "Fachdidaktisches Wissen"
    assert {
        question["source_ref"]["instrument"] for page in pages[3:] for question in page.questions
    } == {PILOT_SOURCE_KEY}
    before = [(page.id, page.questions) for page in pages]
    messages = await import_ck_pretest(db, study_id, pck_questionnaire_id=pages[16].id, apply=True)
    assert "No changes" in messages[0]
    assert [(page.id, page.questions) for page in pages] == before


@pytest.mark.parametrize("apply", [False, True])
async def test_study_seeded_from_the_first_pilot_is_checked_against_its_own_instrument(
    db, seed_study, apply
):
    seed_study.flow_version = "pilot_20261116"
    manifest = load_pretest_manifest(FIRST_PILOT_SOURCE_KEY)
    pages = [
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=f"CK: Aufgabe {index + 1}",
            section="CK-Debugging",
            section_key="ck_tasks",
            intro_title=manifest["ck_intro"]["title"] if index == 0 else "",
            intro_body=manifest["ck_intro"]["body"] if index == 0 else "",
            order_index=3 + index,
            questions=[question],
        )
        for index, question in enumerate(mapped_ck_tasks(source_key=FIRST_PILOT_SOURCE_KEY))
    ]
    pages += [
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=page["title"],
            description=page["description"],
            section="PCK-Pretest",
            section_key="pck",
            order_index=16 + index,
            questions=deepcopy(page["questions"]),
        )
        for index, page in enumerate(manifest["pck_pages"])
    ]
    db.add_all(pages)
    await db.flush()
    original = [(page.id, page.order_index, page.title, deepcopy(page.questions)) for page in pages]

    messages = await import_ck_pretest(
        db, seed_study.id, pck_questionnaire_id=pages[13].id, apply=apply
    )

    assert len(messages) == 1 and "No changes" in messages[0]
    assert FIRST_PILOT_SOURCE_KEY in messages[0] and "new study" in messages[0]
    assert [(page.id, page.order_index, page.title, page.questions) for page in pages] == original
    assert "\n" not in pages[0].questions[0]["text"]
    assert len(pages) == 16


async def test_pilot_ck_import_uses_the_pilot_source_for_an_empty_draft(db, seed_study):
    seed_study.flow_version = "pilot_20261116"
    pck = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.pre_test,
        title="PCK",
        section_key="pck",
        order_index=3,
        questions=[{"id": "draft", "type": "free_text", "text": "Draft"}],
    )
    db.add(pck)
    await db.flush()
    await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck.id, apply=True)
    pages = list(
        await db.scalars(
            select(Questionnaire)
            .where(Questionnaire.study_id == seed_study.id, Questionnaire.section_key == "ck_tasks")
            .order_by(Questionnaire.order_index)
        )
    )
    assert [page.questions[0] for page in pages] == mapped_ck_tasks(source_key=PILOT_SOURCE_KEY)


async def test_outro_refresh_only_changes_stock_wording_in_an_unstarted_draft(db, seed_study):
    seed_study.flow_version = "pilot_20261116"
    questions = deepcopy(CASE_OUTRO)
    questions[-1]["text"] = "Eigene Formulierung"
    page = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Own title",
        questions=questions,
    )
    db.add(page)
    await db.flush()
    await seed_batteries(db, seed_study.id)
    assert page.title == "Own title"
    assert page.questions[:3] == PILOT_CASE_OUTRO[:3]
    assert page.questions[-1]["text"] == "Eigene Formulierung"


@pytest.mark.parametrize("history", ["session", "response"])
async def test_outro_refresh_never_changes_started_or_answered_content(
    db, seed_study, seed_participant, history
):
    page = Questionnaire(
        study_id=seed_study.id,
        placement=QuestionnairePlacement.case_outro,
        title="Historic",
        questions=deepcopy(CASE_OUTRO),
    )
    db.add(page)
    await db.flush()
    if history == "session":
        db.add(Session(participant_id=seed_participant.id))
    else:
        db.add(
            QuestionnaireResponse(
                questionnaire_id=page.id, participant_id=seed_participant.id, answers={"auth1": 2}
            )
        )
    await db.flush()
    assert await refresh_unstarted_case_outro(db, seed_study.id) == 0
    assert page.questions == CASE_OUTRO


async def test_unstarted_first_pilot_study_takes_the_revised_instrument_once_reseeded(
    client, db, seed_study, seed_participant, admin_headers
):
    seed_study.flow_version = "pilot_20261116"
    first = load_pretest_manifest(FIRST_PILOT_SOURCE_KEY)
    old = [
        Questionnaire(
            study_id=seed_study.id,
            placement=QuestionnairePlacement.pre_test,
            title=page["title"],
            description=page["description"],
            section="PCK-Pretest",
            section_key="pck",
            order_index=16 + index,
            questions=deepcopy(page["questions"]),
        )
        for index, page in enumerate(first["pck_pages"])
    ]
    db.add_all(old)
    await db.flush()
    seed = f"/admin/studies/{seed_study.id}/questionnaires/seed"

    # Seeding never replaces a pre-test block that is there, whatever its version.
    added = (await client.post(seed, headers=admin_headers)).json()
    assert {page["placement"] for page in added} == {"diagnosis", "case_outro"}
    assert "fünfstufigen" in old[0].questions[1]["matrix_prompt"]

    for page in old:
        removed = await client.delete(f"/admin/questionnaires/{page.id}", headers=admin_headers)
        assert removed.status_code == 200
    reseeded = await client.post(seed, headers=admin_headers)
    assert reseeded.status_code == 201
    pages = reseeded.json()
    assert len(pages) == 32
    assert {page["placement"] for page in pages} == {"pre_test"}
    pck = [page for page in pages if page["section_key"] == "pck"]
    assert [page["title"] for page in pck] == [
        page["title"] for page in load_pretest_manifest(PILOT_SOURCE_KEY)["pck_pages"]
    ]
    assert {
        question["source_ref"]["instrument"] for page in pck for question in page["questions"]
    } == {PILOT_SOURCE_KEY}

    # Once someone has logged in, the instrument is fixed for that study.
    db.add(Session(participant_id=seed_participant.id))
    await db.flush()
    refused = await client.delete(f"/admin/questionnaires/{pck[0]['id']}", headers=admin_headers)
    assert refused.status_code == 409
    assert (await client.post(seed, headers=admin_headers)).status_code == 409


def _pck_drafts(study, source_key, start=3):
    return [
        Questionnaire(
            study_id=study.id,
            placement=QuestionnairePlacement.pre_test,
            title=page["title"],
            description=page["description"],
            section="PCK-Pretest",
            section_key="pck",
            order_index=start + index,
            questions=deepcopy(page["questions"]),
        )
        for index, page in enumerate(load_pretest_manifest(source_key)["pck_pages"])
    ]


@pytest.mark.parametrize("source_key", [FIRST_PILOT_SOURCE_KEY, PILOT_SOURCE_KEY])
async def test_ck_import_takes_the_instrument_of_the_pck_pages_already_in_the_draft(
    db, seed_study, source_key
):
    seed_study.flow_version = "pilot_20261116"
    pck = _pck_drafts(seed_study, source_key)
    db.add_all(pck)
    await db.flush()

    preview = await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck[0].id)
    assert preview[:2] == ["Dry run — no changes.", f"Source: {source_key}."]
    await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck[0].id, apply=True)

    pages = list(
        await db.scalars(
            select(Questionnaire)
            .where(Questionnaire.study_id == seed_study.id)
            .order_by(Questionnaire.order_index)
        )
    )
    assert [page.section_key for page in pages] == ["ck_tasks"] * 13 + ["pck"] * len(pck)
    assert [page.questions[0] for page in pages[:13]] == mapped_ck_tasks(source_key=source_key)
    # One instrument per study, whichever pilot the draft was prepared from.
    assert {
        question["source_ref"]["instrument"] for page in pages for question in page.questions
    } == {source_key}
    again = await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck[0].id, apply=True)
    assert len(again) == 1 and "No changes" in again[0]


async def test_ck_import_refuses_a_draft_that_mixes_two_pilot_instruments(db, seed_study):
    seed_study.flow_version = "pilot_20261116"
    first = _pck_drafts(seed_study, FIRST_PILOT_SOURCE_KEY)
    revised = _pck_drafts(seed_study, PILOT_SOURCE_KEY, start=3 + len(first))
    for page in revised:
        for question in page.questions:
            question["id"] = "second_" + question["id"]
    db.add_all([*first, *revised])
    await db.flush()
    with pytest.raises(ContentImportError, match="two pilot instruments"):
        await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=first[0].id, apply=True)
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == 13


@pytest.mark.parametrize("apply", [False, True])
async def test_ck_import_notices_a_pck_page_from_the_other_pilot_beside_an_imported_ck_block(
    db, seed_study, apply
):
    seed_study.flow_version = "pilot_20261116"
    pck = _pck_drafts(seed_study, PILOT_SOURCE_KEY)
    db.add_all(pck)
    await db.flush()
    await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck[0].id, apply=True)
    settled = await import_ck_pretest(
        db, seed_study.id, pck_questionnaire_id=pck[0].id, apply=apply
    )
    assert len(settled) == 1 and "No changes" in settled[0]

    # One PCK page is swapped for the first pilot's page of the same task.
    swapped = pck[1]
    earlier = load_pretest_manifest(FIRST_PILOT_SOURCE_KEY)["pck_pages"][0]
    swapped.questions = deepcopy(earlier["questions"])
    await db.flush()
    before = [
        (page.id, page.order_index, deepcopy(page.questions))
        for page in await db.scalars(
            select(Questionnaire)
            .where(Questionnaire.study_id == seed_study.id)
            .order_by(Questionnaire.order_index)
        )
    ]

    with pytest.raises(ContentImportError, match="two pilot instruments"):
        await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck[0].id, apply=apply)

    after = [
        (page.id, page.order_index, page.questions)
        for page in await db.scalars(
            select(Questionnaire)
            .where(Questionnaire.study_id == seed_study.id)
            .order_by(Questionnaire.order_index)
        )
    ]
    assert after == before


@pytest.mark.parametrize(
    ("ck_source", "pck_source"),
    [(PILOT_SOURCE_KEY, FIRST_PILOT_SOURCE_KEY), (FIRST_PILOT_SOURCE_KEY, PILOT_SOURCE_KEY)],
)
@pytest.mark.parametrize("apply", [False, True])
async def test_ck_import_refuses_a_ck_block_beside_the_other_pilots_pck_pages(
    db, seed_study, ck_source, pck_source, apply
):
    seed_study.flow_version = "pilot_20261116"
    # The CK block arrives with its own pilot's PCK pages, which are then all replaced.
    pck = _pck_drafts(seed_study, ck_source)
    db.add_all(pck)
    await db.flush()
    await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck[0].id, apply=True)
    for page in pck:
        await db.delete(page)
    await db.flush()
    replaced = _pck_drafts(seed_study, pck_source, start=3 + 13)
    db.add_all(replaced)
    await db.flush()

    with pytest.raises(ContentImportError, match="different pilot instruments"):
        await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=replaced[0].id, apply=apply)
    assert await db.scalar(select(func.count()).select_from(Questionnaire)) == 13 + len(replaced)


async def test_ck_import_still_settles_a_draft_whose_pck_pages_carry_no_source(db, seed_study):
    seed_study.flow_version = "pilot_20261116"
    pck = _pck_drafts(seed_study, PILOT_SOURCE_KEY)
    db.add_all(pck)
    await db.flush()
    await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck[0].id, apply=True)
    # Pages a researcher wrote by hand say nothing about an instrument.
    for page in pck:
        page.questions = [
            {key: value for key, value in question.items() if key != "source_ref"}
            for question in page.questions
        ]
    await db.flush()
    settled = await import_ck_pretest(db, seed_study.id, pck_questionnaire_id=pck[0].id, apply=True)
    assert len(settled) == 1 and "No changes" in settled[0]
