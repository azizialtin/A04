# A04 uses its own port so it cannot accidentally connect to the LENS bridge.
param([string]$Origin = "https://a04.rdm.lab.lrz.de", [switch]$Mock)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$bridgeArgs = @("--host", "127.0.0.1", "--port", "8766", "--allow-origin", $Origin)
if ($Mock) { $bridgeArgs += "--mock" }
if (Test-Path ".\A04Bridge.exe") {
    & .\A04Bridge.exe @bridgeArgs
} elseif (Test-Path ".\.venv310\Scripts\python.exe") {
    & .\.venv310\Scripts\python.exe .\tobii_bridge.py @bridgeArgs
} else {
    throw "A04Bridge.exe or a Python 3.10 .venv310 with the Tobii SDK is required. See README-LRZ.txt."
}
if ($LASTEXITCODE -ne 0) { throw "A04 bridge stopped with exit code $LASTEXITCODE" }
