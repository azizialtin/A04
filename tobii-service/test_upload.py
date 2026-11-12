"""Delivering a finished capture.

A recording is hundreds of megabytes, so where a bucket exists the bytes go
straight to it and only the metadata comes back through the backend. What these
cover is the part that is easy to get quietly wrong: resuming rather than
restarting after a dropped chunk, and never reporting success for a capture the
bucket did not actually take.
"""

from __future__ import annotations

import json

import httpx
import pytest

import screen_recorder
from screen_recorder import Recording, ScreenRecordingError, upload

SESSION = "https://storage.googleapis.com/upload/session/xyz"


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    """The retry sleeps are real seconds; nothing here needs to wait them out."""
    monkeypatch.setattr(screen_recorder, "UPLOAD_BACKOFF_S", 0.0)


@pytest.fixture
def capture(tmp_path):
    path = tmp_path / "screen.mp4"
    path.write_bytes(b"\0" * (3 * 1024 * 1024))
    return Recording(path=path, epoch_ms=1_700_000_000_000, duration_ms=60_000, fps=30.0)


@pytest.mark.asyncio
async def test_the_bytes_go_to_the_bucket_and_only_metadata_to_the_backend(capture, monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url)))
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "resumable", "upload_url": SESSION})
        if str(request.url) == SESSION:
            return httpx.Response(200)
        if request.url.path.endswith("/complete"):
            return httpx.Response(200, json={"status": "ok"})
        raise AssertionError(f"unexpected {request.method} {request.url}")

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    await upload(
        capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
    )

    # The capture itself never went near the backend.
    assert ("PUT", SESSION) in seen
    assert not any(url.endswith("/upload") and method == "POST" for method, url in seen)


@pytest.mark.asyncio
async def test_a_dropped_chunk_resumes_where_the_bucket_got_to(capture, monkeypatch):
    ranges = []
    dropped = {"done": False}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "resumable", "upload_url": SESSION})
        if request.url.path.endswith("/complete"):
            return httpx.Response(200, json={"status": "ok"})

        content_range = request.headers.get("Content-Range", "")
        if content_range.startswith("bytes */"):
            # The resume query: say a megabyte is already committed.
            return httpx.Response(308, headers={"Range": "bytes=0-1048575"})
        ranges.append(content_range)
        if not dropped["done"]:
            dropped["done"] = True
            raise httpx.ConnectError("connection reset")
        return httpx.Response(200)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    await upload(
        capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
    )

    # Second attempt picks up at the offset the bucket reported, not at zero.
    assert ranges[0].startswith("bytes 0-")
    assert ranges[1].startswith("bytes 1048576-")


@pytest.mark.asyncio
async def test_a_bucket_that_refuses_the_file_is_not_reported_as_stored(capture, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "resumable", "upload_url": SESSION})
        if request.url.path.endswith("/complete"):
            raise AssertionError("completed despite the bucket refusing the bytes")
        return httpx.Response(403, text="denied")

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    with pytest.raises(ScreenRecordingError, match="403"):
        await upload(
            capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
        )


@pytest.mark.asyncio
async def test_a_backend_that_will_not_confirm_is_a_failure_not_a_success(capture, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "resumable", "upload_url": SESSION})
        if request.url.path.endswith("/complete"):
            return httpx.Response(400, text="That file is not a video we can play.")
        return httpx.Response(200)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    with pytest.raises(ScreenRecordingError, match="not a video"):
        await upload(
            capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
        )


@pytest.mark.asyncio
async def test_without_a_bucket_the_file_still_goes_through_the_backend(capture, monkeypatch):
    posted = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "proxy", "upload_url": None})
        posted.append(str(request.url))
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    await upload(
        capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
    )
    assert posted == ["http://api/upload"]


@pytest.mark.asyncio
async def test_an_older_page_that_sends_no_session_urls_still_works(capture, monkeypatch):
    posted = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(str(request.url))
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    await upload(capture, "http://api/upload", "tok")
    assert posted == ["http://api/upload"]


@pytest.mark.asyncio
@pytest.mark.parametrize("bucket", [False, True])
async def test_audio_failure_metadata_survives_both_upload_paths(capture, monkeypatch, bucket):
    capture.audio_status = "failed"
    capture.audio_error = "audio stream interrupted"
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(
                200, json={"mode": "resumable" if bucket else "proxy", "upload_url": SESSION}
            )
        if str(request.url) == SESSION:
            return httpx.Response(200)
        seen.append(request)
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    await upload(
        capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
    )
    assert len(seen) == 1
    if bucket:
        meta = json.loads(seen[0].content)
        assert meta["audio_status"] == "failed"
        assert meta["audio_error"] == "audio stream interrupted"
        assert meta["epoch_ms"] == capture.epoch_ms
    else:
        assert b'name="audio_status"\r\n\r\nfailed' in seen[0].content
        assert b'name="audio_error"\r\n\r\naudio stream interrupted' in seen[0].content


@pytest.mark.asyncio
async def test_an_empty_capture_is_refused_before_anything_is_sent(tmp_path, monkeypatch):
    path = tmp_path / "screen.mp4"
    path.write_bytes(b"")
    empty = Recording(path=path, epoch_ms=1, duration_ms=0, fps=30.0)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "resumable", "upload_url": SESSION})
        raise AssertionError("an empty file should never reach the bucket")

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    with pytest.raises(ScreenRecordingError, match="empty"):
        await upload(
            empty, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
        )


@pytest.mark.asyncio
async def test_missing_bucket_range_restarts_at_zero_without_skipping_bytes(capture, monkeypatch):
    ranges = []

    def handler(request):
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "resumable", "upload_url": SESSION})
        if request.url.path.endswith("/complete"):
            return httpx.Response(200)
        ranges.append(request.headers["Content-Range"])
        return httpx.Response(308 if len(ranges) == 1 else 200)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    await upload(
        capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
    )
    assert len(ranges) == 2
    assert ranges[0] == ranges[1]


@pytest.mark.asyncio
@pytest.mark.parametrize("header", [None, "bytes=0-99", "invalid", "bytes=0-999999999"])
async def test_nonprogressing_or_invalid_bucket_ranges_never_complete(capture, monkeypatch, header):
    count = 0

    def handler(request):
        nonlocal count
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "resumable", "upload_url": SESSION})
        if request.url.path.endswith("/complete"):
            raise AssertionError("failed transfer was reported complete")
        count += 1
        assert count <= 4, "upload loop was not bounded"
        return httpx.Response(308, headers={"Range": header} if header else {})

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    with pytest.raises(ScreenRecordingError, match=r"progress|range"):
        await upload(
            capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
        )


@pytest.mark.asyncio
async def test_transient_bucket_error_resumes_without_authorization_leak(capture, monkeypatch):
    chunks = 0
    queries = 0

    def handler(request):
        nonlocal chunks, queries
        if request.url.path.endswith("/upload-url"):
            return httpx.Response(200, json={"mode": "resumable", "upload_url": SESSION})
        if request.url.path.endswith("/complete"):
            return httpx.Response(200)
        assert "authorization" not in request.headers
        if request.headers["Content-Range"].startswith("bytes */"):
            queries += 1
            return httpx.Response(308)
        chunks += 1
        return httpx.Response(503 if chunks == 1 else 200)

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    await upload(
        capture, "http://api/upload", "tok", "http://api/upload-url", "http://api/complete"
    )
    assert (chunks, queries) == (2, 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("code,expected_attempts", [(503, 3), (403, 1)])
async def test_local_upload_failures_retry_only_transient_errors(
    capture, monkeypatch, code, expected_attempts
):
    count = 0

    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(code, text="refused")

    monkeypatch.setattr(httpx, "AsyncClient", _mock_client(handler))
    with pytest.raises(ScreenRecordingError, match=str(code)):
        await upload(capture, "http://api/upload", "tok")
    assert count == expected_attempts


@pytest.mark.asyncio
async def test_failure_report_rejection_is_visible_in_bridge_log(monkeypatch, capsys):
    monkeypatch.setattr(
        httpx, "AsyncClient", _mock_client(lambda _: httpx.Response(401, text="expired"))
    )
    await screen_recorder.report_failure("http://api/failed", "token", "upload lost")
    message = capsys.readouterr().out
    assert "401" in message and "expired" in message and "upload lost" in message


def _mock_client(handler):
    """An httpx.AsyncClient whose requests are answered by `handler`."""
    real = httpx.AsyncClient

    def build(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    return build
