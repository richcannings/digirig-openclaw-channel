# DigiRig Main-Branch Architecture (stashed)

This patch set captures the **main-branch refactor** (post-b4f8542) that introduces a new runtime and STT stack. Summary of the architecture as of the saved patches:

## Core Runtime
- **VoiceCallCapture** handles audio capture (frame-based, energy logging, and RX windowing).
- **PTT controller** gates TX with lead/tail timing and optional capture muting.
- **Shared helpers** moved to `src/shared/*` (metrics, audio, text formatting, etc.).

## STT Pipeline
- **OpenAI Realtime STT provider** is the primary streaming STT path.
  - `OpenAIRealtimeSTTProvider` / `OpenAIRealtimeConfigurableSTTProvider` manage sessions.
  - Audio is sent as mu-law (or PCM depending on path) with TX suppression handling.
- **Local Whisper fallback** exists for RX:
  - Used when realtime STT is unavailable.
  - Captures RX windows and runs local whisper for offline transcription.

## Calibration & Metrics
- **calibrateRx()** performs live level calibration while capture is running:
  - Steps capture gain across a range (min→max) and samples RMS/peak.
  - Targets RMS ~ -24 to -12 dBFS and peak ~ -9 to -3 dBFS.
  - Produces a summary including clipped/ok status.
- **Response timing metrics** logged per RX/TX cycle.

## Key Files
- `src/runtime.ts`: main orchestration of capture, STT routing, calibration, and TX.
- `src/shared/*`: reusable audio/metrics/text helpers.
- `index.ts`: command registration (`/digirig`), runtime wiring.
- `src/openai-realtime-stt-provider.ts`: OpenAI realtime STT integration.

## Patch Files
- `0001-docs-refresh-README-design-notes.patch`
- `0002-Refactor-shared-helpers-and-runtime-updates.patch`
- `0003-Add-local-Whisper-fallback-for-DigiRig-RX.patch`

These patches can be re-applied later with:
```bash
git am /path/to/patches/*.patch
```
