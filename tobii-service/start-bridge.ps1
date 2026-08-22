# Lab-machine launcher. Real tracking: .\start-bridge.ps1
# Synthetic data:               .\start-bridge.ps1 --mock
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# The Tobii Pro SDK is Python 3.10 only, so the environment here is a 3.10 one —
# .venv310 on the lab machines. Miss it and `python` is whatever is on PATH: a
# 3.11+ interpreter starts the bridge quite happily and reports no tracker,
# which is indistinguishable from unplugged hardware. Say so instead.
$venv = ".venv310", ".venv" | Where-Object { Test-Path "$_\Scripts\Activate.ps1" } | Select-Object -First 1
if ($venv) {
  . ".\$venv\Scripts\Activate.ps1"
} else {
  Write-Warning "No .venv310 or .venv here - using the 'python' on PATH. The SDK needs 3.10; a newer one will report 'no tracker'. See README.md."
}
python tobii_bridge.py @args
