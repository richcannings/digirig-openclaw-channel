# DigiRig Channel Roadmap

## Status (now)
- Stable on-air RX/TX loop
- Slimmed plugin surface
- Ultra-low latency pipeline via dual-tier VAD (0.5s timeout) and Hot-Loaded HTTP STT Daemon.
- Practical latency around ~2-3s with `medium.en` model + TTS path
- Ham Radio Operator Persona embedded via `src/prompt.ts`
- Comprehensive structured JSON logging (`digirig-*.log`) for transmission metrics

## Completed
- Runtime restart-safety fixes
- PTT unkey `finally` safety
- Removed nonessential features (UI hints, extra fallback branches, duplicate logs)
- Policy simplified to `proactive` and `direct-only`
- `channel-core.ts` extraction for reusable dispatch flow
- Replaced buggy WhisperLive streaming with robust batch local Whisper
- RX timing micro-optimizations and sane defaults (0.0008 carrier sense, 500ms silence)
- Ignored hardware PTT unkey "pops" to fix phantom hallucination loops
- Implemented M0: On-air personality + ham-operator behavior pack (`prompt.ts`)
- Implemented M2: Latency instrumentation (Structured JSON metrics logs)

## Next Milestones (My Prioritization)

### M1 (Highest Priority): TX Safety Interlocks & FCC Compliance
- Max TX duration guard (e.g., auto-unkey if generating audio for > 2 minutes).
- Duplicate-message suppression window to prevent repeat TX after retries/races.
- Automatic Mandatory ID Cadence (e.g. periodically transmitting "W6RGC/AI" every 10 minutes during active QSOs).

### M2: "Fast-Ack" Mode (Perceived Latency)
- Config flag for two-step transmit:
  1) Immediate tactile acknowledgement the millisecond the squelch drops (e.g. short beep, static tail, or "Copy").
  2) Full answer transmitted 2-3 seconds later.
- Goal: provide immediate user feedback while the STT/LLM pipeline runs in the background.

### M3: Policy module extraction
- Move policy decisions (e.g., `proactive` vs `direct-only`) from `runtime.ts` into `src/policy.ts` to shrink runtime size.
- Keep behavior unchanged.

### M4: Upstream/shareable helpers
- Identify reusable portions of `channel-core.ts`
- upstream to shared OpenClaw utilities where appropriate

## Success Metrics
- Reliability: no restart-loop regressions in soak tests
- Latency: maintain ~2s median PTT-release to response carrier
- Operability: straightforward setup from README on a fresh host
- Safety invariants: PTT always unkeys, restart behavior remains deterministic

## Testing Cadence
After each milestone:
1. Run 3 short on-air tests (single-turn Q/A)
2. Run 1 longer message test (15–30s speech)
3. Confirm logs + no restart warnings
4. Commit and push only after live validation
