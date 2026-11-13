"""A short hardware check that records counts, never gaze positions."""

from __future__ import annotations

import asyncio
import contextlib

from gaze_source import TobiiSource


async def diagnose_tracker(seconds=8.0, *, sdk=None):
    source = TobiiSource(sdk)

    class CounterSink:
        async def send(self, _message):
            pass

    task = asyncio.create_task(source.stream(CounterSink()))
    try:
        await asyncio.sleep(seconds)
        report = source.status()
        report.pop("type")
        report["duration_seconds"] = seconds
        report["ok"] = source.valid_sample_count > 0
        if not source.sample_count and source.connected and report["error_code"] is None:
            report["error_code"] = "no_samples"
            report["error"] = "The tracker was found but no gaze samples arrived during the check."
        elif source.sample_count and not source.valid_sample_count:
            report["error_code"] = "invalid_samples"
            report["error"] = (
                "Gaze samples arrived but neither eye was valid. Look at the calibrated display and check participant position."
            )
        report["compatibility_note"] = (
            "The tracker model must be supported by this SDK version. SDK 2.x does not support every older Tobii Pro model; "
            "Spectrum also requires the Tobii Pro network runtime. Check Eye Tracker Manager and the model's SDK requirements."
        )
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await source.close()
    if source.error_code == "unsubscribe_failed":
        report.update(ok=False, error_code=source.error_code, error=source.error)
    return report
