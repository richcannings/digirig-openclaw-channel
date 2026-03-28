# Agent Context

This repository is an OpenClaw plugin for integrating ham radio operation via a DigiRig Mobile interface.

## Purpose
It allows users to communicate with their AI agents over RF (radio frequency) using half-duplex (Push-To-Talk) hardware. 

## High-Level Architecture
1. **Audio Capture**: `src/audio-monitor.ts` constantly listens to the configured ALSA audio device. It manages Voice Activity Detection (VAD) and groups frames into discrete `utterances`.
2. **Batch Transcription**: When an utterance ends (silence timeout met), the entire raw PCM buffer is passed to a local python `whisper` CLI process (`src/runtime.ts` -> `transcribeWithLocalWhisper`).
3. **Dispatch**: The text transcription is wrapped as a chat payload and routed to the OpenClaw core agent logic (`src/channel-core.ts`).
4. **Text-To-Speech (TTS)**: When the agent replies, OpenClaw synthesizes the text into PCM audio.
5. **PTT & Playback**: The plugin triggers the Request-To-Send (RTS) line via the serial port (`src/ptt.ts`) to key the radio, waits for the transmitter to settle, and pipes the PCM data through `aplay` (`src/tts.ts`).

## Recent Paradigm Shift (Crucial for Context)
**Do not introduce streaming or WebSocket-based Speech-to-Text.**
We migrated *away* from real-time streaming (WhisperLive WebSockets) because half-duplex radio squelch tails and mid-sentence pauses confuse streaming models, leading to stuttering and hallucinations. The architecture is explicitly designed around **single-shot batch execution** after the `maxSilenceMs` is met.

## Key Configuration (OpenClaw Global Config)
- `channels.digirig.audio.inputDevice`: Must wrap dsnoop in a plug interface to fix hardware samplerate inconsistencies (e.g., `plug:"dsnoop:CARD=Device,DEV=0"`).
- `channels.digirig.rx.maxSilenceMs`: Set around 4000ms to ensure the operator has completely finished their transmission before we execute STT.
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