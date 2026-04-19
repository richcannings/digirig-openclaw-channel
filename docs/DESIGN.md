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
4. **TX Worker (Unified Priority Queue)**: Serializes all outbound RF events. Handles Voice TTS, DTMF tones, latency acknowledgments, and future data packets. Applies courtesy delays and anti-doubling, keys PTT, plays PCM, unkeys.

### Latency Acknowledgments
To prevent dead air and duplicate transmissions during tool usage, the channel implements a timeout-based latency acknowledgment system.
- If the TTS engine does not provide voice output within a configured timeout (e.g., 2000ms) after the user unkeys, a "Stand by" tone or voice prompt is jumped to the front of the TX Queue.
- The system keys up, plays the short acknowledgment, and unkeys, leaving the channel free while the AI thinks.
- See [PRD_latency_ack.md](./PRD_latency_ack.md) for full logic.

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
- Unified Priority TX Queue (Voice, DTMF, Acks)
- Structured logging

### In OpenClaw core (reused)
- Agent routing and dispatch
- TTS synthesis
- Session management
- Tool execution (exec, web_fetch, etc.)
- Skill loading

### Future Vision: Digital Bridge & Radio Control
The channel aims to become a true "digital bridge" linking analog radio environments with AI and packet networks:
- **Direwolf Integration**: Using the [Direwolf software modem](https://github.com/wb2osz/direwolf) for native packet radio (AX.25). The TX Queue will be able to dispatch binary packet payloads directly over RF.
- **CAT Control**: Instructing the radio via serial CAT commands to swap frequencies, change modes, or monitor dual-VFO setups. 
- **Use Case Example**: The AI receives a voice request to send an APRS message. It uses CAT control to QSY to the APRS frequency (e.g., 144.390 MHz), dispatches a Direwolf packet through the TX Queue, and then uses CAT control to return to the voice frequency. With dual-VFOs, it could even monitor digital and voice frequencies simultaneously.

## Config Schema (DigirigConfig)
- `audio` — input/output device, sample rate
- `ptt` — serial device, RTS, lead/tail timing
- `rx` — energy thresholds, silence/speech timing, carrier sense, pre-roll
- `tx` — callsign, policy, aliases, max TX duration
- `stt` — local Whisper config (daemon, CLI, model, language)
- `tones` — latency acknowledgment timeouts and WAV asset paths
- `llm` — per-channel model override and offline/Ollama fallback settings

### Offline Survivability & EmComm
Ham radio is fundamentally about communication when all else fails. The OpenClaw DigiRig channel is designed to survive internet outages. By configuring an `llm.fallbackModel` (e.g., to a local Ollama instance), the system will automatically trap network timeouts and route the radio session to the local AI. Combined with local Whisper STT, local TTS, and Direwolf packet routing, the AI remains fully operational during emergencies without cloud dependency.

## Ports
- **18088** — Whisper STT hot daemon
- **18089** — TX API (raw audio with PTT control)
