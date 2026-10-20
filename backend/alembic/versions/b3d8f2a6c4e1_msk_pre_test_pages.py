"""The MSK pre-test pages, for studies that already exist

The MSK instrument — seven learning situations, each with five or six ways of
handling it, every one rated 1–6 — arrived after the standard pre-test block
had been seeded onto the running studies. New studies get the pages from the
seed; this gives them to every study that carries the standard block (the
"Angaben zur Person" page) and has no MSK page yet, so the researchers' study
is complete without anyone retyping an instrument. A study without the
standard block is left alone: its pre-test is the researcher's own.

The pages go after the study's last pre-test page, whatever its number, so a
page the researcher added keeps its place and nothing shares a position.

A run already under way keeps its screen. The script is the welcome, the
pre-test pages that have questions, then everything else, and a session's
pointer is an index into that list; seven more pages push every later screen
seven places down, so a pointer past the pre-test moves with it. A run that
was still inside the pre-test meets the new pages at the end of it, and one
that had left it never sees them — that is the same run as before.

A frozen copy of the pages, so this keeps doing the same thing after the
application's content moves on; a test says the copy and the content agree.

Revision ID: b3d8f2a6c4e1
Revises: a7c2e9d4f1b8
Create Date: 2026-10-13
"""

import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.engine import Connection

revision = "b3d8f2a6c4e1"
down_revision = "a7c2e9d4f1b8"
branch_labels = None
depends_on = None

SECTION = "MSK"

PAGES = [
    {
        "title": "MSK: Aufgabe 1",
        "description": "Die folgenden Aufgaben beschreiben verschiedene Lernsituationen. Für jede Situation werden Ihnen mehrere Handlungsmöglichkeiten vorgestellt, die eine Person in dieser Situation anwenden könnte. Nachdem Sie die Beschreibung gelesen und sich mit dieser vertraut gemacht haben, bewerten Sie bitte jede dieser Handlungsmöglichkeiten für sich alleinstehend danach, wie gut sie für den Umgang mit dieser konkreten Situation geeignet ist.\n\nBitte beachten Sie bei der Bewertung der Handlungsmöglichkeiten Folgendes:\n\n- Bewerten Sie jede Handlungsmöglichkeit danach, wie gut sie für das Erreichen des Ziels in dieser konkreten Situation geeignet ist, und nicht danach, wie Sie persönlich normalerweise in der alltäglichen Praxis handeln würden.\n- Jede Handlungsmöglichkeit steht für sich allein. Gehen Sie bei der Bewertung einer Handlungsmöglichkeit davon aus, dass diese in keinem Zusammenhang mit einer anderen aufgeführten Handlungsmöglichkeit steht, nicht mit ihr kombiniert wird und nicht von ihr abhängt.\n- Sie können dieselbe Bewertung innerhalb einer Aufgabe mehrmals vergeben. Es ist nicht erforderlich, jede Zahl (1–6) nur einmal zu verwenden. Wenn Sie der Meinung sind, dass mehrere Handlungsmöglichkeiten gleichermaßen geeignet sind, können Sie ihnen dieselbe Bewertung geben.\n\nVerwenden Sie für Ihre Bewertungen die folgende Skala:\n\n- 1 = sehr geeignete Handlungsmöglichkeit für diese Situation\n- 2 = geeignete Handlungsmöglichkeit für diese Situation\n- 3 = eher geeignete Handlungsmöglichkeit für diese Situation\n- 4 = eher ungeeignete Handlungsmöglichkeit für diese Situation\n- 5 = ungeeignete Handlungsmöglichkeit für diese Situation\n- 6 = sehr ungeeignete Handlungsmöglichkeit für diese Situation\n\nStellen Sie sich vor, Sie und Ihre Kommilitoninnen und Kommilitonen müssen einzeln an Programmieraufgaben arbeiten. Computer stehen dafür zur Verfügung. Die Lösung wird am Ende jeder Aufgabe angezeigt. Auch diese Lösung muss verstanden werden.\n\nWie beurteilen Sie die folgenden Vorgehensweisen?",
        "questions": [
            {
                "id": "msk_pre_1a",
                "type": "multiple_choice",
                "text": "Die Aufgaben gemeinsam mit Kommilitoninnen und Kommilitonen betrachten.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_1",
            },
            {
                "id": "msk_pre_1b",
                "type": "multiple_choice",
                "text": "Die Aufgaben allein lösen und anschließend die Lösungen und Ergebnisse überprüfen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_1",
            },
            {
                "id": "msk_pre_1c",
                "type": "multiple_choice",
                "text": "Während der Bearbeitung der Aufgaben wichtige Aspekte notieren, die später für die Prüfung wichtig sind.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_1",
            },
            {
                "id": "msk_pre_1d",
                "type": "multiple_choice",
                "text": "Die Musterlösungen und Ergebnisse vor der Bearbeitung der Aufgaben lesen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_1",
            },
            {
                "id": "msk_pre_1e",
                "type": "multiple_choice",
                "text": "Kürzlich besprochene Programmierkonzepte anhand der eigenen Notizen wiederholen, um Zusammenhänge zu erkennen, und anschließend die Aufgaben selbstständig bearbeiten.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_1",
            },
        ],
    },
    {
        "title": "MSK: Aufgabe 2",
        "description": "Stellen Sie sich vor, Sie erhalten die Möglichkeit, sich selbstständig mit einem neuen Thema zu beschäftigen und im Unterricht zu präsentieren. Dafür müssen sie selbstständig Informationen zum Thema recherchieren. Die Lehrkraft schlägt ihnen dafür verschiedene Websites vor.\n\nWie beurteilen Sie die folgenden Vorgehensweisen?",
        "questions": [
            {
                "id": "msk_pre_2a",
                "type": "multiple_choice",
                "text": "Vor Beginn der Recherche überlegen, welche Informationen für die Präsentation benötigt werden.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_2",
            },
            {
                "id": "msk_pre_2b",
                "type": "multiple_choice",
                "text": "Die empfohlenen Websites überfliegen und sortieren, um einen Überblick zu erhalten.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_2",
            },
            {
                "id": "msk_pre_2c",
                "type": "multiple_choice",
                "text": "Alle Informationen gründlich lesen und sich die Begriffe sofort einprägen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_2",
            },
            {
                "id": "msk_pre_2d",
                "type": "multiple_choice",
                "text": "Die gefundenen Informationen mit dem eigenen Vorwissen vergleichen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_2",
            },
            {
                "id": "msk_pre_2e",
                "type": "multiple_choice",
                "text": "Gemeinsam mit Kommilitoninnen und Kommilitonen die schriftlichen Notizen aus anderen Schulfächern durchgehen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_2",
            },
        ],
    },
    {
        "title": "MSK: Aufgabe 3",
        "description": "Stellen Sie sich vor, in zwei Wochen steht eine schwierige Prüfung mit Programmieraufgabe an. Zur Vorbereitung erhalten Sie von der Lehrkraft einen Link, über den Sie online Programmieraufgaben aus alten Prüfungen bearbeiten können.\n\nWie beurteilen Sie die folgenden Vorgehensweisen?",
        "questions": [
            {
                "id": "msk_pre_3a",
                "type": "multiple_choice",
                "text": "Alle Prüfungsaufgaben mehrmals durchlesen, ohne sie zu lösen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_3",
            },
            {
                "id": "msk_pre_3b",
                "type": "multiple_choice",
                "text": "Nach den Lösungen der Aufgaben suchen und diese auswendig lernen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_3",
            },
            {
                "id": "msk_pre_3c",
                "type": "multiple_choice",
                "text": "Die verschiedenen Aufgabentypen sortieren.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_3",
            },
            {
                "id": "msk_pre_3d",
                "type": "multiple_choice",
                "text": "Während der Bearbeitung der Prüfungsaufgaben immer wieder überprüfen, ob alles verstanden wurde.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_3",
            },
            {
                "id": "msk_pre_3e",
                "type": "multiple_choice",
                "text": "Sich mehr Zeit nehmen, wenn die Prüfungsaufgaben schwieriger werden.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_3",
            },
        ],
    },
    {
        "title": "MSK: Aufgabe 4",
        "description": "Stellen Sie sich vor, Sie belegen einen E-Learning-Kurs, in dem die Inhalte eines Seminars in Informatik aufbereitet und mit Hyperlinks verknüpft sind. Sie müssen sich nun auf die anstehende Klausur vorbereiten und einige zentrale Konzepte lernen.\n\nWie beurteilen Sie die folgenden Vorgehensweisen?",
        "questions": [
            {
                "id": "msk_pre_4a",
                "type": "multiple_choice",
                "text": "Der vorgegebenen Gliederung möglichst genau folgen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_4",
            },
            {
                "id": "msk_pre_4b",
                "type": "multiple_choice",
                "text": "Sich die Lernziele zunächst bewusst machen – auch wenn dies etwas Zeit in Anspruch nimmt – und sich dann nur auf die zentralen Inhalte konzentrieren.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_4",
            },
            {
                "id": "msk_pre_4c",
                "type": "multiple_choice",
                "text": "Die wichtigsten Konzepte für jeden Abschnitt aufschreiben und prüfen, ob alles verstanden wurde.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_4",
            },
            {
                "id": "msk_pre_4d",
                "type": "multiple_choice",
                "text": "Zuerst alle Überschriften der Abschnitte durchlesen, bevor man die Lektion gründlich bearbeitet.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_4",
            },
            {
                "id": "msk_pre_4e",
                "type": "multiple_choice",
                "text": "Gleich dem Hyperlink zum Glossar folgen, wenn ein Begriff nicht verstanden wird.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_4",
            },
            {
                "id": "msk_pre_4f",
                "type": "multiple_choice",
                "text": "Möglichst alle Inhalte und Beispiele während der Bearbeitung der Lektion notieren.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_4",
            },
        ],
    },
    {
        "title": "MSK: Aufgabe 5",
        "description": "Stellen Sie sich vor, Sie sollen eine Präsentation zu einem Thema halten. Dazu recherchieren Sie im Internet.\n\nWie beurteilen Sie die folgenden Vorgehensweisen?",
        "questions": [
            {
                "id": "msk_pre_5a",
                "type": "multiple_choice",
                "text": "Die Aufgabe strukturieren und Teilziele formulieren.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_5",
            },
            {
                "id": "msk_pre_5b",
                "type": "multiple_choice",
                "text": "Nach Seiten suchen, die einen Überblick über das Thema geben.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_5",
            },
            {
                "id": "msk_pre_5c",
                "type": "multiple_choice",
                "text": "Allen empfohlenen Links folgen und sich umfassend informieren.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_5",
            },
            {
                "id": "msk_pre_5d",
                "type": "multiple_choice",
                "text": "Zusammengehörige Informationen gruppieren und sie in Beziehung setzen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_5",
            },
            {
                "id": "msk_pre_5e",
                "type": "multiple_choice",
                "text": "Versuchen, sich an Informationen zu erinnern, denen Sie beim Durchklicken begegnet sind.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_5",
            },
            {
                "id": "msk_pre_5f",
                "type": "multiple_choice",
                "text": "Zuerst einen sehr genauen Überblick darüber verschaffen, wie die einzelnen Inhalte miteinander verknüpft sind.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_5",
            },
        ],
    },
    {
        "title": "MSK: Aufgabe 6",
        "description": "Stellen Sie sich vor, Sie sollen eine Präsentation zu einer Modellierungsart vorbereiten. Ihr Kursleiter gibt Ihnen als Quelle eine Lernsoftware, welche nicht linear, sondern individuell durchgearbeitet werden kann.\n\nWie beurteilen Sie die folgenden Vorgehensweisen?",
        "questions": [
            {
                "id": "msk_pre_6a",
                "type": "multiple_choice",
                "text": "Sich auf die Texte der Lernsoftware konzentrieren, die besonders gut verständlich sind.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_6",
            },
            {
                "id": "msk_pre_6b",
                "type": "multiple_choice",
                "text": "Die Texte, die Sie für besonders relevant halten, genau durchlesen und sich stichpunktartig die wichtigsten Aussagen aufschreiben.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_6",
            },
            {
                "id": "msk_pre_6c",
                "type": "multiple_choice",
                "text": "Die Gliederung nach bereits bekannten Inhalten absuchen und anschließend dort aufgeführte Texte lesen, um sich an das gesuchte Modell heranzuarbeiten.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_6",
            },
            {
                "id": "msk_pre_6d",
                "type": "multiple_choice",
                "text": "Die Texte ausdrucken und genau durchlesen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_6",
            },
            {
                "id": "msk_pre_6e",
                "type": "multiple_choice",
                "text": "Sich einen Überblick über die Struktur der Lernsoftware verschaffen und die Texte aufarbeiten, welche Sie für relevant erachten.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_6",
            },
            {
                "id": "msk_pre_6f",
                "type": "multiple_choice",
                "text": "Sich einige markante Seiten, die mit vielen anderen Inhalten verknüpft sind, einprägen, um sich schnell orientieren zu können.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_6",
            },
        ],
    },
    {
        "title": "MSK: Aufgabe 7",
        "description": "Stellen Sie sich vor, Sie sollen an einer Programmieraufgabe arbeiten und stoßen auf ein Problem. Sie entscheiden sich, im Internet, z. B. bei Stack Overflow oder GitHub, nach Lösungen zu suchen.\n\nWie beurteilen Sie die folgenden Vorgehensweisen?",
        "questions": [
            {
                "id": "msk_pre_7a",
                "type": "multiple_choice",
                "text": "Nach relevanten Seiten suchen und diese nach ihrer Vertrauenswürdigkeit bewerten.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_7",
            },
            {
                "id": "msk_pre_7b",
                "type": "multiple_choice",
                "text": "Möglichst viele Informationen sammeln und diese überfliegen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_7",
            },
            {
                "id": "msk_pre_7c",
                "type": "multiple_choice",
                "text": "Den Informationen folgen, die auf den Seiten besonders ins Auge fallen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_7",
            },
            {
                "id": "msk_pre_7d",
                "type": "multiple_choice",
                "text": "Sich auf Inhalte konzentrieren, für die Sie sich besonders interessieren.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_7",
            },
            {
                "id": "msk_pre_7e",
                "type": "multiple_choice",
                "text": "Sich zunächst grob mit dem Thema vertraut machen und dann Details erarbeiten.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_7",
            },
            {
                "id": "msk_pre_7f",
                "type": "multiple_choice",
                "text": "Den Inhalt mit einigen Schlüsselwörtern beschreiben und gezielt nach diesen suchen.",
                "options": [
                    {
                        "value": 1,
                        "label": "sehr geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 2, "label": "geeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 3,
                        "label": "eher geeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {
                        "value": 4,
                        "label": "eher ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                    {"value": 5, "label": "ungeeignete Handlungsmöglichkeit für diese Situation"},
                    {
                        "value": 6,
                        "label": "sehr ungeeignete Handlungsmöglichkeit für diese Situation",
                    },
                ],
                "matrix": "msk_pre_7",
            },
        ],
    },
]

# The pre-test pages a participant is shown: a page without questions (the
# PCK block is seeded empty) is skipped by the script and counts for nothing.
_SHOWN_PRE_TEST_PAGES = sa.text(
    """
    SELECT count(*) FROM questionnaires
    WHERE study_id = :study_id AND placement = 'pre_test'
      AND jsonb_array_length(questions) > 0
    """
)

_STUDY_SESSIONS = "participant_id IN (SELECT id FROM participants WHERE study_id = :study_id)"


def add_pages(bind: Connection) -> list[int]:
    """Append the pages to every study that carries the standard block and has
    none of them yet; returns the ids of the studies that got them."""
    studies = (
        bind.execute(
            sa.text(
                """
                SELECT s.id FROM studies s
                WHERE EXISTS (
                    SELECT 1 FROM questionnaires q
                    WHERE q.study_id = s.id AND q.placement = 'pre_test'
                      AND q.title = 'Angaben zur Person'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM questionnaires q
                    WHERE q.study_id = s.id AND q.section = :section
                )
                ORDER BY s.id
                """
            ),
            {"section": SECTION},
        )
        .scalars()
        .all()
    )
    insert = sa.text(
        """
        INSERT INTO questionnaires
            (study_id, placement, title, description, section, order_index, questions)
        VALUES
            (:study_id, 'pre_test', :title, :description, :section, :order_index,
             CAST(:questions AS jsonb))
        """
    )
    for study_id in studies:
        shown = bind.scalar(_SHOWN_PRE_TEST_PAGES, {"study_id": study_id})
        last = bind.scalar(
            sa.text(
                "SELECT coalesce(max(order_index), -1) FROM questionnaires "
                "WHERE study_id = :study_id AND placement = 'pre_test'"
            ),
            {"study_id": study_id},
        )
        for offset, page in enumerate(PAGES):
            bind.execute(
                insert,
                {
                    "study_id": study_id,
                    "title": page["title"],
                    "description": page["description"],
                    "section": SECTION,
                    "order_index": last + 1 + offset,
                    "questions": json.dumps(page["questions"], ensure_ascii=False),
                },
            )
        # Index 0 is the welcome, 1..shown the pre-test; anything beyond is a
        # later screen, now len(PAGES) further on.
        bind.execute(
            sa.text(
                f"UPDATE sessions SET current_step_index = current_step_index + :added "
                f"WHERE {_STUDY_SESSIONS} AND current_step_index > :shown"
            ),
            {"added": len(PAGES), "study_id": study_id, "shown": shown},
        )
    return list(studies)


def remove_pages(bind: Connection) -> None:
    """Take the pages out again, with their answers: a response points at its
    page and cannot outlive it. Downgrade is a development tool, not a rollback
    plan."""
    mine = "section = :section AND title LIKE 'MSK: Aufgabe %'"
    removed = dict(
        bind.execute(
            sa.text(
                f"SELECT study_id, count(*) FROM questionnaires WHERE {mine} GROUP BY study_id"
            ),
            {"section": SECTION},
        ).all()
    )
    bind.execute(
        sa.text(
            "DELETE FROM questionnaire_responses WHERE questionnaire_id IN "
            f"(SELECT id FROM questionnaires WHERE {mine})"
        ),
        {"section": SECTION},
    )
    bind.execute(sa.text(f"DELETE FROM questionnaires WHERE {mine}"), {"section": SECTION})
    for study_id, count in sorted(removed.items()):
        shown = bind.scalar(_SHOWN_PRE_TEST_PAGES, {"study_id": study_id})
        # A pointer past the pages moves back up; one that was on an MSK page
        # lands on the screen after the pre-test, where the run resumes.
        bind.execute(
            sa.text(
                "UPDATE sessions SET current_step_index = "
                "greatest(current_step_index - :removed, :shown + 1) "
                f"WHERE {_STUDY_SESSIONS} AND current_step_index > :shown"
            ),
            {"removed": count, "study_id": study_id, "shown": shown},
        )


def upgrade() -> None:
    add_pages(op.get_bind())


def downgrade() -> None:
    remove_pages(op.get_bind())
