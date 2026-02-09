#!/usr/bin/env bash
set -euo pipefail

# Run whisper-server.
# Usage:
#   ./scripts/whisper-server.sh /path/to/whisper.cpp /path/to/model.bin [host] [port]

REPO="${1:-}"
MODEL="${2:-}"
HOST="${3:-127.0.0.1}"
PORT="${4:-18080}"

if [[ -z "$REPO" || -z "$MODEL" ]]; then
  echo "Usage: $0 /path/to/whisper.cpp /path/to/model.bin [host] [port]" >&2
  exit 1
fi

BIN="$REPO/build/bin/whisper-server"
if [[ ! -x "$BIN" ]]; then
  echo "whisper-server not found at $BIN. Build first." >&2
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "Model not found: $MODEL" >&2
  exit 1
fi

exec "$BIN" -m "$MODEL" --host "$HOST" --port "$PORT"
