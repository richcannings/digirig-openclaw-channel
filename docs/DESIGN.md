# DigiRig Channel Design

## Goal
A reliable OpenClaw ham-radio channel with low RX→TX latency and multi-mode output capability.

## Principles
- Keep plugin focused on RF-specific concerns only
- Reuse OpenClaw routing/session/dispatch primitives
- Prefer small increments with live on-air validation
- Ham radio soul first, software engineering second

## Architecture

### Pipeline Architecture (Threaded)
The runtime now uses an event-driven async queue architecture to decouple capture from processing.
See [PIPELINE-THREADING.md](./PIPELINE-THREADING.md) for the full breakdown and SVG diagram.

```
[RX Audio Worker] → (AudioQueue) → [STT Worker] → (AgentQueue) → [Agent Worker] → (TxQueue) → [TX Worker]
```

1. **RX Worker**: Captures audio continuously, pushes to queue.
2. **STT Worker**: Pops audio, runs Whisper, corrects callsigns, pushes text to queue.
3. **Agent Worker**: Pops text, dispatches LLM, handles async tools and audio acks, pushes response to queue.
4. **TX Worker**: Serializes all PTT events. Applies courtesy delays and anti-doubling, keys PTT, plays PCM, unkeys.

### Anti-Doubling (2 checks + Courtesy Delay)
1. **Courtesy Delay** — Wait `courtesyDelayMs` (default 2s) after last RX before keying up.
2. **Final energy** — `isCarrierPresent()` right before PTT key (last 50ms).
- Up to 3 attempts with 1200ms backoff between retries.
- Mutes the audio monitor *before* keying to ignore the hardware electrical pop.

### Callsign Processing
1. Post-STT: fuzzy match against SCCARC roster + heard callsigns (Levenshtein ≤2)
2. Post-LLM: extract `[SENDER:CALLSIGN]` tag from response, log as RX_SENDER
3. Log viewer uses LLM-identified sender, falls back to regex

## Plugin Boundary

### In plugin (RF-specific)
- ALSA capture/playback
- PTT serial control
- Audio energy detection and VAD
- STT transcription (Whisper)
- Carrier sensing and anti-doubling
- TX API server (port 18089)
- Callsign fuzzy matching
- Structured logging

### In OpenClaw core (reused)
- Agent routing and dispatch
- TTS synthesis
- Session management
- Tool execution (exec, web_fetch, etc.)
- Skill loading

## Config Schema (DigirigConfig)
- `audio` — input/output device, sample rate
- `ptt` — serial device, RTS, lead/tail timing
- `rx` — energy thresholds, silence/speech timing, carrier sense, pre-roll
- `tx` — callsign, policy, aliases, max TX duration
- `stt` — local Whisper config (daemon, CLI, model, language)

## Ports
- **18088** — Whisper STT hot daemon
- **18089** — TX API (raw audio with PTT control)
