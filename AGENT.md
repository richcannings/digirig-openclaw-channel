# Reference for AI Agents: DigiRig OpenClaw Channel

This document is a reference for AI agents assisting in this repository.

## What This Is

An OpenClaw channel plugin that connects amateur radio to an AI assistant via DigiRig Mobile USB interface. Voice in, voice out, with DTMF, APRS, and carrier sensing.

## Key Architecture Decisions

### Audio Pipeline
- `arecord` captures raw PCM from DigiRig USB audio device
- `AudioMonitor` handles VAD with dual-tier energy thresholds:
  - `energyThreshold` (0.1) triggers recording start
  - `carrierSenseThreshold` (0.0008) keeps recording alive during speech pauses
- Pre-roll buffer (600ms) captures audio before trigger
- Post-utterance, audio goes to Whisper STT (hot daemon on port 18088, cold CLI fallback)

### PTT Control
- Serial RTS via `serialport` library. The channel runtime OWNS the serial port.
- External scripts CANNOT key PTT while channel is running (port lock).
- TX API on port 18089 accepts raw PCM and handles PTT internally.
- 300ms lead delay before audio for radio/repeater settling.
- Triple carrier-sense: holdoff wait → final energy check → listen during lead delay.

### Callsign Processing
- Post-STT fuzzy matching corrects garbled callsigns using SCCARC roster (141 entries) + dynamically heard callsigns
- Levenshtein distance ≤2 for corrections
- LLM identifies sender via `[SENDER:CALLSIGN]` tag (stripped before TTS)
- `RX_SENDER` log entries enrich the structured logs

### DTMF
- Previous approach (TTS pipeline routing) failed — tones not decoded by repeater
- Current: standalone `scripts/dtmf-send.mjs` generates raw PCM sine waves
- `--tx` flag POSTs to TX API (port 18089) which handles PTT
- 911 emergency sequences blocked by default (`--allow-emergency` required)

### Prompt Structure (src/prompt.ts)
15 sections covering: brevity, continuity, multi-operator, STT correction, signal reports, net check-ins, inspiring hams, ARES, sender ID, channel management, FCC legitimacy, security, DTMF, special callsigns.

## File Layout

```
src/
  runtime.ts        — Main loop, TX API, callsign matching, speak()
  audio-monitor.ts  — RX capture, VAD, energy, carrier sense
  prompt.ts         — Ham radio operator persona
  ptt.ts            — Serial PTT control
  tts.ts            — TTS synthesis + aplay
  config.ts         — Zod config schema
  defaults.ts       — Default config values
  channel-core.ts   — OpenClaw channel integration
  state.ts          — Plugin runtime state

scripts/
  dtmf-send.mjs     — DTMF tone CLI
  digirig-tail.cjs  — Pretty log viewer

skills/
  digirig-tones/    — DTMF skill + K6BJ/AllStar codes

docs/
  ROADMAP-CURRENT.md — Active roadmap
  DESIGN.md          — Architecture
  DTMF-DESIGN.md     — DTMF CLI design

archive/
  dtmf-experiment/   — Old TTS-based DTMF (failed approach)
  stale-docs/        — Superseded documentation
```

## Don't Do These Things
- Don't route DTMF through TTS — it doesn't work (frequencies get filtered)
- Don't try to use ptt-on.js/ptt-off.js while the channel is running (port lock)
- Don't assume the AI can execute shell commands reliably from the radio session — tool calling is inconsistent
- Don't hardcode callsigns — use config values
- Don't log personal info from the SCCARC roster (it contains only callsigns + names, not contact info)
