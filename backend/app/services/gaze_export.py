"""Read every committed sample, failing visibly when the stored record is incomplete."""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from app.services.gaze_analysis import GazeLayout, finite_number

RAW_COLUMNS = ["ts", "device_ts", "geometry_ts", "lx", "ly", "rx", "ry", "lv", "rv", "lpd", "rpd"]
DERIVED_COLUMNS = [
    "screen_x",
    "screen_y",
    "screen_px",
    "screen_py",
    "viewport_x",
    "viewport_y",
    "layout_ts",
    "mapping_method",
    "mapping_reason",
    "aoi",
    "aoi_status",
    "active_modal",
]
CONTEXT_COLUMNS = [
    "participant_id",
    "recording_id",
    "video_id",
    "case_number",
    "phase_type",
    "video_title",
    "step_kind",
    "step_index",
    "questionnaire_id",
    "sampling_rate_hz",
    "sample_index",
]
GAZE_COLUMNS = [*CONTEXT_COLUMNS, *RAW_COLUMNS, *DERIVED_COLUMNS]


class GazeStorageError(RuntimeError):
    pass


@contextmanager
def _chunks(recording, settings):
    prefix = recording.storage_prefix
    if not prefix:
        raise GazeStorageError(f"Recording {recording.id}: missing storage prefix.")
    if recording.storage_mode == "local":
        folder = Path(prefix)
        if not folder.is_dir():
            raise GazeStorageError(f"Recording {recording.id}: gaze folder is missing.")
        yield [
            (p.name, lambda path=p: path.open(encoding="utf-8"))
            for p in sorted(folder.glob("chunk_*.ndjson"))
        ]
    elif recording.storage_mode == "gcs":
        if not settings.GCP_BUCKET_NAME:
            raise GazeStorageError(f"Recording {recording.id}: gaze bucket is not configured.")
        from google.cloud import storage

        client = storage.Client()
        try:
            bucket = client.bucket(settings.GCP_BUCKET_NAME)
            yield [
                (blob.name.rsplit("/", 1)[-1], lambda item=blob: item.open("rt", encoding="utf-8"))
                for blob in sorted(bucket.list_blobs(prefix=prefix), key=lambda b: b.name)
                if blob.name.rsplit("/", 1)[-1].startswith("chunk_")
                and blob.name.endswith(".ndjson")
            ]
        finally:
            client.close()
    else:
        raise GazeStorageError(f"Recording {recording.id}: unknown storage mode.")


def iter_samples(recording, settings) -> Iterator[dict[str, Any]]:
    expected = recording.sample_count
    if not expected:
        return
    seen = 0
    try:
        with _chunks(recording, settings) as chunks:
            for name, open_chunk in chunks:
                offset = int(name.removeprefix("chunk_").removesuffix(".ndjson"))
                # A live capture can append after the metadata cursor's snapshot.
                if offset >= expected:
                    continue
                if offset != seen:
                    raise GazeStorageError(
                        f"Recording {recording.id}: missing or overlapping chunk."
                    )
                with open_chunk() as stream:
                    for line in stream:
                        if not line.strip():
                            continue
                        sample = json.loads(line)
                        if not isinstance(sample, dict) or not finite_number(sample.get("ts")):
                            raise GazeStorageError(f"Recording {recording.id}: invalid sample.")
                        seen += 1
                        if seen > expected:
                            raise GazeStorageError(
                                f"Recording {recording.id}: sample count mismatch."
                            )
                        yield sample
        if seen != expected:
            raise GazeStorageError(
                f"Recording {recording.id}: expected {expected} samples, read {seen}."
            )
    except GazeStorageError:
        raise
    except Exception as exc:
        raise GazeStorageError(
            f"Recording {recording.id}: gaze storage could not be read."
        ) from exc


def check_storage(recording, settings) -> None:
    """Catch absent storage before sending a successful download response."""
    if not recording.sample_count:
        return
    try:
        with _chunks(recording, settings) as chunks:
            if not any(name == "chunk_000000000.ndjson" for name, _ in chunks):
                raise GazeStorageError(f"Recording {recording.id}: first gaze chunk is missing.")
    except GazeStorageError:
        raise
    except Exception as exc:
        raise GazeStorageError(
            f"Recording {recording.id}: gaze storage could not be read."
        ) from exc


def csv_batches(recording, settings, case_cells: list, defuse) -> Generator[bytes, None, None]:
    """Bound CSV buffering independently of recording duration or study size."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    layout = GazeLayout(recording.geometry or [])
    context = [
        recording.participant_id,
        recording.id,
        recording.video_id,
        *case_cells,
        recording.step_kind,
        recording.step_index,
        recording.questionnaire_id,
        recording.sampling_rate_hz,
    ]
    for index, sample in enumerate(iter_samples(recording, settings)):
        derived = layout.locate(sample)
        writer.writerow(
            [
                defuse(value)
                for value in [
                    *context,
                    index,
                    *(sample.get(key) for key in RAW_COLUMNS),
                    *(derived.get(key) for key in DERIVED_COLUMNS),
                ]
            ]
        )
        if buffer.tell() >= 64 * 1024:
            yield buffer.getvalue().encode("utf-8")
            buffer.seek(0)
            buffer.truncate(0)
    if buffer.tell():
        yield buffer.getvalue().encode("utf-8")
