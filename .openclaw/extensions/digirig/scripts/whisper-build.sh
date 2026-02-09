#!/usr/bin/env bash
set -euo pipefail

# Build whisper.cpp with or without CUDA.
# Usage:
#   ./scripts/whisper-build.sh cpu   /path/to/whisper.cpp
#   ./scripts/whisper-build.sh cuda  /path/to/whisper.cpp

MODE="${1:-}"
REPO="${2:-}"

if [[ -z "$MODE" || -z "$REPO" ]]; then
  echo "Usage: $0 <cpu|cuda> /path/to/whisper.cpp" >&2
  exit 1
fi

if [[ ! -d "$REPO" ]]; then
  echo "Repo not found: $REPO" >&2
  exit 1
fi

CMAKE_FLAGS=()
if [[ "$MODE" == "cuda" ]]; then
  CMAKE_FLAGS+=("-DGGML_CUDA=ON" "-DGGML_CUDA_FORCE_CUBLAS=ON")
elif [[ "$MODE" == "cpu" ]]; then
  CMAKE_FLAGS+=("-DGGML_CUDA=OFF")
else
  echo "Unknown mode: $MODE (expected cpu|cuda)" >&2
  exit 1
fi

cmake -S "$REPO" -B "$REPO/build" "${CMAKE_FLAGS[@]}"
cmake --build "$REPO/build" --config Release -j

BIN="$REPO/build/bin/whisper-server"
if [[ -x "$BIN" ]]; then
  echo "Built: $BIN"
else
  echo "Build finished, but whisper-server not found at $BIN" >&2
fi
