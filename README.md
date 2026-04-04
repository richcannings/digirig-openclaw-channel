# 📻 DigiRig OpenClaw Channel

**Turn your ham radio into a direct link to an advanced AI assistant.**

This plugin bridges analog RF and modern Large Language Models using a [DigiRig Mobile](https://digirig.net/) interface. Your AI agent is just a PTT press away — on repeaters, simplex, or any voice frequency.

Built for the realities of RF: dual-tier voice activity detection, squelch tail masking, PTT relay pop suppression, real-time signal strength reporting, and a hot-loaded GPU Whisper daemon for sub-second transcription.

**Operating as W6RGC/AI (Overlord) on K6BJ repeater, Santa Cruz, California.**

---

## What It Does

- **Voice QSOs** — Full-duplex conversational AI on amateur radio
- **DTMF Tones** — Send repeater control codes via standalone CLI + TX API
- **APRS Messages** — Read, send, and locate stations via findu.com
- **Callsign Matching** — Fuzzy-corrects garbled STT callsigns using club roster
- **Anti-Doubling** — Triple carrier-sense check before every transmission
- **FCC Compliance** — Part 97.1 aware, station ID tracking, emergency gate
- **Structured Logging** — JSON logs with metrics, signal reports, LLM-identified senders

## Architecture

```
Radio RX → DigiRig USB Audio → arecord → AudioMonitor (energy/VAD)
  → Callsign fuzzy match (SCCARC roster)
  → Whisper STT (hot daemon or CLI fallback)
  → normalizeSttText() → isDirectCall() check
  → HAM_RADIO_PROMPT injection → OpenClaw agent dispatch → LLM response
  → [SENDER:CALLSIGN] extraction → formatRadioReply() → appendCallsign()
  → Triple carrier-sense check → PTT key → TTS → aplay → PTT unkey

DTMF path: dtmf-send.mjs --tx → POST /tx/raw (port 18089) → PTT + raw PCM
```

## Key Components

| File | Purpose |
|------|---------|
| `src/runtime.ts` | Main runtime: RX/TX loop, TX API server, callsign matching |
| `src/audio-monitor.ts` | Audio capture, VAD, energy detection, carrier sensing |
| `src/prompt.ts` | Ham radio operator persona (15 sections) |
| `src/ptt.ts` | PTT serial control (RTS) |
| `src/tts.ts` | TTS synthesis + aplay playback |
| `src/config.ts` | Zod schema for all DigiRig config |
| `src/defaults.ts` | Default values for all config |
| `src/channel-core.ts` | OpenClaw channel routing integration |
| `scripts/dtmf-send.mjs` | Standalone DTMF tone CLI (zero deps) |
| `scripts/digirig-tail.cjs` | Pretty log viewer with LLM sender attribution |

## Skills

| Skill | Location | Purpose |
|-------|----------|---------|
| `digirig-tones` | `skills/digirig-tones/` | DTMF transmission + K6BJ/AllStar codes |
| `aprs-messages` | `~/.openclaw/workspace/skills/aprs-messages/` | APRS read/send/locate via findu.com |

## Quick Start

### 1) Install plugin
```bash
cd ~/src
git clone https://github.com/richcannings/digirig-openclaw-channel
cd digirig-openclaw-channel
npm install
openclaw plugins install -l ~/src/digirig-openclaw-channel
```

### 2) Configure audio + PTT
```bash
openclaw config set channels.digirig.audio.inputDevice "plughw:0,0"
openclaw config set channels.digirig.audio.outputDevice "plughw:0,0"
openclaw config set channels.digirig.ptt.device "/dev/ttyUSB0"
openclaw config set channels.digirig.ptt.rts true
```

### 3) Set up STT daemon (recommended)
```bash
./scripts/setup-stt-daemon.sh
```
Falls back to cold-start Whisper CLI if daemon isn't running.

### 4) Configure callsign + policy
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
openclaw config set channels.digirig.tx.policy "proactive"
openclaw config set channels.digirig.tx.aliases "Overlord,Lord,Seven,7"
```

### 5) Recommended RX settings
```bash
openclaw config set channels.digirig.rx.energyThreshold 0.1
openclaw config set channels.digirig.rx.carrierSenseThreshold 0.0008
openclaw config set channels.digirig.rx.maxSilenceMs 250
openclaw config set channels.digirig.rx.preRollMs 600
openclaw config set channels.digirig.ptt.leadMs 300
```

### 6) Restart and test
```bash
openclaw gateway restart
```

Transmit: *"Overlord, this is [your callsign]. What is 2 plus 2?"*

## Log Viewer

```bash
node scripts/digirig-tail.cjs
```

Color-coded real-time log with LLM-identified sender callsigns, signal quality, and TX/RX events.

## Commands

| Command | Description |
|---------|-------------|
| `/digirig tx <message>` | Manual transmit |
| `/digirig doctor` | Diagnostics check |
| `/digirig setup` | Auto-detect device setup |

## Docs

| Document | Description |
|----------|-------------|
| `docs/ROADMAP-CURRENT.md` | Active development roadmap with priorities |
| `docs/DESIGN.md` | Architecture and design principles |
| `docs/DTMF-DESIGN.md` | DTMF CLI design document |
| `docs/SMOKE_TEST.md` | Post-update test checklist |
| `docs/HAM_RADIO_AI_OPERATIONS.md` | Comprehensive operations guide |
| `AGENT.md` | AI agent reference for this codebase |

## Current Performance (April 2026)

| Metric | Value |
|--------|-------|
| STT latency | 300-900ms (hot daemon) |
| LLM dispatch | 7-15s (Sonnet), 30-60s (Opus) |
| PTT lead time | 300ms |
| End-of-speech detection | 250ms |
| Anti-doubling | Triple check + 3 retries |
| Callsign correction | Levenshtein ≤2, 141 roster entries |

## License

MIT
