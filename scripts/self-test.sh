#!/usr/bin/env bash
set -euo pipefail

echo "[digirig] self-test: service + listener checks"

SERVICE="whisperlive.service"

ACTIVE=$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)
ENABLED=$(systemctl --user is-enabled "$SERVICE" 2>/dev/null || true)
LISTEN=$(ss -ltn 2>/dev/null | grep -E ':28080\b' || true)

echo "service active: ${ACTIVE:-unknown}"
echo "service enabled: ${ENABLED:-unknown}"
if [[ -n "$LISTEN" ]]; then
  echo "listener: yes"
else
  echo "listener: no"
fi

echo
if [[ "${ACTIVE}" != "active" || "${ENABLED}" != "enabled" || -z "$LISTEN" ]]; then
  echo "❌ self-test failed. Suggested fix:"
  echo "npm run setup:quickstart"
  echo "openclaw gateway restart"
  exit 1
fi

echo "✅ local service checks passed"
echo "Next manual RF test phrase:"
echo "Overlord, this is Rich W6RGC. Give me a radio check and tell me what 2 plus 2 is."
