"""Think-aloud screens in blocks.

A study can have its participants work through several training cases and only
then narrate them, one recording after another. The pre-test and post-test case
never batch: those two are narrated straight away, while the diagnosis is fresh.
"""

from __future__ import annotations

import csv
import io

import pytest_asyncio
from sqlalchemy import select

from app.core.config import get_settings
from app.models.enums import PhaseType
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.video import Video
from app.services.session_script import count_steps, think_aloud_groups

PRE, TRAIN, POST = PhaseType.pre_test, PhaseType.training, PhaseType.post_test

# The study as designed: one pre-test case, seven training, one post-test.
NINE = [PRE] + [TRAIN] * 7 + [POST]


@pytest_asyncio.fixture
async def study_of_nine(db, seed_study, seed_participant):
    """Nine cases assigned to the participant, in the study's own order."""
    seed_study.sosci_pretest_url = "https://sosci.example/pre"
    seed_study.sosci_posttest_url = "https://sosci.example/post"

    videos = []
    for i, phase in enumerate(NINE):
        v = Video(
            study_id=seed_study.id,
            title=f"Fall {i + 1}",
            phase_type=phase,
            gcp_filename=f"case{i}.mp4",
        )
        db.add(v)
        videos.append(v)
    await db.flush()
    db.add_all(
        ParticipantVideo(
            participant_id=seed_participant.id,
            video_id=v.id,
            slot_index=i,
            phase_type=v.phase_type,
        )
        for i, v in enumerate(videos)
    )
    await db.flush()
    return {"study": seed_study, "participant": seed_participant, "videos": videos}


async def _script(client, pid: str) -> list[dict]:
    login = await client.post("/auth/participant/login", json={"participant_id": pid})
    assert login.status_code == 200, login.text
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    r = await client.get("/participant/session", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["steps"]


def _case_order(steps: list[dict]) -> list[tuple[str, int]]:
    """The clips and the think-alouds in the order they are met."""
    return [(s["kind"], s["video_id"]) for s in steps if s["kind"] in ("case_video", "think_aloud")]


# --- the grouping itself ---------------------------------------------------


def test_one_per_case_is_the_default_shape():
    assert think_aloud_groups(NINE, 1) == [[i] for i in range(9)]


def test_training_batches_and_the_last_block_may_be_short():
    # Seven training cases in blocks of three: 3, 3, then the odd one out.
    assert think_aloud_groups(NINE, 3) == [[0], [1, 2, 3], [4, 5, 6], [7], [8]]


def test_the_pre_and_post_case_never_join_a_block():
    """Whatever the batch size, those two are narrated immediately."""
    for size in (1, 2, 3, 9, 20):
        groups = think_aloud_groups(NINE, size)
        assert groups[0] == [0], size  # the pre-test case, alone
        assert groups[-1] == [8], size  # the post-test case, alone


def test_a_batch_larger_than_the_phase_is_the_whole_phase():
    assert think_aloud_groups(NINE, 20) == [[0], [1, 2, 3, 4, 5, 6, 7], [8]]


def test_a_block_never_spans_a_phase_change():
    """A hand-picked sequence may put a phase between two training runs; the
    block restarts rather than reaching across it."""
    phases = [TRAIN, TRAIN, POST, TRAIN, TRAIN]
    assert think_aloud_groups(phases, 3) == [[0, 1], [2], [3, 4]]


def test_batching_moves_think_alouds_but_never_adds_one():
    """`count_steps` is the admin's progress denominator and takes no batch
    size; it can only stay right if batching keeps the step count."""
    for size in (1, 2, 3, 7, 20):
        groups = think_aloud_groups(NINE, size)
        assert sum(len(g) for g in groups) == len(NINE), size
    assert count_steps(1, NINE, calibration=False) == 1 + 1 + 1 + 3 + 5 * 9 + 1 + 1


# --- the run itself --------------------------------------------------------


async def test_by_default_each_case_is_narrated_straight_away(client, study_of_nine):
    steps = await _script(client, study_of_nine["participant"].id)
    ids = [v.id for v in study_of_nine["videos"]]

    # clip, think-aloud, clip, think-aloud, … all the way through.
    assert _case_order(steps) == [
        pair for vid in ids for pair in (("case_video", vid), ("think_aloud", vid))
    ]


async def test_a_batch_of_three_works_through_three_cases_then_narrates_them(
    client, db, study_of_nine
):
    study_of_nine["study"].think_aloud_batch_size = 3
    await db.flush()

    steps = await _script(client, study_of_nine["participant"].id)
    ids = [v.id for v in study_of_nine["videos"]]

    assert _case_order(steps) == [
        # The pre-test case, narrated immediately.
        ("case_video", ids[0]),
        ("think_aloud", ids[0]),
        # Three training cases, then their three recordings in the same order.
        ("case_video", ids[1]),
        ("case_video", ids[2]),
        ("case_video", ids[3]),
        ("think_aloud", ids[1]),
        ("think_aloud", ids[2]),
        ("think_aloud", ids[3]),
        ("case_video", ids[4]),
        ("case_video", ids[5]),
        ("case_video", ids[6]),
        ("think_aloud", ids[4]),
        ("think_aloud", ids[5]),
        ("think_aloud", ids[6]),
        # Seven does not divide by three; the last training case is its own block.
        ("case_video", ids[7]),
        ("think_aloud", ids[7]),
        # And the post-test case, narrated immediately again.
        ("case_video", ids[8]),
        ("think_aloud", ids[8]),
    ]


async def test_a_case_still_runs_intro_clip_diagnosis_outro_before_the_next_one(
    client, db, study_of_nine
):
    """Batching moves only the think-aloud; the rest of a case stays together."""
    study_of_nine["study"].think_aloud_batch_size = 3
    await db.flush()

    steps = await _script(client, study_of_nine["participant"].id)
    kinds = [s["kind"] for s in steps]
    first_block = kinds[kinds.index("phase_transition", kinds.index("think_aloud")) :]

    assert first_block[:14] == [
        "phase_transition",
        "case_intro",
        "case_video",
        "diagnosis",
        "case_outro",
        "case_intro",
        "case_video",
        "diagnosis",
        "case_outro",
        "case_intro",
        "case_video",
        "diagnosis",
        "case_outro",
        "think_aloud",
    ]


async def test_a_batched_think_aloud_says_which_case_it_is_about(client, db, study_of_nine):
    """Three recordings in a row need labelling, or the participant cannot tell
    which case they are being asked to narrate."""
    study_of_nine["study"].think_aloud_batch_size = 3
    await db.flush()

    steps = await _script(client, study_of_nine["participant"].id)
    narrations = [s for s in steps if s["kind"] == "think_aloud"]

    first, second, third = narrations[1:4]
    assert (first["case_number"], first["case_total"]) == (1, 7)
    assert (first["batch_position"], first["batch_size"]) == (1, 3)
    assert (second["batch_position"], second["batch_size"]) == (2, 3)
    assert (third["case_number"], third["batch_position"]) == (3, 3)
    assert first["phase_type"] == "training"

    # The pre-test case is a block of one, and says so.
    assert (narrations[0]["batch_position"], narrations[0]["batch_size"]) == (1, 1)
    assert (narrations[0]["case_number"], narrations[0]["case_total"]) == (1, 1)


async def test_the_step_count_is_the_same_however_the_run_is_batched(
    client, db, study_of_nine, monkeypatch
):
    monkeypatch.setattr(get_settings(), "CALIBRATION_ENABLED", True)
    pid = study_of_nine["participant"].id

    unbatched = await _script(client, pid)

    # Straight on the study, since this participant's run has already opened.
    study_of_nine["participant"].think_aloud_batch_size = 4
    await db.flush()
    batched = await _script(client, pid)

    assert len(batched) == len(unbatched) == count_steps(0, NINE, calibration=True)
    assert sorted(s["kind"] for s in batched) == sorted(s["kind"] for s in unbatched)


# --- pinned when the run opens ---------------------------------------------


async def test_the_batch_size_is_pinned_at_first_login(client, db, study_of_nine):
    study_of_nine["study"].think_aloud_batch_size = 3
    await db.flush()

    await _script(client, study_of_nine["participant"].id)

    await db.refresh(study_of_nine["participant"])
    assert study_of_nine["participant"].think_aloud_batch_size == 3


async def test_editing_the_study_does_not_reorder_a_run_already_under_way(
    client, db, study_of_nine
):
    """The severe failure this guards against: a participant mid-sitting whose
    next step silently becomes a different screen."""
    study_of_nine["study"].think_aloud_batch_size = 3
    await db.flush()
    pid = study_of_nine["participant"].id
    before = _case_order(await _script(client, pid))

    study_of_nine["study"].think_aloud_batch_size = 1
    await db.flush()

    assert _case_order(await _script(client, pid)) == before


async def test_a_run_that_started_before_the_setting_follows_the_study(client, db, study_of_nine):
    """Nothing was pinned for them, so they take the study's value — which is
    1, exactly what they have been seeing all along."""
    pid = study_of_nine["participant"].id
    await _script(client, pid)
    study_of_nine["participant"].think_aloud_batch_size = None
    study_of_nine["study"].think_aloud_batch_size = 3
    await db.flush()

    steps = await _script(client, pid)
    ids = [v.id for v in study_of_nine["videos"]]
    assert _case_order(steps)[:4] == [
        ("case_video", ids[0]),
        ("think_aloud", ids[0]),
        ("case_video", ids[1]),
        ("case_video", ids[2]),
    ]


# --- the admin side --------------------------------------------------------


async def test_a_new_study_narrates_every_case_straight_away(client, admin_headers):
    created = await client.post("/admin/studies", json={"name": "Frisch"}, headers=admin_headers)
    assert created.status_code == 201
    assert created.json()["think_aloud_batch_size"] == 1


async def test_the_batch_size_can_be_set_and_read_back(client, admin_headers, seed_study):
    r = await client.patch(
        f"/admin/studies/{seed_study.id}",
        json={"think_aloud_batch_size": 3},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["think_aloud_batch_size"] == 3

    fetched = await client.get(f"/admin/studies/{seed_study.id}", headers=admin_headers)
    assert fetched.json()["think_aloud_batch_size"] == 3


async def test_a_batch_size_below_one_is_refused(client, admin_headers, seed_study):
    for bad in (0, -1, 999):
        r = await client.patch(
            f"/admin/studies/{seed_study.id}",
            json={"think_aloud_batch_size": bad},
            headers=admin_headers,
        )
        assert r.status_code == 422, bad


async def test_the_participant_detail_shows_what_was_pinned(
    client, db, study_of_nine, admin_headers
):
    study_of_nine["study"].think_aloud_batch_size = 2
    await db.flush()
    pid = study_of_nine["participant"].id

    before = await client.get(f"/admin/participants/{pid}", headers=admin_headers)
    assert before.json()["think_aloud_batch_size"] is None

    await _script(client, pid)

    after = await client.get(f"/admin/participants/{pid}", headers=admin_headers)
    assert after.json()["think_aloud_batch_size"] == 2


async def test_the_export_carries_what_each_participant_actually_got(
    client, db, study_of_nine, admin_headers
):
    """It changes what the participant experienced, so it belongs in the data
    an analysis is handed rather than only in the admin."""
    study_of_nine["study"].think_aloud_batch_size = 3
    await db.flush()
    await _script(client, study_of_nine["participant"].id)

    r = await client.get(
        f"/admin/studies/{study_of_nine['study'].id}/export/participants", headers=admin_headers
    )
    assert r.status_code == 200
    # Through a real reader: the sequence column is JSON and carries commas.
    rows = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert rows[0]["participant_id"] == study_of_nine["participant"].id
    assert rows[0]["think_aloud_batch_size"] == "3"


async def test_every_participant_of_a_study_is_pinned_the_same_value(
    client, db, seed_study, study_of_nine
):
    """Two people in one study must not end up on different layouts because
    one of them logged in after an edit — so the edit is the study's decision
    and the pin only protects runs that have already opened."""
    seed_study.think_aloud_batch_size = 3
    db.add(Participant(id="T-002", study_id=seed_study.id))
    await db.flush()

    await _script(client, study_of_nine["participant"].id)
    await _script(client, "T-002")

    pinned = (
        await db.execute(
            select(Participant.think_aloud_batch_size).where(
                Participant.id.in_([study_of_nine["participant"].id, "T-002"])
            )
        )
    ).scalars()
    assert set(pinned) == {3}
