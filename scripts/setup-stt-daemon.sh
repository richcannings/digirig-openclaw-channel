#!/usr/bin/env bash
set -euo pipefail

VENV="${HOME}/.openclaw/venv/whisper-live"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/whisper-daemon.service"
DAEMON_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stt_daemon.py"
PYTHON_BIN="${VENV}/bin/python"

if [ ! -f "${PYTHON_BIN}" ]; then
  echo "Error: Python virtual environment not found at ${VENV}."
  echo "Please ensure whisper is installed."
  exit 1
fi

echo "Ensuring static-ffmpeg is installed in venv..."
"${VENV}/bin/pip" install -q static-ffmpeg || true

# Determine optimal Whisper model based on CUDA availability
MODEL="base.en"
if "${PYTHON_BIN}" -c "import torch; exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then
  MODEL="small.en"
  echo "CUDA GPU detected: using '${MODEL}' model with GPU acceleration."
else
  echo "CPU inference detected: using '${MODEL}' model (~1.0s latency)."
fi

mkdir -p "${SERVICE_DIR}"

cat << EOF > "${SERVICE_FILE}"
[Unit]
Description=Hot-Loaded Whisper STT Daemon
After=network.target

[Service]
Type=simple
Environment="PATH=${HOME}/.local/bin:${VENV}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin"
ExecStart=${PYTHON_BIN} ${DAEMON_SCRIPT} --model ${MODEL} --port 18088
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now whisper-daemon.service

if command -v loginctl >/dev/null 2>&1; then
  loginctl show-user "${USER}" -p Linger --value >/dev/null 2>&1 || true
fi

echo ""
echo "✅ Whisper hot-loaded daemon installed and started!"
echo "Model (${MODEL}) is loaded in memory, ready to transcribe instantly."
echo "Verify status: systemctl --user status whisper-daemon.service"
echo "Check logs: journalctl --user -u whisper-daemon.service -f"
