# Agent Context

This repository is an OpenClaw plugin for integrating ham radio operation via a DigiRig Mobile interface.

## Purpose
It allows users to communicate with their AI agents over RF (radio frequency) using half-duplex (Push-To-Talk) hardware. 

## High-Level Architecture
1. **Audio Capture**: `src/audio-monitor.ts` constantly listens to the configured ALSA audio device. It manages Voice Activity Detection (VAD) and groups frames into discrete `utterances`.
2. **Batch Transcription**: When an utterance ends (silence timeout met), the raw PCM buffer is sent via HTTP POST to a **hot-loaded Python HTTP daemon** (`127.0.0.1:18088`). If the daemon is unavailable, the system gracefully falls back to executing a slow, cold-start `whisper` CLI process (`src/runtime.ts` -> `transcribeWithLocalWhisper`).
3. **Dispatch**: The text transcription is wrapped as a chat payload and routed to the OpenClaw core agent logic (`src/channel-core.ts`).
4. **Text-To-Speech (TTS)**: When the agent replies, OpenClaw synthesizes the text into PCM audio.
5. **PTT & Playback**: The plugin triggers the Request-To-Send (RTS) line via the serial port (`src/ptt.ts`) to key the radio, waits for the transmitter to settle, and pipes the PCM data through `aplay` (`src/tts.ts`).

## Recent Paradigm Shift (Crucial for Context)
**Do not introduce streaming or WebSocket-based Speech-to-Text.**
We migrated *away* from real-time streaming (WhisperLive WebSockets) because half-duplex radio squelch tails and mid-sentence pauses confuse streaming models, leading to stuttering and hallucinations. The architecture is explicitly designed around **single-shot batch execution** after the `maxSilenceMs` is met.

## Key Configuration (OpenClaw Global Config)
- `channels.digirig.audio.inputDevice`: Must wrap dsnoop in a plug interface to fix hardware samplerate inconsistencies (e.g., `plug:"dsnoop:CARD=Device,DEV=0"`).
- `channels.digirig.stt.localWhisper.model`: Defaults to `base`, but `medium.en` or `large-v3` is highly recommended for systems with a dedicated GPU (e.g. RTX 3060) to correctly handle ham radio static and parse callsigns.
- `channels.digirig.rx.energyThreshold` and `channels.digirig.rx.carrierSenseThreshold`: A two-tier VAD system. `energyThreshold` (e.g. 0.1) triggers the recording when the user speaks. `carrierSenseThreshold` (e.g. 0.0008) keeps the channel busy and recording alive as long as the radio's squelch is open (even if the user pauses).
- `channels.digirig.rx.maxSilenceMs`: Because the system tracks the actual squelch drop, this can be set very low (e.g. 500ms) for snappy, sub-second STT processing when the user unkeys.
- `channels.digirig.ptt.device`: The TTY device for the DigiRig (usually `/dev/ttyUSB0`).

## File Map
- `index.ts`: Plugin entrypoint and basic definition.
- `src/runtime.ts`: The main state machine connecting the AudioMonitor, Transcriber, and OpenClaw dispatch.
- `src/audio-monitor.ts`: Heavy-lifting wrapper around `arecord` handling PCM capture, RMS energy checking, and chunking.
- `src/channel-core.ts`: Helpers for interacting with the parent OpenClaw gateway environment.
- `src/ptt.ts`: Serial port RTS controller.
- `src/tts.ts`: `aplay` wrapper and OpenClaw SDK text-to-speech invocation.
- `src/config.ts` / `src/defaults.ts`: Zod schema and defaults.

## Testing
Always run `npm run test:smoke` or `vitest run` before pushing changes.

If diagnosing hardware issues, suggest ALSA commands (`amixer`, `aplay -l`, `arecord -l`) as the DigiRig hardware is heavily reliant on ALSA.