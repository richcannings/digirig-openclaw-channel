# DigiRig OpenClaw Channel

Talk to OpenClaw over ham radio.

This plugin provides a bridge between voice ham radio operations and OpenClaw.

This plugin provides:
- Speech-to-text to agent to text-to-speech pipeline
- digirig PTT handling and VOX support 
- Carrier detection and transmission queuing for half-duplex operation
- Transcription logging
- `/digirig tx` manual transmit a message over-the-air
- `/digirig calibrate` AI assisted audio-level calibration
- `/digirig doctor` service + listener diagnostics
- `/digirig setup` prints host-aware setup commands

---

## Quick Start (no-brainer setup)

This plugin now assumes **WhisperLive over local WebSocket** and can auto-start a local `whisperlive.service` if needed.

## 1) Install plugin
```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/richcannings/digirig-openclaw-channel
cd digirig-openclaw-channel
npm install
openclaw plugins install -l ~/src/digirig-openclaw-channel
```

### Minimal install (copy/paste)
```bash
cd ~/src/digirig-openclaw-channel
npm install
npm run setup:quickstart
openclaw plugins install -l ~/src/digirig-openclaw-channel
openclaw gateway restart
```

## 2) Configure audio + PTT
```bash
# inspect devices
arecord -l
aplay -l

# set DigiRig devices
openclaw config set channels.digirig.audio.inputDevice "plughw:0,0"
openclaw config set channels.digirig.audio.outputDevice "plughw:0,0"

# set PTT serial
openclaw config set channels.digirig.ptt.device "/dev/ttyUSB0"
openclaw config set channels.digirig.ptt.rts true
```

## 3) Install WhisperLive as a persistent user service (recommended)
```bash
cd ~/src/digirig-openclaw-channel
npm run setup:whisperlive
```

### One-command bootstrap (service + DigiRig STT config)
```bash
npm run setup:quickstart
```

This creates and enables:
- `~/.config/systemd/user/whisperlive.service`
- `~/.local/bin/run-whisperlive-server.py`

## 4) Configure STT endpoint (WhisperLive WS)
If you ran `npm run setup:quickstart`, this is already done.

```bash
openclaw config set channels.digirig.stt.wsUrl "ws://127.0.0.1:28080"
openclaw config set channels.digirig.stt.whisperLiveAutoStart true
openclaw config set channels.digirig.stt.whisperLiveService "whisperlive.service"
```

If WS is down and `whisperLiveAutoStart=true`, DigiRig attempts:
```bash
systemctl --user start whisperlive.service
```

## 5) Set callsign + policy
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
openclaw config set channels.digirig.tx.policy "proactive"   # proactive | direct-only
openclaw config set channels.digirig.tx.aliases "Overlord,Lord,Seven,7"
```

## 6) Latency-focused RX defaults (recommended)
```bash
openclaw config set channels.digirig.rx.maxSilenceMs 1000
openclaw config set channels.digirig.rx.busyHoldMs 800
openclaw config set channels.digirig.rx.minSpeechMs 500
openclaw config set channels.digirig.rx.maxRecordMs 120000
openclaw config set channels.digirig.rx.preRollMs 300
```

## 7) Restart gateway
```bash
openclaw gateway restart
```

## 8) First-run checklist (green state)
- `systemctl --user is-enabled whisperlive.service` → `enabled`
- `systemctl --user is-active whisperlive.service` → `active`
- `ss -ltn | grep 28080` shows a listener
- `/digirig doctor` reports service active/enabled and listener present

## 9) On-air test
Transmit:
> “Overlord, this is Rich W6RGC. What is 2 plus 2?”

You should hear a spoken response and see RX/TX lines in:
```bash
~/.openclaw/logs/digirig-YYYY-MM-DD.log
```

---

## Commands

### Manual TX
```bash
/digirig tx Hello from OpenClaw
```

### Calibrate audio
```bash
/digirig calibrate
# then:
/digirig calibrate result
```

### Doctor check (WhisperLive + listener)
```bash
/digirig doctor
```

### Setup helper (auto-detect likely devices)
```bash
/digirig setup
```

---

## Troubleshooting

- Check gateway/channel health:
```bash
openclaw status
openclaw gateway status
```

- Check DigiRig logs:
```bash
openclaw logs --plain | grep -i digirig | tail -n 80
```

- Confirm STT WS listener:
```bash
ss -ltnp | grep 28080
```

---

## Docs
- Design notes: `docs/DESIGN.md`
- Smoke test checklist: `docs/SMOKE_TEST.md`
- Implementation roadmap: `ROADMAP.md`

## Self-test command
```bash
npm run test:smoke
```
