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

import shutil
import subprocess
import sys
import zipfile
from importlib.util import find_spec
from pathlib import Path

HERE = Path(__file__).parent
DIST = HERE / "dist"
NAME = "A04Bridge"
# ffprobe is not needed to record, only to check a finished file; ship it so a
# recording that fails verification says why instead of saying nothing.
TOOLS = ("ffmpeg", "ffprobe")

README = """A04 eye-tracking bridge
=======================

Double-click A04Bridge.exe before the participant sits down, and leave the
window open for the whole session. Closing it stops gaze and screen recording.

What it does
------------
Streams gaze from the Tobii tracker to the study page in the browser, and
records the screen while a case video is playing. Everything is sent to the
study server; nothing is kept on this PC except recordings the server refused,
which land in the unsent-recordings folder next to the .exe.

What this PC needs
------------------
- A Tobii Pro tracker, plugged in and calibrated in Tobii Pro Eye Tracker
  Manager. Calibration does not happen inside the study app.
- Nothing else. Python, the Tobii SDK and ffmpeg are all inside this folder.

Checking it works
-----------------
The window should print:

    [bridge] listening on ws://127.0.0.1:8765 (tobii)
    [bridge] screen recording enabled (ffmpeg found)

"(mock)" instead of "(tobii)" means it found no tracker: check the cable and
that Eye Tracker Manager sees it, then start the bridge again.

"port 8765 is already in use" means it is running in another window already.

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


def _fail(message: str) -> None:
    raise SystemExit(f"build: {message}")


def check_environment() -> None:
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
            sys.executable, "-m", "PyInstaller",
            "--noconfirm", "--clean",
            "--onedir",  # one file would unpack to a temp dir on every start
            "--console",
            "--name", NAME,
            # The SDK's interop DLLs are loaded by filename at runtime, so
            # import analysis alone does not see them.
            "--collect-all", "tobiiresearch",
            "--distpath", str(DIST),
            "--workpath", str(HERE / "build"),
            "--specpath", str(HERE / "build"),
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
    (folder / "README.txt").write_text(README, encoding="utf-8")
    (folder / "NOTICE.txt").write_text(NOTICE, encoding="utf-8")
    archive = zip_folder(folder)
    size_mb = archive.stat().st_size / 1_000_000
    print(f"\nbuild: {archive} ({size_mb:.0f} MB)")
    print(rf"build: unzipped, a lab PC runs {NAME}\{NAME}.exe")


if __name__ == "__main__":
    main()
