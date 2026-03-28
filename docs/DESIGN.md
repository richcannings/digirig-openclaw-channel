# DigiRig Channel Design (Current)

## Goal
A minimal, reliable OpenClaw ham-radio channel with low RX-end → TX-start latency.

## Principles
- Keep DigiRig plugin focused on RF-specific concerns only.
- Reuse OpenClaw routing/session/dispatch primitives wherever possible.
- Prefer small increments with live on-air validation after each change.

## Current Architecture
### Kept in plugin (RF-specific)
- ALSA capture framing and VAD (`audio-monitor.ts`)
- PTT RTS control (`ptt.ts`)
- STT batch processing (`transcribeWithLocalWhisper` in `runtime.ts`)
- PCM playback/TTS output glue (`tts.ts`)

### Reused / extracted channel-core logic
- Inbound context creation
- Session recording
- Reply dispatch wrapper

Implemented in: `src/channel-core.ts`

## Completed Refactor Increments
1. **Lifecycle stability**
   - restart-safe runtime behavior
   - stop/start no longer poisons runtime
2. **Plugin slimming**
   - removed UI hints
   - removed duplicate transcript log path
   - removed identity alias auto-infer
   - removed value-and-wait policy mode
   - removed closing/fallback special-casing and raw/verbose transcript noise
3. **STT Simplification**
   - removed complex `Transcriber` WebSocket streaming
   - migrated entirely to reliable, single-shot batch processing with local Whisper
4. **Latency tuning & VAD**
   - implemented a dual-tier VAD system separating `energyThreshold` (speech) and `carrierSenseThreshold` (static).
   - reduced `maxSilenceMs` to 500ms, as the system now instantly recognizes a hardware squelch drop.
   - synthesized audio is generated *before* keying the PTT relay, avoiding dead-air transmissions.
   - practical RX settings tuned for ~2-3s observed turnaround from PTT-unkey to reply.

## Policy Modes (current)
- `proactive`
- `direct-only`

## Operational Notes
- RX/TX transcript remains in `~/.openclaw/logs/digirig-YYYY-MM-DD.log`
- `/digirig tx` and `/digirig calibrate` are preserved
- PTT unkey is protected in `finally`
- Microphone is explicitly unmuted (`amixer set Mic cap`) on startup to prevent `arecord` failures

## Known Practical Latency Budget
Observed ~1.5-2s is typically dominated by:
- 0.5s `maxSilenceMs` to ensure the squelch is fully dropped
- hot-loaded `whisper-daemon` HTTP execution (0.2s - 0.8s)
- model + dispatch latency
- TTS generation (0.5s - 1s)
- PTT lead/audio start

## Planning Notes
Execution sequencing and future milestones are tracked in `ROADMAP.md` to keep this document focused on current architecture and invariants.
