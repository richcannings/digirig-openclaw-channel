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
- Anti-doubling: busy-hold wait + courtesy delay (default 2s) + final carrier check 50ms before keying. Up to 3 retries with 1200ms backoff.
- `/digirig unkey` is an operator-safety command that drops PTT immediately, aborts the in-flight TX, and drains the queue.

### Text-to-Speech
Two paths, picked by `channels.digirig.localTts.engine`:
- `"piper"` or `"kokoro"`: local HTTP daemon (installed by `scripts/setup-{piper,kokoro}-daemon.sh`). No network, no API keys, no per-call cost.
- `"off"` (default): cloud TTS via OpenClaw's `runtime.tts.textToSpeechTelephony` — depends on whichever speech provider is configured under `messages.tts.providers.*`.

Daemons expose a shared HTTP contract (`POST /tts` with `{text}`, returns raw 16-bit PCM + `X-Sample-Rate` header) — new backends can be added by dropping a new daemon with the same shape and wiring the enum in `config.ts`.

### Callsign Processing
- Post-STT fuzzy matching corrects garbled callsigns using SCCARC roster (141 entries) + dynamically heard callsigns
- Levenshtein distance ≤2 for corrections
- LLM identifies sender via `[SENDER:CALLSIGN]` tag (stripped before TTS)
- `RX_SENDER` log entries enrich the structured logs

### DTMF
- Previous approach (TTS pipeline routing) failed — tones not decoded by repeater
- Current: standalone `scripts/dtmf-send.mjs` generates raw PCM sine waves
- `--tx` flag POSTs to TX API (port 18089) which handles PTT
- `--say TEXT` flag speaks a voice ack FIRST via `POST /tx/text`, then plays tones via
  `POST /tx/raw`. Both jobs go through the same FIFO TX queue, so voice-before-tones
  ordering is guaranteed regardless of LLM behavior. The AI is instructed via the
  `digirig-tones` skill to always use `--say` for on-air DTMF.
- `executeRawTx` mutes the AudioMonitor BEFORE keying PTT (matching voice-TX). Do NOT
  add a post-keyup carrier check: the DigiRig's own keyup transient saturates the RX
  line at ~1000× the carrier-sense threshold and would false-abort every attempt.
- 911 emergency sequences blocked by default (`--allow-emergency` required)

### Prompt Structure (src/prompt/)
The system prompt is assembled in `src/prompt/index.ts` from concern-specific files:

- `persona.ts` — who the AI is and how it talks (sections 1–6)
- `perception.ts` — STT hallucinations + signal-report interpretation
- `contracts.ts` — output tags the plugin parses, e.g. `[SENDER:CALLSIGN]`
- `protocols.ts` — net check-ins, ARES, doubling, FCC
- `safety.ts` — absolute security rules
- `capabilities.ts` — `CapabilityBlock[]` registry: DTMF, APRS (each entry points at its
  `skills/<id>/SKILL.md`)
- `operators.ts` — per-operator quirks (WB6DWP cheeky, etc.)

`formatSignalReport()` in the same file builds the per-message `[System Data]`
block referenced by `perception.ts` section 8. The voice↔LLM pipeline in
`runtime.ts` only imports `HAM_RADIO_PROMPT` and `formatSignalReport`.

### Latency Acknowledgment (runtime.ts + src/pipeline/audio-assets.ts)
If the LLM dispatcher doesn't deliver text within `tones.timeoutMs` (default 2000 ms)
after an RX ends, a pre-loaded "Stand by" WAV is `unshift`'d to the front of the TX
queue. On hard dispatch failure, `error.wav` is injected instead. WAVs are eager-loaded
on channel start so there's no disk I/O in the hot path.

## File Layout

```
index.ts               — Channel registration, /digirig commands, digirig_tx tool
src/
  runtime.ts           — Four async workers (RX → STT → agent → TX), TX API on :18089
  audio-monitor.ts     — RX capture, VAD, energy, carrier sense
  prompt/              — Ham radio persona split by concern (see "Prompt Structure" above)
  ptt.ts               — Serial PTT control
  tts.ts               — TTS synthesis + aplay
  config.ts            — Zod config schema
  defaults.ts          — Default config values
  channel-core.ts      — OpenClaw dispatch + per-channel LLM override
  state.ts             — Plugin runtime singleton
  pipeline/
    queue.ts           — Async FIFO with priority unshift
    audio-assets.ts    — Eager-loaded tone WAV cache

scripts/
  dtmf-send.mjs            — DTMF tone CLI (raw PCM to :18089/tx/raw; optional
                            --say TEXT plays voice ack first via :18089/tx/text)
  aprs.mjs                 — findu.com APRS helper
  stt_daemon.py            — Hot-loaded Whisper HTTP daemon on :18088
  piper-daemon.py          — Piper TTS HTTP daemon on :18090
  kokoro-daemon.py         — Kokoro-82M TTS HTTP daemon on :18091
  setup-stt-daemon.sh      — Installs whisper-daemon.service
  setup-piper-daemon.sh    — Installs piper-daemon.service + binary + voice
  setup-kokoro-daemon.sh   — Installs kokoro-daemon.service + model + voices
  digirig-tail.cjs         — Pretty log viewer (auto-rotates)
  generate-assets.sh       — Regenerate standby/error tone WAVs

skills/
  digirig-tones/       — DTMF skill + K6BJ/AllStar codes
  digirig-aprs/        — APRS via findu.com

docs/
  ROADMAP.md           — Feature roadmap
  claude-redesign.md   — Current plan of record (latency + simplicity)
  DESIGN.md            — Architecture
  PIPELINE-THREADING.md — Async-queue diagram + explanation
  PRD_latency_ack.md   — Shipped
  PRD_radio_llm_fallback.md — Shipped
  DESIGN_audio_assets.md — Latency-ack WAV loading

archive/
  stale-docs/tts-streaming-design.md — deferred streaming-TTS exploration
                                       (referenced from docs/ROADMAP.md V6)
```

## Don't Do These Things
- Don't route DTMF through TTS — it doesn't work (frequencies get filtered)
- Don't try to key PTT from outside the channel runtime — the serial port is exclusively owned by the channel (port lock)
- Don't assume the AI can execute shell commands reliably from the radio session — tool calling is inconsistent
- Don't hardcode callsigns — use config values
- Don't log personal info from the SCCARC roster (it contains only callsigns + names, not contact info)

## Hard Operational Constraints
- **DTMF Generation**: Never route DTMF through TTS. It is proven to fail. Always use the `dtmf-send.mjs` script via the `digirig-tones` skill to inject raw PCM.
- **Over-Response Bug**: The system sometimes responds too often and interrupts third-party conversations. We need to improve the conversational continuity logic so it only transmits when directly addressed or contextually required, rather than triggering on unrelated traffic.
- **Tactical Callsigns**: Never assign tactical callsigns (e.g., "Bridges"). Operators find them confusing. Only use them if explicitly requested.
