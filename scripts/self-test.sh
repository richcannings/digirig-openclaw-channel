#!/usr/bin/env bash
set -euo pipefail

echo "[digirig] self-test: service + listener checks"

SERVICE="whisper-daemon.service"

ACTIVE=$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)
ENABLED=$(systemctl --user is-enabled "$SERVICE" 2>/dev/null || true)
LISTEN=$(ss -ltn 2>/dev/null | grep -E ':18088\b' || true)

echo "service active: ${ACTIVE:-unknown}"
echo "service enabled: ${ENABLED:-unknown}"
if [[ -n "$LISTEN" ]]; then
  echo "listener: yes"
else
  echo "listener: no"
fi

echo
if [[ "${ACTIVE}" != "active" || "${ENABLED}" != "enabled" || -z "$LISTEN" ]]; then
  echo "⚠️ STT daemon not running! The system will fall back to cold-start mode."
  echo "To enable ultra-fast transcription, run:"
  echo "./scripts/setup-stt-daemon.sh"
else
  echo "✅ Ultra-fast STT Daemon is running and listening!"
fi

echo "Next manual RF test phrase:"
echo "Overlord, this is Rich W6RGC. Give me a radio check and tell me what 2 plus 2 is."
