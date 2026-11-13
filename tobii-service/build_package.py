r"""Builds the one-click Windows package the lab machines run.

The lab PCs are not development machines: nobody there should be installing
Python 3.10, hunting the Tobii SDK out of a vendor download, putting ffmpeg on
PATH, or typing a --allow-origin flag. This freezes all of it into a folder
that runs by double-clicking A04Bridge.exe, and zips that folder to send.

    .\.venv310\Scripts\python.exe build_package.py

Build it from the 3.10 environment that already runs the bridge: PyInstaller
freezes the interpreter and packages it is given, so what the lab gets is
exactly what was tested here. Building from the wrong Python is the one
mistake that survives all the way to a lab PC reporting "no tracker".
"""

from __future__ import annotations

import asyncio
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import zipfile
from importlib.util import find_spec
from pathlib import Path

from tobii_bridge import DEFAULT_PORT

HERE = Path(__file__).parent
DIST = HERE / "dist"
NAME = "A04Bridge"
# ffprobe is not needed to record, only to check a finished file; ship it so a
# recording that fails verification says why instead of saying nothing.
TOOLS = ("ffmpeg", "ffprobe")

README = """A04 eye-tracking bridge
=======================

Double-click A04Bridge.exe before the participant sits down, and leave the
window open for the whole session.
Closing it stops gaze and screen recording.

What it does
------------
Streams gaze from the Tobii tracker to the study page in the browser, and
records the screen and the case video's soundtrack during the case. The
browser supplies only the student's video sound; the bridge does not record
the microphone or other applications' audio. Everything is sent to the
study server; nothing is kept on this PC except recordings the server refused,
which land in the unsent-recordings folder next to the .exe.

What this PC needs
------------------
- A Tobii Pro tracker, plugged in and calibrated in Tobii Pro Eye Tracker
  Manager. Calibration does not happen inside the study app.
- Chrome or Edge with permission to connect to the local bridge. The study
  site is https://a04.rdm.lab.lrz.de.
- Python, the Tobii SDK, ffmpeg and ffprobe are all inside this folder.

Matching the study's port
-------------------------
The bridge listens on ws://127.0.0.1:8766 by default, matching
https://a04.rdm.lab.lrz.de. No shortcut arguments are needed.

Checking it works
-----------------
The window should print:

    [bridge] listening on ws://127.0.0.1:8766 (tobii)
    [bridge] screen recording enabled (ffmpeg found)

"(mock)" means the bridge was explicitly launched with --mock, which produces
synthetic gaze. "(tobii)" does not prove that a tracker was found. Check live
gaze in the study and a nonzero gaze sample count after a short test case.
If no tracker is found, check the cable and Eye Tracker Manager. While gaze is
requested, the bridge retries discovery and reports subscription/sample errors.
Run Check-eye-tracker.cmd with the normal bridge window closed to test the
tracker independently of browser permissions. Look at the calibrated display.
It writes tracker-diagnostic.txt with SDK version, model and sample counts,
never gaze positions. Send that report when requesting technical support.

This package uses Tobii Pro SDK 2.1: Spectrum, Fusion, Nano and Spark are
supported. Older models such as X2, X3, TX300, T60/T120 and X60/X120 need a
different compatible SDK build. Spectrum also needs the network runtime from
Eye Tracker Manager. See the vendor compatibility guide:
https://developer.tobiipro.com/tobiiprosdk/eyetrackercompatibility.html

If the window refuses a connection from the study origin, check that this is
the current package. Allow the browser's local-network permission when asked.

Before collecting data, play a short case with a delay, a pause and a rewind.
Check that the participant replay, admin replay and downloaded MP4 all contain
the same synchronized sound. An audio warning must be investigated; a stored
screen recording alone does not prove that audio was captured.

Replace the whole A04Bridge folder when updating. A website deployment does
not update this executable, and old silent recordings remain silent.

"port ... is already in use" means another process is listening on that port.

Do not move A04Bridge.exe out of this folder -- it needs what sits next to it.
"""

NOTICE = """Third-party components shipped in this folder
============================================

ffmpeg.exe, ffprobe.exe
  FFmpeg (https://ffmpeg.org), GPL build. Source for the exact build is
  available from the FFmpeg project and from the build's publisher; this
  package adds no modifications.

tobiiresearch / tobii_research
  Tobii Pro SDK, redistributed under Tobii's SDK licence for use with Tobii
  Pro hardware.

The bridge itself is part of the A04 study platform.
"""

DIAGNOSTIC_COMMAND = r"""@echo off
cd /d "%~dp0"
echo Close the normal A04Bridge window before this check.
echo Look at the calibrated display for eight seconds.
"%~dp0A04Bridge.exe" --diagnose --diagnostic-seconds 8 > "%~dp0tracker-diagnostic.txt" 2>&1
type "%~dp0tracker-diagnostic.txt"
echo.
echo Report saved as tracker-diagnostic.txt. No gaze positions are included.
pause
"""


def _fail(message: str) -> None:
    raise SystemExit(f"build: {message}")


def check_environment() -> None:
    if sys.platform != "win32":
        _fail("build the Windows executable on Windows; cross-compiling is not supported.")
    if sys.version_info[:2] != (3, 10):
        _fail(
            f"running on Python {sys.version_info.major}.{sys.version_info.minor}; "
            r"the Tobii SDK is 3.10 only. Use .venv310\Scripts\python.exe."
        )
    if find_spec("tobii_research") is None:
        _fail(
            "tobii_research is not installed here, so the package would ship "
            "without the SDK and every lab PC would report 'no tracker'."
        )
    if find_spec("PyInstaller") is None:
        _fail("PyInstaller is not installed here: pip install -r requirements-dev.txt")


def freeze() -> Path:
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onedir",  # one file would unpack to a temp dir on every start
            "--console",
            "--name",
            NAME,
            # The SDK's interop DLLs are loaded by filename at runtime, so
            # import analysis alone does not see them.
            "--collect-all",
            "tobiiresearch",
            "--distpath",
            str(DIST),
            "--workpath",
            str(HERE / "build"),
            "--specpath",
            str(HERE / "build"),
            str(HERE / "tobii_bridge.py"),
        ],
        check=True,
        cwd=HERE,
    )
    folder = DIST / NAME
    if not (folder / f"{NAME}.exe").exists():
        _fail(f"PyInstaller produced no {NAME}.exe")
    return folder


def add_tools(folder: Path) -> None:
    for tool in TOOLS:
        found = shutil.which(tool)
        if not found:
            _fail(
                f"{tool} is not on PATH here, so it cannot be bundled. Install "
                "it on this machine first — the lab PCs get it from this folder."
            )
        # PATHEXT hands back FFMPEG.EXE on some machines; keep the name tidy.
        shutil.copy2(found, folder / Path(found).name.lower())
    check_media_tools(folder)


def check_media_tools(folder: Path) -> None:
    """Exercise the shipped encoders and probe, not a different PATH install."""
    ffmpeg = folder / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
    ffprobe = folder / ("ffprobe.exe" if sys.platform == "win32" else "ffprobe")

    def run(*args: str) -> bytes:
        try:
            return subprocess.check_output(args, stderr=subprocess.STDOUT, timeout=30)
        except (OSError, subprocess.SubprocessError) as exc:
            _fail(f"bundled media tools failed their audio/video self-test: {exc}")

    with tempfile.TemporaryDirectory(prefix="a04-package-check-") as temp:
        audio = Path(temp) / "stimulus.webm"
        output = Path(temp) / "screen.mp4"
        run(
            str(ffmpeg),
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.3",
            "-c:a",
            "libopus",
            str(audio),
        )
        run(
            str(ffmpeg),
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=black:size=160x90:rate=10:duration=0.3",
            "-i",
            str(audio),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-af",
            "adelay=10:all=1,apad,atrim=duration=0.3",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(output),
        )
        report = json.loads(
            run(
                str(ffprobe),
                "-v",
                "error",
                "-count_packets",
                "-show_entries",
                "stream=codec_name,nb_read_packets",
                "-of",
                "json",
                str(output),
            )
        )
        streams = {stream.get("codec_name"): stream for stream in report.get("streams", [])}
        if any(
            int(streams.get(codec, {}).get("nb_read_packets", 0)) <= 0 for codec in ("h264", "aac")
        ):
            _fail("bundled ffmpeg/ffprobe did not produce both H.264 and AAC packets.")


async def _probe_executable(proc, port: int, timeout: float = 15) -> None:
    import websockets

    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("the packaged executable exited before its handshake")
        try:
            async with websockets.connect(
                f"ws://127.0.0.1:{port}",
                origin="https://a04.rdm.lab.lrz.de",
                open_timeout=1,
                close_timeout=1,
            ) as ws:
                status = json.loads(await asyncio.wait_for(ws.recv(), 2))
                if (
                    status.get("type") != "status"
                    or not status.get("connected")
                    or status.get("stimulus_audio") is not False
                ):
                    raise RuntimeError(
                        "the packaged executable sent an unexpected capability handshake"
                    )
                await ws.send(json.dumps({"type": "start_gaze"}))
                gaze = json.loads(await asyncio.wait_for(ws.recv(), 2))
                if gaze.get("type") != "gaze" or not gaze.get("ts"):
                    raise RuntimeError("the packaged executable did not stream mock gaze")
                return
        except OSError:
            await asyncio.sleep(0.1)
    raise RuntimeError("the packaged executable did not open its local WebSocket in time")


def check_executable(folder: Path) -> None:
    """Exercise imports, the default LRZ origin and gaze in the frozen program."""
    executable = str(folder / f"{NAME}.exe")
    try:
        sdk = json.loads(
            subprocess.check_output([executable, "--check-sdk"], cwd=folder, timeout=30)
        )
        if not sdk.get("sdk_version") or not isinstance(sdk.get("trackers"), int):
            _fail("packaged executable returned no native Tobii SDK version.")
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        _fail(f"packaged executable could not load the native Tobii SDK: {exc}")
    try:
        diagnostic = subprocess.run(
            [executable, "--diagnose", "--diagnostic-seconds", "8"],
            cwd=folder,
            capture_output=True,
            timeout=25,
        )
        output = diagnostic.stdout.decode(errors="replace")
        report = json.loads(output[output.rfind("\n{") + 1 :])
        if (
            diagnostic.returncode not in (0, 1)
            or report.get("sdk_version") != sdk["sdk_version"]
            or report.get("source_mode") != "tobii"
            or report.get("error_code") not in (None, "tracker_missing", "invalid_samples")
            or not isinstance(report.get("sample_count"), int)
            or not isinstance(report.get("valid_sample_count"), int)
            or not 0 <= report["valid_sample_count"] <= report["sample_count"]
            or report.get("ok") != (report["valid_sample_count"] > 0)
        ):
            _fail("packaged tracker diagnostic failed its native SDK/sample-count check.")
        print(
            f"build: frozen tracker diagnostic: model={report.get('model') or 'none'}, "
            f"samples={report['sample_count']}, valid={report['valid_sample_count']}"
        )
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        _fail(f"packaged tracker diagnostic did not complete correctly: {exc}")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", DEFAULT_PORT))
    proc = subprocess.Popen(
        [executable, "--mock", "--no-screen-recording"],
        cwd=folder,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    failure = None
    try:
        asyncio.run(_probe_executable(proc, DEFAULT_PORT))
    except Exception as exc:
        failure = str(exc)
    finally:
        if proc.poll() is None:
            proc.terminate()
        try:
            output, _ = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            output, _ = proc.communicate(timeout=5)
    if failure:
        detail = output.decode(errors="replace")[-500:]
        _fail(f"packaged executable self-test failed: {failure}; {detail}")


def zip_folder(folder: Path) -> Path:
    archive = DIST / f"{NAME}-win64.zip"
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(folder.parent))
    return archive


def main() -> None:
    check_environment()
    folder = freeze()
    add_tools(folder)
    check_executable(folder)
    (folder / "README.txt").write_text(README, encoding="utf-8")
    (folder / "NOTICE.txt").write_text(NOTICE, encoding="utf-8")
    (folder / "Check-eye-tracker.cmd").write_text(DIAGNOSTIC_COMMAND, encoding="ascii")
    archive = zip_folder(folder)
    size_mb = archive.stat().st_size / 1_000_000
    print(f"\nbuild: {archive} ({size_mb:.0f} MB)")
    print(rf"build: unzipped, a lab PC runs {NAME}\{NAME}.exe")


if __name__ == "__main__":
    main()
