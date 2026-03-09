# DigiRig Channel Roadmap

## Status (now)
- Stable on-air RX/TX loop
- Slimmed plugin surface
- Transcriber abstraction in place
- Practical latency around ~5s with current model + TTS path

## Completed
- Runtime restart-safety fixes
- PTT unkey `finally` safety
- Removed nonessential features (UI hints, extra fallback branches, duplicate logs)
- Policy simplified to `proactive` and `direct-only`
- `channel-core.ts` extraction for reusable dispatch flow
- `Transcriber` interface + WhisperLive adapter
- RX timing micro-optimizations and sane defaults

## Next Milestones

### M0 (Highest Priority): On-air personality + ham-operator behavior pack
- Define and enforce radio persona/voice for on-air interactions.
- Add explicit behavior guidance for:
  - routine QSOs (call, response, brevity, sign-offs)
  - net operations (check-ins, net control interactions, directed traffic)
  - general ham etiquette (ID cadence, clarity, turn-taking, professional tone)
- Encode this in prompt/policy assets and regression-test with simulated transcripts.
- Include examples of good/bad responses for consistent operator-style behavior.

### M1: Policy module extraction
- Move policy decisions from `runtime.ts` into `src/policy.ts`
- Keep behavior unchanged
- Add direct-only/proactive test coverage

### M2: Latency instrumentation cleanup
- Keep concise timing logs in structured logger (not transcript)
- Add one-liner summary per turn: `rxEnd->txStart`, `dispatch`, `tts`

### M3: Optional fast-ack mode
- Config flag for two-step transmit:
  1) short immediate ack
  2) full answer
- Goal: improve perceived responsiveness while preserving full answer quality

### M4: STT backend portability
- Implement second `Transcriber` adapter (non-Whisper path)
- runtime remains unchanged thanks to interface boundary

### M5: Upstream/shareable helpers
- Identify reusable portions of `channel-core.ts`
- upstream to shared OpenClaw utilities where appropriate

## Success Metrics
- Reliability: no restart-loop regressions in soak tests
- Latency: maintain or improve ~5s median PTT-release to response carrier
- Size: continued net reduction in runtime complexity and branching
- Operability: straightforward setup from README on a fresh host
- Safety invariants: PTT always unkeys, restart behavior remains deterministic

## Testing Cadence
After each milestone:
1. Run 3 short on-air tests (single-turn Q/A)
2. Run 1 longer message test (15–30s speech)
3. Confirm logs + no restart warnings
4. Commit and push only after live validation
