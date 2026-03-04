# DigiRig Voice Channel Design (OpenClaw)

**Document name:** DigiRig Voice Channel  
**Version:** 1.1 (post re-review)  
**Status:** Draft - migration planning  
**Owner:** OpenClaw Channels  
**Audience:** OpenClaw plugin developers, system integrators, operations

---

## 1. Objective

Reduce DigiRig code size by converging on proven `voice-call` extension patterns in `~/src/openclaw/extensions/voice-call`, while preserving ham-radio behavior (PTT, callsign/direct-call policy, RF-safe short replies).

Primary success metric: fewer DigiRig-specific code paths with no regression in RX->STT->agent->TX behavior.

---

## 2. Current Snapshot (Re-review)

Current TypeScript footprint (including tests): `1662` LOC.
Largest module is [`src/runtime.ts`](./src/runtime.ts) at `686` LOC.

Current DigiRig responsibility split:
- `index.ts`: plugin registration, `/digirig tx` command, `digirig_tx` tool.
- `src/runtime.ts`: audio orchestration, STT accumulation/finalization, routing, dispatch, transcript logging, TX serialization.
- `src/audio-monitor.ts`: local VAD-like monitor and utterance framing.
- `src/stt-ws.ts`: WhisperLive WebSocket transport.
- `src/ptt.ts`: serial RTS toggling.
- `src/tts.ts`: OpenClaw telephony TTS + `aplay`.

---

## 3. Review Findings (Before Migration)

1. High: PTT can remain keyed if transmit playback throws.  
`withTx()` does not guarantee `setTx(false)` in an error path (`src/ptt.ts` lines 59-70).

2. High: runtime lifecycle is not restart-safe after stop.  
`stopped` is latched true and never reset (`src/runtime.ts` lines 108, 210-213, 605-623), while plugin caches the runtime singleton (`index.ts` lines 103-115).

3. Medium: inconsistent shutdown path.  
`start()` returned stop callback does not close websocket/PTT (`src/runtime.ts` lines 605-615), but `runtime.stop()` does (`src/runtime.ts` lines 618-623).

4. Medium: config/schema drift.  
`rx.startCooldownMs` exists in zod config (`src/config.ts` line 55) but is missing in `openclaw.plugin.json` schema (`openclaw.plugin.json` RX properties).

5. Medium: `tx.allowToolTx` is enforced by tool code (`index.ts` line 181) but absent from DigiRig config schema and plugin JSON schema.

These defects should be fixed as part of Phase 0 so migration does not build on unstable behavior.

---

## 4. Convergence Strategy with `voice-call`

DigiRig should keep hardware-specific code and remove channel/agent orchestration duplication.

### 4.1 Keep (DigiRig-specific)
- `src/audio-monitor.ts` (local ALSA RX and speech windowing).
- `src/stt-ws.ts` (WhisperLive protocol adapter, unless core later standardizes this).
- `src/ptt.ts` (serial RTS hardware control).
- ALSA playback glue (`aplay`/`amixer`) from `src/tts.ts` and `src/runtime.ts`.

### 4.2 Reuse/Adopt from `voice-call`
- Telephony TTS config merge pattern from `voice-call/src/telephony-tts.ts` (`applyTtsOverride` + safe deep merge) to remove DigiRig-local TTS shaping drift.
- Runtime modularization pattern from `voice-call/src/manager/*` to split `src/runtime.ts` into focused units (events, outbound, state, timers, persistence).
- Response generation contract style from `voice-call/src/response-generator.ts` so DigiRig reply shaping is a thin policy wrapper, not a custom dispatch pipeline.
- Config normalization discipline from `voice-call/src/config.ts` (strict, explicit defaults, no hidden settings).

### 4.3 Delete/Collapse in DigiRig
- Large inline `finalizeRx` and dispatch block in `src/runtime.ts` by extracting reusable reply+delivery handler(s).
- Duplicate config/transformation logic that can be delegated to shared helper(s).
- Redundant route/session assembly code where OpenClaw channel APIs already provide helpers.

---

## 5. Migration Plan (Delete-First)

## Phase 0 - Stabilize
- Fix PTT error-path unkeying.
- Make runtime fully restart-safe (`stop` releases resources and allows subsequent `start`).
- Unify stop semantics between returned account stop callback and `runtime.stop()`.
- Align config surfaces (`startCooldownMs`, `allowToolTx`) across zod + plugin JSON + docs.

## Phase 1 - Carve `runtime.ts` into modules
- Create `src/runtime/` with:
  - `state.ts` (mutable session/runtime state),
  - `rx.ts` (recording/STT accumulation),
  - `reply.ts` (route/dispatch/format policy),
  - `tx.ts` (queue/PTT/TTS/capture mute),
  - `logging.ts`.
- Keep behavior unchanged; target is structural extraction only.

## Phase 2 - Port `voice-call` patterns
- Introduce a DigiRig reply service shaped like `voice-call` response flow (single entrypoint, deterministic outputs).
- Introduce a shared/safe deep-merge utility for telephony TTS overrides as in `voice-call`.
- Normalize config parse/resolve path to avoid implicit settings.

## Phase 3 - Remove duplicated logic
- Replace ad-hoc inline policy + fallback checks with concise policy module.
- Collapse duplicated transcript/session handling into shared helpers.
- Remove dead paths discovered during extraction.

## Phase 4 - Upstream readiness
- Add regression tests for:
  - direct-only/value-and-wait/proactive behavior,
  - retry/restart lifecycle,
  - PTT always-unkeyed invariant,
  - TX fallback responses.
- Prepare small, reviewable PR sequence aimed at OpenClaw mainline.

---

## 6. Acceptance Criteria

- DigiRig total LOC reduced materially (target: 25-40% reduction from current `1662` LOC, excluding tests generated by added coverage).
- `src/runtime.ts` no longer monolithic (target: <=250 LOC top-level orchestrator).
- No behavior regressions in RX/TX policy semantics.
- Runtime can stop/start repeatedly without process restart.
- PTT is always released on success and failure paths.
- Config settings exposed consistently across schema/UI/runtime.

---

## 7. Risks and Mitigations

- Risk: migration changes timing behavior on-air.  
Mitigation: preserve existing frame/silence thresholds and compare latency metrics before/after.

- Risk: over-generalizing for future shared module too early.  
Mitigation: first refactor inside DigiRig, then extract shared code only after parity tests pass.

- Risk: reduced readability during transition.  
Mitigation: phase-by-phase commits with strict no-behavior-change boundaries in Phase 1.

---

## 8. Immediate Next Step

Execute **Phase 0 (stabilize)** first, then begin **Phase 1 runtime extraction**.  
This sequence maximizes safety and ensures the codebase is in a reliable state before deletion-heavy convergence work.
