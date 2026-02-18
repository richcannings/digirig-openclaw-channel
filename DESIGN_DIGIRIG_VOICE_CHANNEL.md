# DigiRig Voice Channel Design (OpenClaw)

**Document name:** DigiRig Voice Channel  
**Version:** 1.0  
**Status:** Draft  
**Owner:** OpenClaw Channels  
**Audience:** OpenClaw plugin developers, system integrators, operations

---

## 1. Overview

The DigiRig Voice Channel is an OpenClaw channel plugin that bridges ham radio voice interactions into the OpenClaw conversational system. It enables one or more radio operators to speak over RF, have their speech transcribed to text, routed through OpenClaw’s agent system, and receive spoken replies transmitted back over the radio.

This channel provides a voice interaction surface comparable in richness to a WhatsApp Channel, with structured routing, context/session handling, command processing, and response delivery. It also enforces ham-radio-appropriate policies for when the system is allowed to transmit.

---

## 2. Goals

- **Bidirectional voice interface**: RX (receive) audio → speech-to-text → OpenClaw agent response → text-to-speech → TX (transmit) audio.
- **Low-latency interaction**: Streaming STT via WhisperLive WebSocket for fast turnarounds.
- **Operational safety**: Enforce policy constraints on when the system may transmit.
- **Simple local deployment**: Uses local audio devices and a DigiRig (or similar) audio/PTT interface.
- **Traceability**: Logs RX/TX transcripts and latency metrics.

---

## 3. Non-Goals

- Support for media attachments or rich cards.
- Multi-party chat threading.
- Cloud-hosted STT/TTS services (local by default).

---

## 4. System Context

**External dependencies:**
- **DigiRig or equivalent**: audio interface + PTT control via serial.
- **ALSA** tools: `arecord` and `aplay` for raw audio capture and playback.
- **WhisperLive** (local): WebSocket STT server (collabora/WhisperLive).
- **OpenClaw runtime**: routing, session recording, TTS, and agent dispatch.

---

## 5. Architecture

### 5.1 High-Level Flow

1. **RX Audio Capture**
   - `arecord` reads raw PCM from input device.
   - AudioMonitor performs VAD-like energy detection and buffers frames.
2. **STT**
   - PCM frames are streamed to WhisperLive over WebSocket.
   - Final transcript is read after end-of-utterance idle.
3. **Routing**
   - Transcribed text is packaged into OpenClaw inbound context.
   - Route resolution selects agent and session.
4. **Agent Reply**
   - OpenClaw dispatches a reply (with channel formatting).
   - Reply is shortened and appended with callsign as needed.
5. **TX Playback**
   - TTS generates PCM audio.
   - PTT is asserted via serial, audio is played, PTT released.

### 5.2 Components

- **`index.ts` (Plugin Entry)**
  - Registers channel plugin, command (`/digirig tx`), and agent tool (`digirig_tx`).
- **`config.ts`**
  - Zod schema for configuration (audio/PTT/RX/STT/TX).
- **`runtime.ts`**
  - Core runtime orchestrator:
    - AudioMonitor events
    - STT streaming and finalization (WhisperLive WS)
    - Routing and dispatch
    - TX queueing
- **`audio-monitor.ts`**
  - Energy-based speech detection + buffering.
- **`stt-ws.ts`**
  - WhisperLive WebSocket client (PCM streaming).
- **`tts.ts`**
  - Wraps OpenClaw TTS and plays PCM via `aplay`.
- **`ptt.ts`**
  - Serial RTS control for PTT with lead/tail delays.

---

## 6. Detailed Design

### 6.1 RX Audio Pipeline

**AudioMonitor behavior**
- Captures frames of PCM at configured `frameMs`.
- Computes RMS energy per frame.
- Starts recording on threshold exceedance (with a short start cooldown to avoid tail retriggers).
- Stops recording after `maxSilenceMs` or `maxRecordMs`.
- Emits:
  - `recording-start`
  - `recording-frame`
  - `recording-end`
  - `utterance` (final PCM for STT)

**Pre-roll**
- Maintains a short pre-roll buffer so the beginning of speech is not clipped.

### 6.2 STT (WhisperLive WebSocket)

- PCM frames are streamed to WhisperLive during recording.
- After end-of-utterance, the client waits for idle and reads the latest transcript.
- No HTTP fallback or final-only pass: WS is the single source of truth.

**Normalization**
- Removes blank or bracketed artifacts and very short fragments.

### 6.3 Routing + Session Context

- Builds an OpenClaw inbound message:
  - Radio traffic is forced into a dedicated **digirig:radio** session.
  - `Body` formatted via OpenClaw envelope formatting.
- Records inbound session to store path.

### 6.4 Policy Enforcement

**Transmit policy (`tx.policy`)**
- `direct-only`: only respond if the callsign/alias appears in input.
- `value-and-wait`: require direct call and inject a delay before responding.
- `proactive`: allow responses without explicit direct call.

**Alias inference**
- If `tx.aliases` empty, attempts to infer from `IDENTITY.md`.

### 6.5 TX Pipeline

- Uses outbound queue to serialize transmissions.
- Optional capture mute (ALSA `amixer`) while transmitting.
- Mutes RX during TX to prevent self‑triggered sessions.
- PTT lead/tail timing to avoid clipping.

### 6.6 Reply Formatting

- Trims to a single sentence or max ~140 chars.
- Appends callsign if missing.
- Suppresses policy/refusal language on-air; sends “Received.” as fallback.
- Special handling of closing phrases to reply with “Thanks, seven three.”

---

## 7. Operational Considerations

### 7.1 Configuration

Key settings (see `openclaw.plugin.json`):

- **Audio**
  - `audio.inputDevice`, `audio.outputDevice`, `audio.sampleRate`
- **PTT**
  - `ptt.device`, `ptt.rts`, `ptt.leadMs`, `ptt.tailMs`
- **RX**
  - `rx.energyThreshold`, `rx.minSpeechMs`, `rx.maxSilenceMs`, `rx.maxRecordMs`
- **STT**
  - `stt.wsUrl` (WhisperLive WebSocket endpoint)
- **TX**
  - `tx.callsign`, `tx.policy`, `tx.aliases`

### 7.2 Logging

- Transcript logs at `~/.openclaw/logs/digirig-YYYY-MM-DD.log`
- Response timing metrics appended in transcript logs.

### 7.3 Failure Modes

- `arecord` errors are logged; audio monitor stops on failure.
- STT failures → logged; next utterance will try again.
- PTT not configured → TX silently disabled if `ptt.rts=false`.

---

## 8. Security and Compliance

- Local-only STT server (recommended for privacy).
- No remote calls beyond configured STT endpoint.
- PTT gating ensures that transmission is intentional and policy-compliant.

---

## 9. Related Systems & Patterns

This design mirrors common patterns in modern voice pipelines:
- Streaming STT via WhisperLive WebSocket: low-latency transcript updates during capture.
- VAD-based sessioning (RealtimeSTT, WebRTC VAD): explicit start and stop gating and cooldowns to avoid tail retriggers.
- Duplex protection: muting local RX during TX to prevent self-triggered loops.

Our implementation combines these patterns with explicit TX policy gating and ham-radio-friendly formatting.

## 10. Improvements (Build on Current Design)

Small, incremental upgrades that preserve the current architecture:
- RX timing metrics: log both PTT release to TX start and RX end to TX start for operator-perceived latency.
- Adaptive cooldown: increase start cooldown automatically after a TX event to reduce post-TX retriggers.
- VAD refinement: optional hysteresis start stop thresholds if operating environments are noisy.
- Agent reply constraints: concise radio-mode prompts and length caps to reduce TTS time.

---

## 11. Summary

The DigiRig Voice Channel integrates ham radio audio into OpenClaw with robust RX detection, WhisperLive streaming STT, policy-aware routing, and controlled TX. It delivers a conversational experience comparable to chat-based channels while respecting RF constraints and operator intent.