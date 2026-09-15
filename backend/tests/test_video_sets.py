"""Two fixed video orders per study, dealt out half and half.

The researcher builds the sets; a participant with no hand-picked sequence is
dealt one at first login, and the deal is balanced rather than left to chance.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import func, select

from app.models.enums import ParticipantStatus, PhaseType
from app.models.participant import Participant
from app.models.participant_video import ParticipantVideo
from app.models.video import Video
from app.models.video_set import VideoSet, VideoSetItem
from app.services import video_sets
from app.services.video_sets import pick_balanced

PHASES = [PhaseType.pre_test, PhaseType.training, PhaseType.training, PhaseType.post_test]


@pytest_asyncio.fixture
async def videos(db, seed_study):
    made = []
    for i, phase in enumerate(PHASES):
        v = Video(
            study_id=seed_study.id, title=f"Case {i}", phase_type=phase, gcp_filename=f"{i}.mp4"
        )
        db.add(v)
        made.append(v)
    await db.flush()
    return made


def _items(videos, order):
    return [
        {"video_id": videos[i].id, "slot_index": slot, "phase_type": videos[i].phase_type.value}
        for slot, i in enumerate(order)
    ]


@pytest_asyncio.fixture
async def two_sets(db, seed_study, videos):
    """Set A runs the training clips one way round, set B the other."""
    a = VideoSet(study_id=seed_study.id, name="A")
    b = VideoSet(study_id=seed_study.id, name="B")
    db.add_all([a, b])
    await db.flush()
    for video_set, order in ((a, [0, 1, 2, 3]), (b, [0, 2, 1, 3])):
        for slot, i in enumerate(order):
            db.add(
                VideoSetItem(
                    video_set_id=video_set.id,
                    video_id=videos[i].id,
                    slot_index=slot,
                    phase_type=videos[i].phase_type,
                )
            )
    await db.flush()
    return {"A": a, "B": b}


class _Coin:
    """A rigged tie-break, so the test can say which way the toss goes."""

    def __init__(self, *picks: int) -> None:
        self.picks = list(picks)
        self.tosses = 0

    def choice(self, seq):
        self.tosses += 1
        return seq[self.picks.pop(0) if self.picks else 0]


@pytest.fixture
def coin(monkeypatch):
    rigged = _Coin()
    monkeypatch.setattr(video_sets, "rng", rigged)
    return rigged


async def _login(client, pid: str) -> dict[str, str]:
    r = await client.post("/auth/participant/login", json={"participant_id": pid})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def _sequence(db, pid: str) -> list[int]:
    return list(
        (
            await db.execute(
                select(ParticipantVideo.video_id)
                .where(ParticipantVideo.participant_id == pid)
                .order_by(ParticipantVideo.slot_index)
            )
        )
        .scalars()
        .all()
    )


# --- the deal --------------------------------------------------------------


def test_the_least_dealt_set_goes_next():
    a, b = VideoSet(id=1, name="A"), VideoSet(id=2, name="B")
    assert pick_balanced([a, b], {1: 3, 2: 2}) is b
    assert pick_balanced([a, b], {1: 1}) is b  # never dealt at all counts as zero
    assert pick_balanced([], {}) is None


def test_a_tie_is_a_coin_toss(coin):
    a, b = VideoSet(id=1, name="A"), VideoSet(id=2, name="B")
    coin.picks = [1]
    assert pick_balanced([a, b], {1: 2, 2: 2}) is b
    assert coin.tosses == 1


async def test_first_login_deals_a_set_and_copies_its_order(
    client, db, seed_participant, two_sets, videos, coin
):
    coin.picks = [1]  # the toss says B
    await _login(client, seed_participant.id)

    await db.refresh(seed_participant)
    assert seed_participant.video_set_id == two_sets["B"].id
    assert seed_participant.status == ParticipantStatus.active
    assert await _sequence(db, seed_participant.id) == [videos[i].id for i in (0, 2, 1, 3)]


async def test_participants_end_up_half_and_half(client, db, seed_study, two_sets, coin):
    ids = [f"P-{i}" for i in range(6)]
    db.add_all(Participant(id=pid, study_id=seed_study.id) for pid in ids)
    await db.flush()

    # Whatever the coin does at each tie, the count can never drift past one.
    coin.picks = [0, 0, 1, 1, 0, 0]
    for pid in ids:
        await _login(client, pid)

    dealt = [
        p.video_set_id
        for p in (await db.execute(select(Participant).where(Participant.id.in_(ids)))).scalars()
    ]
    assert dealt.count(two_sets["A"].id) == 3
    assert dealt.count(two_sets["B"].id) == 3
    # Only the first of each pair was a toss; the second was forced.
    assert coin.tosses == 3


async def test_the_run_follows_the_dealt_set(client, seed_participant, two_sets, videos, coin):
    coin.picks = [1]
    headers = await _login(client, seed_participant.id)
    steps = (await client.get("/participant/session", headers=headers)).json()["steps"]
    clips = [s["video_id"] for s in steps if s["kind"] == "case_video"]
    assert clips == [videos[i].id for i in (0, 2, 1, 3)]


async def test_a_hand_picked_sequence_is_not_replaced(
    client, db, seed_participant, two_sets, videos
):
    db.add(
        ParticipantVideo(
            participant_id=seed_participant.id,
            video_id=videos[3].id,
            slot_index=0,
            phase_type=PhaseType.post_test,
        )
    )
    await db.flush()

    await _login(client, seed_participant.id)

    await db.refresh(seed_participant)
    assert seed_participant.video_set_id is None
    assert await _sequence(db, seed_participant.id) == [videos[3].id]


async def test_a_second_login_does_not_deal_again(client, db, seed_participant, two_sets, coin):
    coin.picks = [0, 1]
    await _login(client, seed_participant.id)
    await _login(client, seed_participant.id)
    await db.refresh(seed_participant)
    assert seed_participant.video_set_id == two_sets["A"].id
    assert coin.tosses == 1


async def test_a_study_without_sets_runs_as_before(client, db, seed_participant, videos):
    headers = await _login(client, seed_participant.id)
    await db.refresh(seed_participant)
    assert seed_participant.video_set_id is None
    assert await _sequence(db, seed_participant.id) == []
    # The study default: every video, phase order.
    steps = (await client.get("/participant/session", headers=headers)).json()["steps"]
    assert len([s for s in steps if s["kind"] == "case_video"]) == len(videos)


async def test_an_empty_set_is_never_dealt(client, db, seed_study, seed_participant, two_sets):
    db.add(VideoSet(study_id=seed_study.id, name="leer"))
    await db.flush()
    for _ in range(3):
        pid = f"E-{_}"
        db.add(Participant(id=pid, study_id=seed_study.id))
        await db.flush()
        await _login(client, pid)
    names = set(
        (
            await db.execute(
                select(VideoSet.name)
                .join(Participant, Participant.video_set_id == VideoSet.id)
                .where(Participant.study_id == seed_study.id)
            )
        ).scalars()
    )
    assert "leer" not in names


# --- the admin side --------------------------------------------------------


async def test_a_set_can_be_built_and_read_back(client, seed_study, videos, admin_headers):
    r = await client.post(
        f"/admin/studies/{seed_study.id}/video-sets",
        json={"name": "A", "items": _items(videos, [0, 2, 1, 3])},
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "A"
    assert [i["video_id"] for i in body["items"]] == [videos[i].id for i in (0, 2, 1, 3)]
    assert body["items"][1]["video_title"] == "Case 2"
    assert body["participant_count"] == 0

    listed = (
        await client.get(f"/admin/studies/{seed_study.id}/video-sets", headers=admin_headers)
    ).json()
    assert [s["name"] for s in listed] == ["A"]


async def test_a_set_cannot_borrow_another_studys_clip(
    client, db, seed_researcher, seed_study, admin_headers
):
    from app.models.study import Study

    other = Study(name="Other", created_by=seed_researcher.id)
    db.add(other)
    await db.flush()
    foreign = Video(study_id=other.id, title="Not ours", phase_type=PhaseType.training)
    db.add(foreign)
    await db.flush()

    r = await client.post(
        f"/admin/studies/{seed_study.id}/video-sets",
        json={
            "name": "A",
            "items": [{"video_id": foreign.id, "slot_index": 0, "phase_type": "training"}],
        },
        headers=admin_headers,
    )
    assert r.status_code == 400


async def test_two_sets_cannot_share_a_name(client, seed_study, two_sets, admin_headers):
    r = await client.post(
        f"/admin/studies/{seed_study.id}/video-sets",
        json={"name": "A", "items": []},
        headers=admin_headers,
    )
    assert r.status_code == 400


async def test_editing_a_set_leaves_started_runs_alone(
    client, db, seed_participant, two_sets, videos, admin_headers, coin
):
    coin.picks = [0]  # A
    await _login(client, seed_participant.id)
    before = await _sequence(db, seed_participant.id)

    r = await client.put(
        f"/admin/video-sets/{two_sets['A'].id}",
        json={"items": _items(videos, [3, 2, 1, 0])},
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert [i["video_id"] for i in r.json()["items"]] == [videos[i].id for i in (3, 2, 1, 0)]
    assert await _sequence(db, seed_participant.id) == before


async def test_deleting_a_set_keeps_the_participants_copy(
    client, db, seed_participant, two_sets, admin_headers, coin
):
    coin.picks = [0]
    await _login(client, seed_participant.id)
    before = await _sequence(db, seed_participant.id)

    # Refused first: the label is the condition the study is analysed against.
    refused = await client.delete(f"/admin/video-sets/{two_sets['A'].id}", headers=admin_headers)
    assert refused.status_code == 409

    r = await client.delete(
        f"/admin/video-sets/{two_sets['A'].id}?force=true", headers=admin_headers
    )
    assert r.status_code == 200

    await db.refresh(seed_participant)
    assert seed_participant.video_set_id is None
    assert await _sequence(db, seed_participant.id) == before


async def test_a_set_nobody_ran_is_deleted_without_ceremony(
    client, seed_study, two_sets, admin_headers
):
    r = await client.delete(f"/admin/video-sets/{two_sets['A'].id}", headers=admin_headers)
    assert r.status_code == 200


async def test_a_clip_cannot_appear_twice_in_one_set(client, seed_study, videos, admin_headers):
    """Notes, the diagnosis and the recordings are keyed by (participant,
    video), so a repeat would overwrite the first showing rather than be a
    second case."""
    r = await client.post(
        f"/admin/studies/{seed_study.id}/video-sets",
        json={"name": "Doppelt", "items": _items(videos, [0, 1, 1, 3])},
        headers=admin_headers,
    )
    assert r.status_code == 400
    assert "once" in r.json()["detail"]


async def test_a_clip_cannot_appear_twice_in_a_hand_picked_sequence(
    client, seed_participant, videos, admin_headers
):
    r = await client.put(
        f"/admin/participants/{seed_participant.id}/videos",
        json={"items": _items(videos, [2, 2])},
        headers=admin_headers,
    )
    assert r.status_code == 400


async def test_a_set_needs_a_name_that_is_not_blank(client, seed_study, admin_headers):
    r = await client.post(
        f"/admin/studies/{seed_study.id}/video-sets",
        json={"name": "   ", "items": []},
        headers=admin_headers,
    )
    assert r.status_code == 400


async def test_a_clip_in_a_set_cannot_be_deleted(client, two_sets, videos, admin_headers):
    r = await client.delete(f"/admin/videos/{videos[1].id}", headers=admin_headers)
    assert r.status_code == 409


async def test_a_study_that_has_sets_can_still_be_deleted(
    client, db, seed_study, seed_participant, two_sets, admin_headers, coin
):
    """A set holds its clips with RESTRICT, so the sets have to go before the
    videos do — otherwise the whole study becomes undeletable."""
    await _login(client, seed_participant.id)

    r = await client.delete(f"/admin/studies/{seed_study.id}?force=true", headers=admin_headers)
    assert r.status_code == 200, r.text

    from app.models.study import Study

    db.expire_all()
    assert await db.get(Study, seed_study.id) is None
    assert await db.get(VideoSet, two_sets["A"].id) is None
    assert (
        await db.scalar(
            select(func.count())
            .select_from(VideoSetItem)
            .where(VideoSetItem.video_set_id.in_([two_sets["A"].id, two_sets["B"].id]))
        )
    ) == 0


async def test_the_admin_can_deal_a_set_by_hand(
    client, db, seed_participant, two_sets, videos, admin_headers
):
    r = await client.put(
        f"/admin/participants/{seed_participant.id}/video-set",
        json={"video_set_id": two_sets["B"].id},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok", "slot_count": 4, "video_set_name": "B"}
    assert await _sequence(db, seed_participant.id) == [videos[i].id for i in (0, 2, 1, 3)]

    # Logging in afterwards keeps what the researcher chose.
    await _login(client, seed_participant.id)
    await db.refresh(seed_participant)
    assert seed_participant.video_set_id == two_sets["B"].id

    # And the deal counts them from then on.
    listed = (
        await client.get(
            f"/admin/studies/{seed_participant.study_id}/video-sets", headers=admin_headers
        )
    ).json()
    assert {s["name"]: s["participant_count"] for s in listed} == {"A": 0, "B": 1}


async def test_a_started_participant_cannot_be_redealt(
    client, seed_participant, two_sets, admin_headers, coin
):
    await _login(client, seed_participant.id)
    r = await client.put(
        f"/admin/participants/{seed_participant.id}/video-set",
        json={"video_set_id": two_sets["B"].id},
        headers=admin_headers,
    )
    assert r.status_code == 409


async def test_hand_picking_a_sequence_drops_the_set_label(
    client, db, seed_participant, two_sets, videos, admin_headers
):
    await client.put(
        f"/admin/participants/{seed_participant.id}/video-set",
        json={"video_set_id": two_sets["A"].id},
        headers=admin_headers,
    )
    r = await client.put(
        f"/admin/participants/{seed_participant.id}/videos",
        json={"items": _items(videos, [3])},
        headers=admin_headers,
    )
    assert r.status_code == 200
    await db.refresh(seed_participant)
    assert seed_participant.video_set_id is None


async def test_the_participant_list_and_export_name_the_set(
    client, db, seed_study, seed_participant, two_sets, coin
):
    coin.picks = [1]
    await _login(client, seed_participant.id)
    admin = {
        "Authorization": "Bearer "
        + (
            await client.post(
                "/auth/admin/login",
                json={"email": "researcher@a04.test", "password": "testpassword12"},
            )
        ).json()["access_token"]
    }

    rows = (await client.get(f"/admin/studies/{seed_study.id}/participants", headers=admin)).json()
    assert rows[0]["video_set_name"] == "B"
    assert rows[0]["slot_count"] == 4

    detail = (await client.get(f"/admin/participants/{seed_participant.id}", headers=admin)).json()
    assert detail["video_set_name"] == "B"

    stats = (await client.get(f"/admin/studies/{seed_study.id}/stats", headers=admin)).json()
    assert stats["roster"][0]["video_set"] == "B"
    assert stats["roster"][0]["cases"] == 4

    mine = (
        await client.get(f"/admin/participants/{seed_participant.id}/stats", headers=admin)
    ).json()
    assert mine["session"]["video_set"] == "B"

    export = await client.get(f"/admin/studies/{seed_study.id}/export/participants", headers=admin)
    assert export.status_code == 200
    line = export.content.decode("utf-8-sig").splitlines()[1]
    assert line.startswith("T-001,active,")
    assert ",B," in line


async def test_the_roster_counts_a_set_length_for_the_not_yet_dealt(
    client, db, seed_study, seed_participant, two_sets, videos, admin_headers
):
    # Four clips in a set; the study holds the same four, so add a fifth the
    # sets do not use to tell the two estimates apart.
    db.add(Video(study_id=seed_study.id, title="Spare", phase_type=PhaseType.training))
    await db.flush()
    stats = (
        await client.get(f"/admin/studies/{seed_study.id}/stats", headers=admin_headers)
    ).json()
    assert stats["roster"][0]["cases"] == 4
    assert stats["roster"][0]["video_set"] is None
