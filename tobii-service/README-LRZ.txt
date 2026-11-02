A04 on LRZ — lab computer setup

The backend runs on LRZ. The bridge runs on the Windows lab PC next to the
browser and Tobii hardware. Do not install it on the VM.

Prepared production origin: https://a04.rdm.lab.lrz.de
A04 bridge: ws://127.0.0.1:8766 (loopback only)
LENS uses 8765; the different port prevents connecting to the wrong bridge.

With an existing frozen A04Bridge.exe package, copy start-lrz.ps1 beside
that executable and run in PowerShell:
  .\start-lrz.ps1
For a different allocated production origin:
  .\start-lrz.ps1 -Origin https://THE-APP-HOST

Otherwise use Python 3.10 with the project's supported Tobii Pro SDK:
  py -3.10 -m venv .venv310
  .\.venv310\Scripts\python.exe -m pip install -r requirements.txt
Install the matching Tobii SDK vendor package into that environment and put
ffmpeg on PATH. Then run .\start-lrz.ps1. This source archive is not a Windows
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
alignment and download on the intended lab PC.

Only study material should be open on the captured display. If an upload
fails, preserve unsent-recordings and report the error. No recordings or
credentials are included in this archive.
