import copy
import csv
import io
import json
from types import SimpleNamespace

import pytest

from app.models.gaze_recording import GazeRecording
from app.models.questionnaire import Questionnaire
from app.services.gaze_analysis import GazeLayout, averaged_gaze
from app.services.gaze_export import (
    GAZE_COLUMNS,
    GazeStorageError,
    check_storage,
    csv_batches,
    iter_samples,
)

GEOMETRY = {
    "ts": 1000,
    "screen": {"w": 1000, "h": 800},
    "window": {"x": 50, "y": 20, "outer_w": 800, "outer_h": 700, "inner_w": 780, "inner_h": 620},
    "aois": [{"id": "question:q1", "x": 0, "y": 0, "w": 200, "h": 200}],
}
SAMPLE = {
    "ts": 1000,
    "geometry_ts": 1000,
    "lx": 0.1,
    "ly": 0.2,
    "lv": True,
    "rx": 0.8,
    "ry": 0.8,
    "rv": False,
}


def test_only_valid_complete_eye_pairs_are_averaged():
    assert averaged_gaze(SAMPLE) == (0.1, 0.2)
    assert averaged_gaze({"lx": 0.2, "ry": 0.3}) is None
    assert averaged_gaze({**SAMPLE, "lv": False}) is None
    assert averaged_gaze({"lx": float("nan"), "ly": 0.2}) is None
    assert averaged_gaze({"lx": 0.2, "ly": 0.3}) is None


def test_exact_geometry_references_never_reuse_a_stale_missing_or_ambiguous_layout():
    layout = GazeLayout([GEOMETRY])
    assert layout.locate({**SAMPLE, "geometry_ts": 1000})["aoi"] == "question:q1"
    for reference in (None, 999, 1001):
        assert layout.locate({**SAMPLE, "geometry_ts": reference})["aoi"] == "unmapped"
    changed = {**GEOMETRY, "aois": []}
    ambiguous = GazeLayout([GEOMETRY, changed, GEOMETRY])
    assert ambiguous.locate({**SAMPLE, "geometry_ts": 1000})["aoi"] == "unmapped"
    repeated = GazeLayout([GEOMETRY, GEOMETRY])
    assert repeated.locate({**SAMPLE, "geometry_ts": 1000})["aoi"] == "question:q1"


def test_aoi_mapping_respects_browser_chrome_time_priority_and_visibility():
    later = copy.deepcopy(GEOMETRY)
    later["ts"] = 2000
    later["aois"].append({"id": "modal:info", "x": 0, "y": 0, "w": 200, "h": 200, "priority": 5})
    layout = GazeLayout([later, GEOMETRY])
    first = layout.locate(SAMPLE)
    assert (first["viewport_x"], first["viewport_y"], first["aoi"]) == (40, 60, "question:q1")
    assert layout.locate({**SAMPLE, "ts": 999})["aoi"] == "unmapped"
    assert layout.locate({**SAMPLE, "ts": 2000, "geometry_ts": 2000})["aoi"] == "modal:info"
    hidden = {**later, "visible": False}
    assert (
        GazeLayout([hidden]).locate({**SAMPLE, "ts": 2000, "geometry_ts": 2000})["aoi"]
        == "unmapped"
    )


def test_historical_missing_aoi_is_distinct_from_empty_layout_and_invalid_gaze():
    legacy = {key: value for key, value in GEOMETRY.items() if key != "aois"}
    assert GazeLayout([legacy]).locate(SAMPLE)["aoi"] == "unmapped"
    assert GazeLayout([{**GEOMETRY, "aois": []}]).locate(SAMPLE)["aoi"] == "other"
    assert GazeLayout([GEOMETRY]).locate({**SAMPLE, "lv": False})["aoi"] == "invalid"
    assert GazeLayout([GEOMETRY]).locate({**SAMPLE, "lx": 1.2})["aoi"] == "offscreen"
    without_reference = {key: value for key, value in SAMPLE.items() if key != "geometry_ts"}
    historical = GazeLayout([GEOMETRY]).locate(without_reference)
    assert historical["aoi"] == "unmapped"
    assert historical["viewport_x"] == 40


@pytest.mark.parametrize(
    "geometry",
    [
        {**GEOMETRY, "screen": {"w": 0, "h": 800}},
        {**GEOMETRY, "window": None},
        {key: value for key, value in GEOMETRY.items() if key != "window"},
    ],
)
def test_incomplete_geometry_never_produces_aoi_attribution(geometry):
    result = GazeLayout([geometry]).locate(SAMPLE)
    assert result["aoi_status"] == "unmapped"
    assert "viewport_x" not in result and "mapping_method" not in result


def test_gaze_on_display_but_outside_browser_viewport_is_offscreen():
    result = GazeLayout([GEOMETRY]).locate({**SAMPLE, "lx": 0.01})
    assert result["screen_x"] == 0.01 and result["viewport_x"] == -50
    assert result["aoi_status"] == "offscreen"


def test_historical_samples_before_first_layout_have_no_derived_coordinates():
    sample = {key: value for key, value in SAMPLE.items() if key != "geometry_ts"}
    result = GazeLayout([GEOMETRY]).locate({**sample, "ts": 999})
    assert result["aoi_status"] == "unmapped"
    assert "viewport_x" not in result and "layout_ts" not in result


@pytest.mark.parametrize(
    "changed", [{"scale": 2}, {"scale": 0.8}, {"x": 10}, {"x": -1}, {"y": 20}, {"y": -1}]
)
def test_visual_zoom_or_pan_refuses_aoi_but_preserves_candidate_coordinates(changed):
    viewport = {"scale": 1, "x": 0, "y": 0, "w": 780, "h": 620, **changed}
    result = GazeLayout([{**GEOMETRY, "visual_viewport": viewport}]).locate(SAMPLE)
    assert result["aoi"] == result["aoi_status"] == "unmapped"
    assert result["mapping_reason"] == "unsupported_visual_viewport"
    assert result["mapping_method"] == "window_estimate"
    assert (result["screen_x"], result["viewport_x"], result["viewport_y"]) == (0.1, 40, 60)


def test_known_multiple_displays_refuse_aoi_even_when_window_is_on_primary_display():
    geometry = {**GEOMETRY, "screen": {**GEOMETRY["screen"], "is_extended": True}}
    result = GazeLayout([geometry]).locate(SAMPLE)
    assert result["aoi_status"] == "unmapped"
    assert result["mapping_reason"] == "multiple_displays"
    assert result["viewport_x"] == 40


@pytest.mark.parametrize("position", [{"x": 1000}, {"x": -800}, {"y": 800}, {"y": -700}])
def test_window_entirely_outside_assumed_display_is_unmapped_instead_of_offscreen(position):
    geometry = {**GEOMETRY, "window": {**GEOMETRY["window"], **position}}
    result = GazeLayout([geometry]).locate(SAMPLE)
    assert result["aoi"] == result["aoi_status"] == "unmapped"
    assert result["mapping_reason"] == "window_outside_screen"
    assert result["mapping_method"] == "window_estimate"


@pytest.mark.parametrize("extension_signal", [{}, {"is_extended": None}, {"is_extended": False}])
def test_absent_or_false_extension_signal_keeps_legacy_estimate_without_claiming_verification(
    extension_signal,
):
    geometry = {
        **GEOMETRY,
        "screen": {**GEOMETRY["screen"], **extension_signal},
        "visual_viewport": {"scale": 1, "x": 0, "y": 0, "w": 780, "h": 620},
    }
    result = GazeLayout([geometry]).locate(SAMPLE)
    assert result["aoi"] == "question:q1"
    assert result["mapping_method"] == "window_estimate"
    assert result["mapping_reason"] is None


def recording(tmp_path, samples, **overrides):
    folder = tmp_path / "chunks"
    folder.mkdir(exist_ok=True)
    (folder / "chunk_000000000.ndjson").write_text("".join(json.dumps(s) + "\n" for s in samples))
    return SimpleNamespace(
        id=1,
        storage_mode="local",
        storage_prefix=str(folder),
        sample_count=len(samples),
        **overrides,
    )


def test_raw_reader_uses_recording_mode_and_preserves_every_sample(tmp_path):
    samples = [{**SAMPLE, "ts": 1000 + i} for i in range(9000)]
    rec = recording(tmp_path, samples)
    assert list(iter_samples(rec, SimpleNamespace(GAZE_STORAGE_MODE="gcs"))) == samples


def test_csv_stream_keeps_native_samples_in_small_buffers_and_live_appends_are_ignored(tmp_path):
    samples = [{**SAMPLE, "ts": 1000 + i} for i in range(9000)]
    rec = recording(
        tmp_path,
        samples,
        participant_id="P1",
        video_id=None,
        step_kind="questionnaire",
        step_index=1,
        questionnaire_id=2,
        sampling_rate_hz=120,
        geometry=[GEOMETRY],
    )
    (tmp_path / "chunks" / "chunk_000009000.ndjson").write_text(json.dumps(SAMPLE) + "\n")
    chunks = list(csv_batches(rec, SimpleNamespace(), [None, "", ""], lambda value: value))
    assert len(chunks) > 1 and max(map(len, chunks)) < 66_000
    assert len(list(csv.reader(io.StringIO(b"".join(chunks).decode())))) == 9000


def test_raw_csv_explains_unsupported_mapping_without_losing_raw_signals(tmp_path):
    rec = recording(
        tmp_path,
        [SAMPLE],
        participant_id="P1",
        video_id=None,
        step_kind="questionnaire",
        step_index=1,
        questionnaire_id=2,
        sampling_rate_hz=120,
        geometry=[{**GEOMETRY, "screen": {**GEOMETRY["screen"], "is_extended": True}}],
    )
    body = b"".join(csv_batches(rec, SimpleNamespace(), [None, "", ""], lambda value: value))
    row = dict(zip(GAZE_COLUMNS, next(csv.reader(io.StringIO(body.decode()))), strict=True))
    assert row["aoi"] == row["aoi_status"] == "unmapped"
    assert row["mapping_reason"] == "multiple_displays"
    assert row["mapping_method"] == "window_estimate"
    assert row["lx"] == "0.1" and row["rx"] == "0.8" and row["rv"] == "False"
    assert row["geometry_ts"] == "1000" and row["viewport_x"] == "40.0"


def test_gcs_reader_uses_each_recordings_mode_and_streams_objects(tmp_path, monkeypatch):
    from google.cloud import storage

    class Blob:
        name = "gaze/P1/1/chunk_000000000.ndjson"

        def open(self, mode, encoding):
            assert mode == "rt" and encoding == "utf-8"
            return io.StringIO(json.dumps(SAMPLE) + "\n")

    closed = []
    bucket = SimpleNamespace(list_blobs=lambda prefix: [Blob()])
    monkeypatch.setattr(
        storage,
        "Client",
        lambda: SimpleNamespace(bucket=lambda name: bucket, close=lambda: closed.append(True)),
    )
    rec = SimpleNamespace(id=1, sample_count=1, storage_mode="gcs", storage_prefix="gaze/P1/1/")
    assert list(
        iter_samples(rec, SimpleNamespace(GCP_BUCKET_NAME="test", GAZE_STORAGE_MODE="local"))
    ) == [SAMPLE]
    assert closed == [True]


@pytest.mark.parametrize("operation", ["preflight", "stream"])
def test_gcs_listing_failure_is_explicit_and_closes_client(monkeypatch, operation):
    from google.cloud import storage

    def unavailable(*, prefix):
        raise OSError("storage listing unavailable")

    closed = []
    monkeypatch.setattr(
        storage,
        "Client",
        lambda: SimpleNamespace(
            bucket=lambda name: SimpleNamespace(list_blobs=unavailable),
            close=lambda: closed.append(True),
        ),
    )
    rec = SimpleNamespace(id=1, sample_count=1, storage_mode="gcs", storage_prefix="gaze/P1/1/")
    settings = SimpleNamespace(GCP_BUCKET_NAME="test")
    with pytest.raises(GazeStorageError, match="gaze storage could not be read"):
        if operation == "preflight":
            check_storage(rec, settings)
        else:
            list(iter_samples(rec, settings))
    assert closed == [True]


@pytest.mark.parametrize(
    ("mode", "prefix", "message"),
    [
        ("local", None, "missing storage prefix"),
        ("local", "missing-directory", "gaze folder is missing"),
        ("gcs", "gaze/P1/1/", "gaze bucket is not configured"),
        ("unknown", "gaze/P1/1/", "unknown storage mode"),
    ],
)
def test_preflight_rejects_unavailable_recording_storage(tmp_path, mode, prefix, message):
    if prefix == "missing-directory":
        prefix = str(tmp_path / prefix)
    rec = SimpleNamespace(id=1, sample_count=1, storage_mode=mode, storage_prefix=prefix)
    with pytest.raises(GazeStorageError, match=message):
        check_storage(rec, SimpleNamespace(GCP_BUCKET_NAME=""))


def test_empty_recording_needs_no_storage_and_trailing_blank_lines_are_ignored(tmp_path):
    empty = SimpleNamespace(id=1, sample_count=0, storage_mode="gcs", storage_prefix=None)
    check_storage(empty, SimpleNamespace())
    assert list(iter_samples(empty, SimpleNamespace())) == []
    rec = recording(tmp_path, [SAMPLE])
    chunk = tmp_path / "chunks" / "chunk_000000000.ndjson"
    with chunk.open("a") as stream:
        stream.write("\n \n")
    assert list(iter_samples(rec, SimpleNamespace())) == [SAMPLE]


@pytest.mark.parametrize("sample", [[], None, {}, {"ts": True}, {"ts": "1000"}, {"ts": None}])
def test_raw_reader_rejects_non_sample_objects_and_invalid_timestamps(tmp_path, sample):
    rec = recording(tmp_path, [sample])
    with pytest.raises(GazeStorageError, match="invalid sample"):
        list(iter_samples(rec, SimpleNamespace()))


def test_raw_reader_rejects_rows_beyond_committed_count(tmp_path):
    rec = recording(tmp_path, [SAMPLE, SAMPLE])
    rec.sample_count = 1
    with pytest.raises(GazeStorageError, match="sample count mismatch"):
        list(iter_samples(rec, SimpleNamespace()))


@pytest.mark.parametrize("damage", ["missing", "corrupt", "count", "gap"])
def test_raw_reader_refuses_incomplete_or_corrupt_data(tmp_path, damage):
    rec = recording(tmp_path, [SAMPLE])
    chunk = tmp_path / "chunks" / "chunk_000000000.ndjson"
    if damage == "missing":
        chunk.unlink()
    elif damage == "corrupt":
        chunk.write_text("{broken}")
    elif damage == "count":
        rec.sample_count = 2
    else:
        chunk.rename(chunk.with_name("chunk_000000001.ndjson"))
    with pytest.raises(GazeStorageError):
        list(iter_samples(rec, SimpleNamespace()))


async def test_questionnaire_gaze_is_authorized_and_visible_in_admin(
    client, db, seed_study, seed_participant, participant_headers, admin_headers
):
    question = Questionnaire(study_id=seed_study.id, placement="pre_test", title="Page")
    db.add(question)
    await db.flush()
    response = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={
            "step_kind": "questionnaire",
            "step_index": 1,
            "questionnaire_id": question.id,
            "sampling_rate_hz": 120,
            "geometry": GEOMETRY,
        },
    )
    assert response.status_code == 201
    rec = await db.get(GazeRecording, response.json()["recording_id"])
    assert rec.video_id is None and rec.step_kind == "questionnaire"
    rows = (await client.get("/admin/gaze/recordings", headers=admin_headers)).json()["items"]
    assert rows[0]["questionnaire_title"] == "Page"
    assert rows[0]["replay_available"] is False and rows[0]["screen"] is None
    replay = await client.get(f"/admin/gaze/recordings/{rec.id}/replay", headers=admin_headers)
    assert replay.status_code == 404
    forbidden = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={
            "step_kind": "questionnaire",
            "questionnaire_id": question.id + 99,
            "sampling_rate_hz": 120,
        },
    )
    assert forbidden.status_code == 404


async def test_raw_export_has_samples_context_aoi_and_explicit_storage_failure(
    client, db, seed_study, seed_participant, admin_headers, tmp_path
):
    stored = recording(tmp_path, [SAMPLE, {**SAMPLE, "ts": 1001, "lv": False}])
    rec = GazeRecording(
        participant_id=seed_participant.id,
        video_id=None,
        step_kind="questionnaire",
        step_index=1,
        sample_count=2,
        storage_mode="local",
        storage_prefix=stored.storage_prefix,
        geometry=[GEOMETRY],
    )
    db.add(rec)
    await db.flush()
    response = await client.get(
        f"/admin/studies/{seed_study.id}/export/gaze", headers=admin_headers
    )
    assert response.status_code == 200
    assert response.content.startswith(b"\xef\xbb\xbf")
    rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert len(rows) == 2
    assert rows[0]["step_kind"] == "questionnaire" and rows[0]["video_id"] == ""
    assert rows[0]["aoi"] == "question:q1" and rows[1]["aoi"] == "invalid"
    assert rows[0]["rx"] == "0.8" and rows[0]["rv"] == "False"
    counts = (
        await client.get(f"/admin/studies/{seed_study.id}/exports", headers=admin_headers)
    ).json()
    by_kind = {r["kind"]: r for r in counts}
    assert by_kind["gaze"]["rows"] == 2 and by_kind["gaze_recordings"]["rows"] == 1
    (tmp_path / "chunks" / "chunk_000000000.ndjson").unlink()
    missing = await client.get(f"/admin/studies/{seed_study.id}/export/gaze", headers=admin_headers)
    assert missing.status_code == 503
    assert "first gaze chunk is missing" in missing.json()["detail"]


async def test_corrupt_raw_chunk_aborts_download_instead_of_returning_partial_csv(
    client, db, seed_study, seed_participant, admin_headers, tmp_path
):
    stored = recording(tmp_path, [SAMPLE])
    rec = GazeRecording(
        participant_id=seed_participant.id,
        sample_count=1,
        step_kind="questionnaire",
        storage_prefix=stored.storage_prefix,
    )
    db.add(rec)
    await db.flush()
    (tmp_path / "chunks" / "chunk_000000000.ndjson").write_text("invalid json\n")
    with pytest.raises(GazeStorageError, match="could not be read"):
        await client.get(f"/admin/studies/{seed_study.id}/export/gaze", headers=admin_headers)
