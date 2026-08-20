#!/usr/bin/env bash
# Dev launcher (mock by default): ./start-bridge.sh  or  ./start-bridge.sh --mock
set -euo pipefail
cd "$(dirname "$0")"
exec python tobii_bridge.py "$@"
