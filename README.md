# DigiRig OpenClaw Channel

Talk to OpenClaw over ham radio.

This plugin provides a bridge between voice ham radio operations and OpenClaw.

This plugin provides:
- Speech-to-text to agent to text-to-speech pipeline using a robust batch-transcription approach.
- digirig PTT handling and VOX support 
- Carrier detection and transmission queuing for half-duplex operation
- Transcription logging
- `/digirig tx` manual transmit a message over-the-air
- `/digirig calibrate` AI assisted audio-level calibration
- `/digirig doctor` service + listener diagnostics
- `/digirig setup` prints host-aware setup commands

---

## Quick Start (no-brainer setup)

This plugin assumes a local Python `whisper` CLI installation for reliable, batch-based transcription of radio transmissions.

## 1) Install plugin
```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/richcannings/digirig-openclaw-channel
cd digirig-openclaw-channel
npm install
openclaw plugins install -l ~/src/digirig-openclaw-channel
```

## 2) Configure audio + PTT
```bash
# inspect devices
arecord -l
aplay -l

# set DigiRig devices
openclaw config set channels.digirig.audio.inputDevice "plughw:0,0"
openclaw config set channels.digirig.audio.outputDevice "plughw:0,0"

# If you get `arecord exited with 1` (rate inaccuracy) or capture contention,
# use the ALSA plug wrapper with dsnoop:
openclaw config set channels.digirig.audio.inputDevice 'plug:"dsnoop:CARD=Device,DEV=0"'

# set PTT serial
openclaw config set channels.digirig.ptt.device "/dev/ttyUSB0"
openclaw config set channels.digirig.ptt.rts true
```

## 3) Configure STT endpoint (Local Whisper)
We use a robust batch processing method that waits for you to finish speaking, then transcribes the whole sentence perfectly using the local Whisper CLI.

```bash
openclaw config set channels.digirig.stt.localWhisper.command "/home/richc/.openclaw/venv/whisper-live/bin/whisper"
openclaw config set channels.digirig.stt.localWhisper.model "base"
```

## 4) Set callsign + policy
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
openclaw config set channels.digirig.tx.policy "proactive"   # proactive | direct-only
openclaw config set channels.digirig.tx.aliases "Overlord,Lord,Seven,7"
```

## 5) Latency-focused RX defaults (recommended)
```bash
openclaw config set channels.digirig.rx.maxSilenceMs 4000  # 4s wait before transcribing
openclaw config set channels.digirig.rx.busyHoldMs 800
openclaw config set channels.digirig.rx.minSpeechMs 500
openclaw config set channels.digirig.rx.maxRecordMs 120000
openclaw config set channels.digirig.rx.preRollMs 300
```

## 6) Restart gateway
```bash
openclaw gateway restart
```

## 7) On-air test
Transmit:
> “Overlord, this is Rich W6RGC. What is 2 plus 2?”

*Wait ~4 seconds for the silence timeout, then ~2 seconds for the batch transcription.* You should hear a spoken response and see RX/TX lines in:
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

### Doctor check
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

- Find who has the USB audio device open (for `arecord exited with 1`):
```bash
fuser -v /dev/snd/*
lsof /dev/snd/* | grep -E 'pcmC[0-9]+D[0-9]+[cp]|controlC'
```

---

## Docs
- Design notes: `docs/DESIGN.md`
- Smoke test checklist: `docs/SMOKE_TEST.md`
- Implementation roadmap: `ROADMAP.md`
- Agent documentation: `AGENT.md`

## Self-test command
```bash
npm run test:smoke
```
