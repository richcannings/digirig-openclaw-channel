#!/usr/bin/env bash
# Interactive setup for a fresh digirig-openclaw-channel install.
#
# Runs the individual setup-*.sh scripts in order, prompting the user at each
# optional step. Idempotent — each sub-script checks what's already installed
# and skips or patches as needed.
#
# This is a pragmatic wrapper until the plugin manages its own daemon
# lifecycle (step 1 of claude-redesign.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

banner() {
  printf "\n==== %s ====\n" "$1"
}

ask_yes_no() {
  local prompt="$1" default="${2:-Y}" reply
  local hint="[Y/n]"; [ "${default}" = "N" ] && hint="[y/N]"
  read -rp "$prompt $hint " reply
  reply="${reply:-$default}"
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

ensure_npm_install() {
  banner "Node dependencies"
  if [ -d "$(dirname "$SCRIPT_DIR")/node_modules" ]; then
    echo "node_modules/ already present — skipping npm install."
  else
    (cd "$(dirname "$SCRIPT_DIR")" && npm install)
  fi
}

install_stt() {
  banner "Local STT (Whisper)"
  echo "Whisper gives you sub-second transcription on GPU, ~2-4s on CPU."
  if ask_yes_no "Install the local Whisper STT daemon?" "Y"; then
    bash "$SCRIPT_DIR/setup-stt-daemon.sh"
  else
    echo "Skipping. Plugin will fall back to the cold-start 'whisper' CLI (slower)."
  fi
}

install_tts() {
  banner "Text-to-Speech backend"
  echo "Pick how the AI speaks. Pick both if you want to A/B compare."
  echo
  echo "  [P] Piper     — fast, robotic-ish voice, ~60 MB"
  echo "  [K] Kokoro    — more natural voice, ~350 MB, slightly slower"
  echo "  [B] Both      — install both, flip with 'openclaw config set channels.digirig.localTts.engine piper|kokoro'"
  echo "  [C] Cloud     — use OpenClaw's configured cloud TTS provider (needs API key)"
  echo "  [S] Skip      — decide later"
  echo
  local reply
  read -rp "Choice [P/K/B/C/S]: " reply
  case "${reply^^}" in
    P) bash "$SCRIPT_DIR/setup-piper-daemon.sh" ;;
    K) bash "$SCRIPT_DIR/setup-kokoro-daemon.sh" ;;
    B) bash "$SCRIPT_DIR/setup-piper-daemon.sh"
       bash "$SCRIPT_DIR/setup-kokoro-daemon.sh" ;;
    C) echo "Cloud TTS: configure a provider under 'messages.tts.providers.*' in openclaw config." ;;
    S|*) echo "Skipping. TTS stays on OpenClaw's cloud default until you configure otherwise." ;;
  esac
}

set_engine_if_needed() {
  if command -v openclaw >/dev/null 2>&1; then
    banner "Plugin TTS engine selection"
    echo "Set the plugin's active TTS engine now? (Requires daemon installed above.)"
    echo "  Run any of these when you're ready:"
    echo "    openclaw config set channels.digirig.localTts.engine piper"
    echo "    openclaw config set channels.digirig.localTts.engine kokoro"
    echo "    openclaw config set channels.digirig.localTts.engine off   # cloud TTS"
    echo "    openclaw gateway restart"
  fi
}

print_next_steps() {
  banner "Next steps"
  cat <<'EOF'
1. Configure your hardware + identity:

     /digirig setup                  # auto-detect audio/PTT devices, prints config cmds
     openclaw config set channels.digirig.tx.callsign  "YOURCALL/AI"
     openclaw config set channels.digirig.tx.aliases   "YourName,7,Overlord"
     openclaw config set channels.digirig.tx.policy    "proactive"
     openclaw config set channels.digirig.persona.name "YourName"
     openclaw config set channels.digirig.persona.location "Your City, State"

2. Pick the TTS engine you installed above (skip if you chose Cloud / Skip):

     openclaw config set channels.digirig.localTts.engine piper    # or kokoro

3. Restart and verify:

     openclaw gateway restart
     /digirig doctor                 # should show STT + TX API + your TTS listening

4. Tail the log in a second terminal:

     node scripts/digirig-tail.cjs

5. Key up your radio: "YourName, this is YourCall. Radio check."

Emergency stop on air at any time:  /digirig unkey
EOF
}

main() {
  banner "digirig-openclaw-channel setup"
  echo "This walks through installing the optional local STT + TTS daemons."
  echo "Each step is idempotent — safe to re-run."
  echo
  ensure_npm_install
  install_stt
  install_tts
  set_engine_if_needed
  print_next_steps
}

main "$@"
