#!/usr/bin/env bash
set -euo pipefail

VENV="${HOME}/.openclaw/venv/whisper-live"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/whisperlive.service"
RUNNER="${HOME}/.local/bin/run-whisperlive-server.py"

mkdir -p "${VENV}" "${SERVICE_DIR}" "${HOME}/.local/bin"

if [[ ! -x "${VENV}/bin/python" ]]; then
  python3 -m venv "${VENV}"
fi

"${VENV}/bin/pip" install --upgrade pip >/dev/null
"${VENV}/bin/pip" install whisper-live fastapi uvicorn python-multipart >/dev/null

cat > "${RUNNER}" <<'PY'
#!/usr/bin/env python3
from whisper_live.server import TranscriptionServer

server = TranscriptionServer()
server.run(host='127.0.0.1', port=28080, backend='faster_whisper')
PY
chmod +x "${RUNNER}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=WhisperLive transcription server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PYTHONUNBUFFERED=1
ExecStart=${VENV}/bin/python ${RUNNER}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now whisperlive.service

if command -v loginctl >/dev/null 2>&1; then
  loginctl show-user "${USER}" -p Linger --value >/dev/null 2>&1 || true
fi

echo "WhisperLive systemd service installed and started."
echo "Verify: systemctl --user status whisperlive.service"
