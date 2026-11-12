import shutil
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from build_package import _probe_executable, check_environment, check_executable, check_media_tools
from tobii_bridge import DEFAULT_PORT, main


def test_windows_package_cannot_be_mislabeled_from_another_platform(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    with pytest.raises(SystemExit, match="on Windows"):
        check_environment()


def test_bundled_tools_encode_and_probe_real_audio(tmp_path):
    for name in ("ffmpeg", "ffprobe"):
        source = shutil.which(name)
        if source is None:
            pytest.skip(f"{name} unavailable")
        target = tmp_path / (f"{name}.exe" if sys.platform == "win32" else name)
        shutil.copy2(Path(source), target)
    check_media_tools(tmp_path)


def test_a_missing_bundled_tool_fails_the_build(tmp_path):
    with pytest.raises(SystemExit, match="self-test"):
        check_media_tools(tmp_path)


@pytest.mark.parametrize("probe_fails", [False, True])
def test_frozen_smoke_uses_mock_without_capture_and_always_stops(
    tmp_path, monkeypatch, probe_fails
):
    calls = []

    class Process:
        terminated = False

        def poll(self):
            return None

        def terminate(self):
            self.terminated = True

        def communicate(self, timeout):
            assert timeout == 5
            return b"frozen bridge output", None

    proc = Process()

    def popen(command, **kwargs):
        calls.append((command, kwargs))
        return proc

    async def probe(actual, port):
        assert actual is proc
        assert port == 8766
        if probe_fails:
            raise RuntimeError("missing frozen import")

    monkeypatch.setattr("build_package.subprocess.Popen", popen)

    def sdk_check(command, **kwargs):
        assert command == [str(tmp_path / "A04Bridge.exe"), "--check-sdk"]
        assert kwargs == {"cwd": tmp_path, "timeout": 30}
        return b'{"sdk_version":"2.1.0","trackers":0}'

    monkeypatch.setattr("build_package.subprocess.check_output", sdk_check)
    monkeypatch.setattr("build_package._probe_executable", probe)
    if probe_fails:
        with pytest.raises(SystemExit, match="missing frozen import"):
            check_executable(tmp_path)
    else:
        check_executable(tmp_path)
    command, kwargs = calls[0]
    assert command[0] == str(tmp_path / "A04Bridge.exe")
    assert command[1:3] == ["--mock", "--no-screen-recording"]
    assert "--allow-origin" not in command
    assert "--port" not in command
    assert kwargs["cwd"] == tmp_path
    assert proc.terminated


def test_sdk_diagnostic_loads_native_binding_without_starting_server(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["A04Bridge.exe", "--check-sdk"])
    monkeypatch.setitem(
        sys.modules,
        "tobii_research",
        SimpleNamespace(
            get_sdk_version=lambda: "2.1.0",
            find_all_eyetrackers=lambda: [],
        ),
    )
    main()
    assert '"sdk_version": "2.1.0"' in capsys.readouterr().out
    assert DEFAULT_PORT == 8766


def test_package_rejects_missing_native_sdk(tmp_path, monkeypatch):
    def broken_sdk(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args[0])

    monkeypatch.setattr("build_package.subprocess.check_output", broken_sdk)
    with pytest.raises(SystemExit, match="native Tobii SDK"):
        check_executable(tmp_path)


@pytest.mark.asyncio
async def test_package_probe_exercises_a_real_bridge_process():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    proc = subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).with_name("tobii_bridge.py")),
            "--mock",
            "--no-screen-recording",
            "--port",
            str(port),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        await _probe_executable(proc, port)
    finally:
        proc.terminate()
        proc.communicate(timeout=5)
