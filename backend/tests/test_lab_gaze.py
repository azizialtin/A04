import csv
import io

import pytest

from app.models.enums import PhaseType
from app.models.gaze_recording import GazeRecording
from app.models.video import Video
from app.services import storage


@pytest.mark.parametrize("dpr", [1, 1.25, 1.5])
async def test_120hz_lab_samples_survive_chunk_retry_csv_and_clip_mapping(
    client, db, seed_study, participant_headers, admin_headers, tmp_path, monkeypatch, dpr
):
    monkeypatch.setattr(storage, "UPLOADS", tmp_path)
    video = Video(
        study_id=seed_study.id, title="Lab", phase_type=PhaseType.training, gcp_filename="lab.mp4"
    )
    db.add(video)
    await db.flush()
    base = 1_700_000_000_000
    areas = [
        {"id": "video", "x": 0, "y": 0, "w": 1440, "h": 1080},
        {"id": "notes", "x": 1440, "y": 300, "w": 480, "h": 600},
        {"id": "timer", "x": 1440, "y": 0, "w": 480, "h": 300},
    ]
    geometry = {
        "ts": base,
        "screen": {"w": 1920 / dpr, "h": 1080 / dpr, "is_extended": False},
        "window": {
            "x": 0,
            "y": 0,
            "outer_w": 1920 / dpr,
            "inner_w": 1920 / dpr,
            "outer_h": 1080 / dpr,
            "inner_h": 1080 / dpr,
        },
        "visual_viewport": {"x": 0, "y": 0, "w": 1920 / dpr, "h": 1080 / dpr, "scale": 1},
        "dpr": dpr,
        "video": {"x": 0, "y": 0, "w": 1440 / dpr, "h": 1080 / dpr},
        "frame": {"w": 1440, "h": 1080},
        "aois": [
            {
                key: value / dpr if key in {"x", "y", "w", "h"} else value
                for key, value in area.items()
            }
            for area in areas
        ],
    }
    started = await client.post(
        "/gaze/recordings",
        headers=participant_headers,
        json={"video_id": video.id, "sampling_rate_hz": 120, "geometry": geometry},
    )
    assert started.status_code == 201
    recording_id = started.json()["recording_id"]
    samples = []
    for index in range(1200):
        area = areas[index % len(areas)]
        x, y = (area["x"] + area["w"] / 2) / 1920, (area["y"] + area["h"] / 2) / 1080
        samples.append(
            {
                "ts": base + index * 1000 // 120,
                "device_ts": 1_000_000 + index * 1_000_000 // 120,
                "geometry_ts": base,
                "lx": x,
                "ly": y,
                "rx": x,
                "ry": y,
                "lv": index % 4 != 3,
                "rv": index % 4 != 2,
                "lpd": 3.1,
                "rpd": 3.2,
            }
        )
    for offset in (0, 600, 0):
        result = await client.post(
            f"/gaze/recordings/{recording_id}/samples",
            headers=participant_headers,
            json={"offset": offset, "samples": samples[offset : offset + 600]},
        )
        assert result.status_code == 200, result.text
    assert result.json()["duplicate"] is True
    complete = await client.patch(
        f"/gaze/recordings/{recording_id}/complete",
        headers=participant_headers,
        json={"sample_count": 1200},
    )
    assert complete.status_code == 200
    recording = await db.get(GazeRecording, recording_id)
    assert (recording.sample_count, recording.sampling_rate_hz) == (1200, 120)
    export = await client.get(f"/admin/studies/{seed_study.id}/export/gaze", headers=admin_headers)
    assert export.status_code == 200
    rows = list(csv.DictReader(io.StringIO(export.content.decode("utf-8-sig"))))
    assert len(rows) == len(samples) == 1200
    for index, (sample, row) in enumerate(zip(samples, rows, strict=True)):
        assert row["aoi"] == areas[index % len(areas)]["id"] and row["aoi_status"] == "matched"
        assert row["sampling_rate_hz"] == "120" and int(row["sample_index"]) == index
        for key in ("ts", "device_ts", "geometry_ts"):
            assert int(row[key]) == sample[key]
        assert (float(row["lpd"]), float(row["rpd"])) == (3.1, 3.2)
    assert len(list((tmp_path / "gaze").rglob("chunk_*.ndjson"))) == 2
    for event_type, ts, position in (
        ("video_started", base, 0),
        ("video_completed", base + 10_000, 10),
    ):
        assert (
            await client.post(
                "/participant/events",
                headers=participant_headers,
                json={
                    "video_id": video.id,
                    "event_type": event_type,
                    "client_ts": ts,
                    "payload": {"currentTime": position},
                },
            )
        ).status_code == 202
    replay = await client.get(f"/gaze/videos/{video.id}/replay", headers=participant_headers)
    assert replay.status_code == 200, replay.text
    body = replay.json()
    assert body["source"] == "clip" and body["sampling_rate_hz"] == 120
    assert (
        body["plotted_points"],
        body["offscreen_samples"],
        body["invalid_samples"],
        body["unmapped_samples"],
    ) == (400, 800, 0, 0)
    assert all(point["x"] == 0.5 and point["y"] == 0.5 for point in body["points"])
