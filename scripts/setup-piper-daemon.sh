#!/usr/bin/env bash
# Install Piper TTS + a default voice and register piper-daemon.service.
# Idempotent — safe to re-run.
set -euo pipefail

PIPER_HOME="${HOME}/.openclaw/piper"
PIPER_BIN_DIR="${PIPER_HOME}/piper"
PIPER_BIN="${PIPER_BIN_DIR}/piper"
MODEL_NAME="en_US-lessac-high"
MODEL_ONNX="${PIPER_HOME}/${MODEL_NAME}.onnx"
MODEL_JSON="${PIPER_HOME}/${MODEL_NAME}.onnx.json"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/piper-daemon.service"
DAEMON_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/piper-daemon.py"

echo "[piper-setup] installing to ${PIPER_HOME}"
mkdir -p "${PIPER_HOME}"

# 1) Piper binary
if [ ! -x "${PIPER_BIN}" ]; then
  # Version + arch. Update the tag here when newer releases are needed.
  PIPER_VERSION="2023.11.14-2"
  ARCH="$(uname -m)"
  case "${ARCH}" in
    x86_64) PIPER_ARCH="x86_64" ;;
    aarch64|arm64) PIPER_ARCH="aarch64" ;;
    armv7l) PIPER_ARCH="armv7l" ;;
    *) echo "[piper-setup] unsupported arch: ${ARCH}"; exit 1 ;;
  esac
  TARBALL="piper_linux_${PIPER_ARCH}.tar.gz"
  URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${TARBALL}"
  echo "[piper-setup] downloading ${URL}"
  TMP="$(mktemp -d)"
  curl -fL --retry 3 -o "${TMP}/${TARBALL}" "${URL}"
  tar -xzf "${TMP}/${TARBALL}" -C "${PIPER_HOME}"
  rm -rf "${TMP}"
else
  echo "[piper-setup] piper binary already present"
fi

# 2) Voice model
if [ ! -f "${MODEL_ONNX}" ] || [ ! -f "${MODEL_JSON}" ]; then
  # HuggingFace hosts the Piper voices.
  VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high"
  echo "[piper-setup] downloading voice ${MODEL_NAME}"
  curl -fL --retry 3 -o "${MODEL_ONNX}" "${VOICE_BASE}/${MODEL_NAME}.onnx"
  curl -fL --retry 3 -o "${MODEL_JSON}" "${VOICE_BASE}/${MODEL_NAME}.onnx.json"
else
  echo "[piper-setup] voice model already present"
fi

# 3) systemd user unit
mkdir -p "${SERVICE_DIR}"
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Piper TTS Daemon (digirig)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env python3 ${DAEMON_SCRIPT} --piper-bin ${PIPER_BIN} --model ${MODEL_ONNX}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now piper-daemon.service

echo ""
echo "[piper-setup] done"
echo "    binary: ${PIPER_BIN}"
echo "    model:  ${MODEL_ONNX}"
echo "    check:  curl -sf http://127.0.0.1:18090/healthz"
echo "    logs:   journalctl --user -u piper-daemon.service -f"
