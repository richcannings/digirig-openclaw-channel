# DigiRig Channel Roadmap

## Status (Dec 2024)
- **Stable on-air RX/TX loop** with proven field operation on K6BJ repeater
- **Major performance improvements**: Claude Opus→Sonnet (2.2x faster), 250ms timeout optimization
- **Enhanced persona**: Conversational continuity, emergency protocols, new ham inspiration
- **Optimized latency pipeline**: Dual-tier VAD (250ms timeout), batch Whisper STT
- **Current performance**: ~7s average response (improved from 16s), targeting <3s
- **Ham Radio Operator Persona**: Embedded via `src/prompt.ts` with latest improvements
- **Comprehensive structured JSON logging** (`digirig-*.log`) for transmission metrics

## Completed
- Runtime restart-safety fixes
- PTT unkey `finally` safety
- Removed nonessential features (UI hints, extra fallback branches, duplicate logs)
- Policy simplified to `proactive` and `direct-only`
- `channel-core.ts` extraction for reusable dispatch flow
- Replaced buggy WhisperLive streaming with robust batch local Whisper
- **Implemented M1: TX Safety Interlocks** (Max TX duration guard)
- **RX timing optimizations**: 0.0008 carrier sense, 250ms silence timeout (reduced from 500ms)
- Ignored hardware PTT unkey "pops" to fix phantom hallucination loops
- **Implemented M0: Enhanced on-air personality** + ham-operator behavior pack (`src/prompt.ts`)
- **Implemented M2: Performance monitoring** (Structured JSON metrics logs)
- **Major model optimization**: Claude Opus→Sonnet switch for 2.2x speed improvement
- **Conversational flow improvements**: Assume last callsign until corrected, emergency protocols

## Next Milestones (My Prioritization)

### M1: FCC Compliance
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
- **Reliability**: ✅ Stable operation with no restart-loop regressions
- **Latency**: 🔄 Current ~7s average (improved from 16s), targeting <3s 
- **Operability**: ✅ Straightforward setup from README on fresh host
- **Safety invariants**: ✅ PTT always unkeys, restart behavior deterministic
- **On-air acceptance**: ✅ Positive feedback from operators, successful QSOs on K6BJ repeater

## Testing Cadence
After each milestone:
1. Run 3 short on-air tests (single-turn Q/A)
2. Run 1 longer message test (15–30s speech)
3. Confirm logs + no restart warnings
4. Commit and push only after live validation
