# 📻 DigiRig OpenClaw Channel

**Turn your ham radio into a direct link to an advanced AI assistant.**

This plugin bridges the gap between analog RF and modern Large Language Models using a [DigiRig Mobile](https://digirig.net/) interface. Whether you are out in the backcountry with a handheld or sitting at your base station, your AI agent is just a PTT press away.

Building an AI for two-way radio isn't as simple as plugging a chatbot into a microphone. Analog radio is messy. This plugin is engineered specifically for the brutal realities of RF. It uses a custom **Dual-Tier Voice Activity Detector** that tracks raw analog noise floors to perfectly handle squelch tails. It masks the physical electrical pops of PTT relays, calculates real-time signal strength (RMS/Peak dBFS) for authentic on-air signal reports, and leverages a hot-loaded GPU Whisper daemon for sub-second transcription. 

It doesn't just listen—it behaves like a disciplined amateur radio operator. If you want to merge the bleeding edge of AI with the original maker hobby, you are in the right place.

---

## 🚀 Recent Performance Improvements (Dec 2024)

**Major Speed Optimizations:**
- **Model Switch:** Claude Opus → Claude Sonnet = **2.2x faster responses** (16s → 7s average)
- **Timeout Reduction:** PTT silence detection optimized from 500ms to **250ms**
- **Enhanced Persona:** Conversational continuity, emergency protocols, inspiring new hams
- **Field Tested:** Successfully operating on K6BJ repeater with positive operator feedback

**Current Performance:**
- **Target Response Time:** <3 seconds (PTT release → audio response)
- **Actual Performance:** ~7 seconds average (significant improvement from 16s)
- **Bottleneck:** LLM processing (STT and audio very fast at ~400-1200ms)

---

### Core Capabilities
- Speech-to-text to agent to text-to-speech pipeline using a robust batch-transcription approach.
- digirig PTT handling and VOX support 
- Carrier detection and transmission queuing for half-duplex operation
- **Structured JSON Logging:** High-precision metrics (latency, STT time) and RF signal reports (RMS/Peak dBFS) for every transmission.
- **RF Signal Reporting:** The AI is automatically fed actual signal strength data to provide authentic "loud and clear" reports.
- `/digirig tx` manual transmit a message over-the-air
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

## 3) Configure STT endpoint (Ultra-Fast Hot-Loaded Daemon)
We use a robust batch-processing approach. To completely eliminate the 2-4 second "cold start" delay of loading the AI model for every transmission, we run a tiny Python HTTP daemon in the background that keeps the model hot in your GPU's VRAM.

```bash
# This sets up the hot-loaded daemon as a background service:
./scripts/setup-stt-daemon.sh
```

If you don't run this script, OpenClaw will gracefully fall back to the slow, cold-start `whisper` CLI command.

*(To configure which model the daemon uses, edit the `ExecStart` line in `~/.config/systemd/user/whisper-daemon.service` and run `systemctl --user daemon-reload && systemctl --user restart whisper-daemon.service`. For RTX 3060+, `medium.en` is highly recommended).*

## 4) Set callsign + policy
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
openclaw config set channels.digirig.tx.policy "proactive"   # proactive | direct-only
openclaw config set channels.digirig.tx.aliases "Overlord,Lord,Seven,7"
```

## 5) Latency-focused RX defaults (recommended)
```bash
openclaw config set channels.digirig.rx.energyThreshold 0.1         # Trigger recording when you speak
openclaw config set channels.digirig.rx.carrierSenseThreshold 0.0008 # Keep recording alive while squelch is open
openclaw config set channels.digirig.rx.maxSilenceMs 500            # Snappy 500ms timeout after squelch closes
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

*Unkey the radio and wait ~500ms for the silence timeout, then ~2 seconds for the batch transcription.* You should hear a spoken response and see RX/TX lines in:
```bash
~/.openclaw/logs/digirig-YYYY-MM-DD.log
```

---

## Commands

### Manual TX
```bash
/digirig tx Hello from OpenClaw
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

- Check DigiRig logs (Plaintext view):
```bash
openclaw logs --plain | grep -i digirig | tail -n 80
```

- Query Latency Metrics (JSON view):
```bash
tail -n 20 ~/.openclaw/logs/digirig-$(date +%Y-%m-%d).log | jq '. | select(.type=="METRIC")'
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
