A04 on LRZ — lab computer setup

The backend runs on LRZ. The bridge runs on the Windows lab PC next to the
browser and Tobii hardware. Do not install it on the VM.

Prepared production origin: https://a04.rdm.lab.lrz.de
A04 bridge: ws://127.0.0.1:8766 (loopback only)
LENS uses 8765; the different port prevents connecting to the wrong bridge.

The rebuilt A04Bridge-win64.zip defaults to this origin and port. Extract the
whole folder and double-click A04Bridge.exe; no shortcut arguments are needed.
Replace the whole old package to receive stimulus audio capture. Changing a
shortcut or deploying the website does not update an older executable.

For source use, or to set an explicit origin, run in PowerShell:
  .\start-lrz.ps1
The wrapper can also be placed beside A04Bridge.exe.
For a different allocated production origin:
  .\start-lrz.ps1 -Origin https://THE-APP-HOST

Otherwise use Python 3.10 with the project's supported Tobii Pro SDK:
  py -3.10 -m venv .venv310
  .\.venv310\Scripts\python.exe -m pip install -r requirements.txt
Install tobii-research==2.1.0 into that environment and put ffmpeg and ffprobe
on PATH. Then run .\start-lrz.ps1. This source archive is not a Windows
executable and does not bundle the vendor SDK or ffmpeg. build_package.py can
produce the complete package on a prepared Windows build machine.

Synthetic connectivity/capture check without hardware:
  .\start-lrz.ps1 -Mock
This produces synthetic gaze and a test-pattern recording. Never use Mock
mode for a real participant session.

Use Chrome/Edge. Permit local-network access if asked. Keep the bridge window
open throughout the sitting. Calibrate externally in Tobii Pro Eye Tracker
Manager (in-app calibration is off by default). Capture the calibrated display.
Before real sessions verify tracker connection, gaze, screen upload, replay
alignment and download on the intended lab PC. Play a short case with a pause
and rewind, then confirm the same soundtrack in replay and the downloaded MP4.

Only study material should be open on the captured display. If an upload
fails, preserve unsent-recordings and report the error. No recordings or
credentials are included in this archive.
