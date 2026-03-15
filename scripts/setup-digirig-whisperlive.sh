#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${SCRIPT_DIR}/setup-whisperlive-systemd.sh"

echo
echo "Applying DigiRig STT defaults..."
if command -v openclaw >/dev/null 2>&1; then
  openclaw config set channels.digirig.stt.wsUrl "ws://127.0.0.1:28080"
  openclaw config set channels.digirig.stt.whisperLiveAutoStart true
  openclaw config set channels.digirig.stt.whisperLiveService "whisperlive.service"
  echo "Done. Restart gateway: openclaw gateway restart"
else
  echo "openclaw CLI not found. Run these manually:"
  echo 'openclaw config set channels.digirig.stt.wsUrl "ws://127.0.0.1:28080"'
  echo 'openclaw config set channels.digirig.stt.whisperLiveAutoStart true'
  echo 'openclaw config set channels.digirig.stt.whisperLiveService "whisperlive.service"'
  echo 'openclaw gateway restart'
fi
