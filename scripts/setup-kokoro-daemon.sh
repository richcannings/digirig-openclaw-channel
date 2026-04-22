#!/usr/bin/env bash
# Install Kokoro-82M TTS (via kokoro-onnx) and register kokoro-daemon.service.
# Idempotent — safe to re-run.
set -euo pipefail

KOKORO_HOME="${HOME}/.openclaw/kokoro"
VENV_DIR="${HOME}/.openclaw/venv/kokoro"
PY="${VENV_DIR}/bin/python"
PIP="${VENV_DIR}/bin/pip"
# v1.0 is the current Kokoro model. Full-precision .onnx is ~310 MB; the .bin
# voices file carries ~50 voices in English + several other languages.
MODEL_ONNX="${KOKORO_HOME}/kokoro-v1.0.onnx"
VOICES_BIN="${KOKORO_HOME}/voices-v1.0.bin"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/kokoro-daemon.service"
DAEMON_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kokoro-daemon.py"

echo "[kokoro-setup] installing to ${KOKORO_HOME} / ${VENV_DIR}"
mkdir -p "${KOKORO_HOME}"

# 1) Python venv + kokoro-onnx
if [ ! -x "${PY}" ]; then
  echo "[kokoro-setup] creating venv"
  python3 -m venv "${VENV_DIR}"
  "${PIP}" install -q --upgrade pip
fi

echo "[kokoro-setup] ensuring kokoro-onnx is installed"
# Let kokoro-onnx pull in its own numpy / onnxruntime pins. Historically forcing
# numpy<2.0 here caused pip to build numpy from source and fail on modern
# Python; the package is compatible with numpy 2.x.
"${PIP}" install -q "kokoro-onnx>=0.4.7"

# 2) Model + voices
RELEASE_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

if [ ! -f "${MODEL_ONNX}" ]; then
  echo "[kokoro-setup] downloading model (~310 MB)"
  curl -fL --retry 3 -o "${MODEL_ONNX}" "${RELEASE_URL}/kokoro-v1.0.onnx"
else
  echo "[kokoro-setup] model already present"
fi

if [ ! -f "${VOICES_BIN}" ]; then
  echo "[kokoro-setup] downloading voices (~26 MB)"
  curl -fL --retry 3 -o "${VOICES_BIN}" "${RELEASE_URL}/voices-v1.0.bin"
else
  echo "[kokoro-setup] voices already present"
fi

# 3) systemd user unit
mkdir -p "${SERVICE_DIR}"
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Kokoro-82M TTS Daemon (digirig)
After=network.target

[Service]
Type=simple
ExecStart=${PY} ${DAEMON_SCRIPT} --model-path ${MODEL_ONNX} --voices-path ${VOICES_BIN}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now kokoro-daemon.service

echo ""
echo "[kokoro-setup] done"
echo "    model:  ${MODEL_ONNX}"
echo "    check:  curl -sf http://127.0.0.1:18091/healthz"
echo "    logs:   journalctl --user -u kokoro-daemon.service -f"
