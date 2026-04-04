# DigiRig Channel Design

## Goal
A reliable OpenClaw ham-radio channel with low RX→TX latency and multi-mode output capability.

## Principles
- Keep plugin focused on RF-specific concerns only
- Reuse OpenClaw routing/session/dispatch primitives
- Prefer small increments with live on-air validation
- Ham radio soul first, software engineering second

## Architecture

### RX Pipeline
```
arecord (ALSA) → AudioMonitor → utterance event
  → Whisper STT (hot daemon port 18088, CLI fallback)
  → normalizeSttText() → correctCallsignsInText()
  → isDirectCall() routing check
  → OpenClaw agent dispatch with HAM_RADIO_PROMPT
```

### TX Pipeline (Voice)
```
LLM response → extract [SENDER:] tag → formatRadioReply()
  → appendCallsign() → synthesizeTts() → waitForClearChannel()
  → Triple carrier-sense check → PTT key → 300ms lead
  → aplay → tail delay → PTT unkey → 1500ms post-mute
```

### TX Pipeline (Raw Audio / DTMF)
```
HTTP POST /tx/raw (port 18089) → waitForClearChannel()
  → Triple carrier-sense → PTT key → 300ms lead
  → aplay raw PCM → tail delay → PTT unkey
```

### Anti-Doubling (3 checks)
1. **Holdoff wait** — Poll `getBusy()` until 800ms silence (timeout → drop)
2. **Final energy** — `isCarrierPresent()` right before PTT key
3. **Lead listen** — Sample carrier during 300ms lead delay, abort if detected
- Up to 3 attempts with 1200ms backoff between retries

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
