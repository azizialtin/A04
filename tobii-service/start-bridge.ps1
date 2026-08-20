# Lab-machine launcher. Real tracking: .\start-bridge.ps1
# Synthetic data:               .\start-bridge.ps1 --mock
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (Test-Path ".venv\Scripts\Activate.ps1") { . .\.venv\Scripts\Activate.ps1 }
python tobii_bridge.py @args
