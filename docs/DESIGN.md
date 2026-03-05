# DigiRig Channel Design (Current)

## Goal
A minimal, reliable OpenClaw ham-radio channel with low RX-end → TX-start latency.

## Principles
- Keep DigiRig plugin focused on RF-specific concerns only.
- Reuse OpenClaw routing/session/dispatch primitives wherever possible.
- Prefer small increments with live on-air validation after each change.

## Current Architecture
### Kept in plugin (RF-specific)
- ALSA capture framing (`audio-monitor.ts`)
- PTT RTS control (`ptt.ts`)
- STT transport adapter (`whisperlive-transcriber.ts` implementing `Transcriber`)
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
3. **STT abstraction**
   - added `Transcriber` interface
   - WhisperLive moved behind adapter
4. **Latency tuning**
   - reduced finalize deferral
   - adaptive STT wait (fast pass + fallback pass)
   - practical RX settings tuned for ~5s observed turnaround

## Policy Modes (current)
- `proactive`
- `direct-only`

## Operational Notes
- RX/TX transcript remains in `~/.openclaw/logs/digirig-YYYY-MM-DD.log`
- `/digirig tx` and `/digirig calibrate` are preserved
- PTT unkey is protected in `finally`

## Known Practical Latency Budget
Observed ~5s is typically dominated by:
- model + dispatch latency
- TTS generation
- PTT lead/audio start

RX silence gate tuning improved response significantly from prior 11–12s behavior.

## Next Design Direction
Continue shrinking runtime surface by:
- isolating policy decisions into a compact policy module
- moving reusable non-RF helpers upstream/shared where practical
- preserving strict RF reliability invariants (PTT safety, restart safety, deterministic stop)
