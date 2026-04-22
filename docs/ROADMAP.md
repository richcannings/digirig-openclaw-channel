# DigiRig Development Roadmap
*Last updated: April 21, 2026*

> The active plan of record for **simplicity / plugin-owned dependencies / latency**
> lives in [claude-redesign.md](./claude-redesign.md). This roadmap tracks features.

## ✅ Completed

- [x] **Pipeline Threading** — Four async workers (RX → STT → agent → TX) via
  `src/pipeline/queue.ts`. See [PIPELINE-THREADING.md](./PIPELINE-THREADING.md).
- [x] **Async Audio Ack / Latency Acknowledgments** — Pre-loaded WAVs injected at
  the front of the TX queue on dispatch timeout or error. See
  [PRD_latency_ack.md](./PRD_latency_ack.md) (shipped in `runtime.ts`).
- [x] **Unified Priority TX Queue** — `text` and `raw` TX jobs flow through one queue
  with `unshift` priority for acks.
- [x] **Per-Channel LLM Override + Offline Fallback** — `channels.digirig.llm.model`
  and `llm.offlineFallbackModel`. See [PRD_radio_llm_fallback.md](./PRD_radio_llm_fallback.md).
- [x] **STT Callsign Fuzzy Matching** — Levenshtein ≤ 2 against SCCARC roster +
  heard callsigns.
- [x] **FCC 10-minute ID Timer** — Polls every 60 s; auto-IDs if no IDs have gone
  out in the last 10 min.
- [x] **DTMF Tones** — Standalone `scripts/dtmf-send.mjs` + `/tx/raw` API on port
  18089. Verified on K6BJ.
- [x] **Anti-Doubling** — Busy-hold wait + courtesy delay + final 50 ms carrier
  check + up to 3 retries with 1200 ms backoff.
- [x] **PTT Lead Time** — Tuned to 300 ms; prevents clipped first syllables.
- [x] **FCC Compliance** — Part 97 awareness in the prompt.
- [x] **APRS Skill** — Read/send messages + locate stations via findu.com.
- [x] **K6BJ / AllStar Codes** — Documented in the DTMF skill.
- [x] **Emergency Safety Gate** — Blocks 911 sequences by default.
- [x] **SCCARC Roster** — 141 members loaded on startup for callsign correction.
- [x] **Sender Tag Extraction** — `[SENDER:CALLSIGN]` parsed out of the LLM
  response, logged as `RX_SENDER`, never spoken on air. Also stripped in the
  `outbound.sendText` path so no metadata leaks over RF.
- [x] **Local TTS (Piper + Kokoro)** — two interchangeable local HTTP daemons
  behind a shared contract; `channels.digirig.localTts.engine` picks which to
  use, `"off"` falls back to cloud TTS. Setup scripts install each as a user
  systemd unit.
- [x] **Configurable persona** — callsign, aliases, name, location, control
  operator, and known-operator quirks all moved from hardcoded strings into
  `channels.digirig.persona.*` config. Prompt templates in `src/prompt/*.ts`
  interpolate these values; generic defaults ship with the plugin.
- [x] **Prompt modularized** — `src/prompt/` split into `persona`,
  `perception`, `contracts`, `protocols`, `safety`, `capabilities`,
  `operators`, `phonetic` files. Each has its own tests.
- [x] **RST-format signal reports** — AI leads replies with an R / S pair
  derived from its own STT intelligibility and a computed S-unit from the
  audio RMS. No T value (voice mode, not CW).
- [x] **`/digirig unkey` safety command** — drops PTT immediately, aborts the
  in-flight TX, drains the TX queue.
- [x] **Stale-socket auto-restart opt-out** — OpenClaw's 30-minute
  `stale-socket` health check was restarting the channel every 35 minutes on a
  quiet repeater. Channel now sets `skipStaleSocketHealthCheck: true`.
- [x] **Log viewer auto-rotate** — `scripts/digirig-tail.cjs` shows 30 lines of
  history on startup and auto-switches to the new log file at midnight rollover.

---

## 🔥 Priority 1 — Near term

### P1-1: Plugin-owned STT daemon lifecycle
**Impact:** Setup-and-forget install. New users shouldn't need to hand-roll a user
systemd unit or a Python venv.
**Approach:** Use OpenClaw's `api.registerService({ id, start, stop })` to install
the venv on first boot, supervise the daemon, and restart on crash. Drop the
standalone `setup-stt-daemon.sh`.
**Status:** Plan written in [claude-redesign.md](./claude-redesign.md) step 1.

### P1-2: Swap STT backend to faster-whisper
**Impact:** The biggest raw-latency win available. CUDA + float16 typically 3–10×
faster than the current `openai-whisper`. Self-contained change once P1-1 is in
place.
**Status:** Plan in [claude-redesign.md](./claude-redesign.md) step 2.

### P1-3: Whisper hallucination filter (BUG-8)
**Impact:** Fewer phantom "thanks for watching" transmissions.
**Status:** Basic filter already lives in `normalizeSttText()` (`runtime.ts`).
Expand the static-list + diversity heuristic.

### P1-4: Over-response bug (BUG-14)
The system sometimes responds too often and interrupts third-party conversations.
Tighten the direct-call policy and the "assume last callsign" rule in the prompt.
**Status:** Documented in AGENT.md. Waiting on logic refinement.

---

## 🔵 Priority 2 — Medium term

### P2-1: CAT Control (ICOM IC-705 and general)
**Impact:** Transformative — full radio control, multi-VFO awareness.
**Description:** CI-V over serial/USB. Unlocks frequency changes, mode changes
(FM/SSB/CW/digital), S-meter reads, QSY during QSO, dual-VFO monitoring.
**Depends on:** Hardware hookup.
**Status:** Design stage.

### P2-2: True Digital Bridge via Direwolf (AX.25/APRS)
**Impact:** High — APRS/Winlink without internet.
**Description:** TX queue dispatches binary packet payloads to a local Direwolf
modem. Pairs with CAT control to QSY to 144.390 MHz and back.
**Depends on:** P2-1 (or a dedicated second radio).
**Status:** Design stage.

### P2-3: CW Send and Receive
1. **Send:** `morse-send.mjs` CLI (same shape as `dtmf-send.mjs`).
2. **Receive:** Parallel CW-to-text pipeline via `ggmorse`.
**Depends on:** P2-1 for mode switching.
**Status:** Design needed.

### P2-4: SSB mode support
**Description:** No squelch on SSB; need real VAD (WebRTC VAD or Silero) instead of
energy thresholds.
**Depends on:** P2-1 to know we're in SSB mode.
**Status:** Research needed.

### P2-5: Offline / local-mode
**Description:** Run entirely offline for emergency deployments. Builds on the
existing `llm.offlineFallbackModel` hook; adds local TTS and an offline knowledge
corpus (Kiwix).
**Status:** Research needed.

---

## 🟣 Priority 3 — Backlog

### P3-1: USB Device Path Stability
udev rule for a stable `/dev/digirig` symlink.

### P3-2: Audio Level Monitoring
TX loopback for level verification.

### P3-3: Log Timestamps Local Time
Local time alongside UTC in logs.

### P3-4: Callsign Pronunciation Dictionary
TTS phonetic overrides for common callsigns.

### P3-5: Automatic QSO Logging
Log every QSO to ADIF for LoTW/eQSL/QRZ. Data already exists in the digirig log;
needs extraction and formatting.

### P3-6: Band Condition Reporting
Monitor propagation beacons, VOACAP, solar flux/K-index/A-index; report on request.

### P3-7: Winlink Integration
VARA or packet email over radio. Pairs with P2-5 and P2-2.

### P3-8: Live Web Dashboard
Turn `digirig-tail.cjs` into a web server with live transcript, AI reasoning, signal
graphs, APRS map.

### P3-9: Multi-Repeater Profile System
Per-repeater configs (codes, frequencies, etiquette rules, known operators).

### P3-10: QRZ Integration
Callsign lookup via QRZ XML API (paid subscription).

### P3-11: Net Control Assistant
Check-in tracking, relay management, priority traffic, timed announcements.

### P3-12: Hard Abort / Barge-in
If the AI is transmitting or running a long task and the operator keys up to say
"Cancel," abort the current context. (Partial coverage exists now via the new
`/digirig unkey` command — see below.)

---

## 🧠 Ideas for later

- **Multi-Radio Operation** — multiple radios, one AI brain (VHF monitor + HF).
- **Satellite Pass Prediction** — GPredict / n2yo integration.
- **Audio Waterfall / Spectrum Display** — canvas UI.
- **Training/Elmer Mode** — practice QSOs, procedure teaching, reg quizzes.
- **Contest Mode** — rapid exchanges, serial numbers, dupe checking.

---

## 🚀 Vision: latency & plugin self-sufficiency

These items came out of an April 2026 latency-reduction spike (preserved in the
`gemini-3.1-pro-preview` git stash). They are not shipped, but they define the
direction the architecture is heading. See
[`claude-redesign.md`](./claude-redesign.md) for the ordered plan and
[`DESIGN.md`](./DESIGN.md) for the architecture notes.

### V1: Plugin-owned service lifecycle
The plugin should install, start, supervise, and restart its own daemons via
`api.registerService({ id, start, stop })` and `process-runtime`. No user-owned
systemd; no hand-rolled venv; `/digirig doctor` reads state from the plugin.
**Priority.** This is #1 in the redesign plan — a new user cannot install the
plugin today without separate setup steps.

### V2: faster-whisper backend
Swap `openai-whisper` for `faster-whisper` (CUDA, float16, `beam_size=1`,
in-memory). Same HTTP contract, 3–10× faster. Single-file daemon change once V1
is in place.

### V3: Cloud STT fallback
When the local daemon is unhealthy or the user declined to install it, route STT
through a registered cloud provider (Deepgram / OpenAI — both already exist as
OpenClaw extensions).

### V4: Prompt-level FCC sign-off
Move the "W6RGC stroke AI" trailer into the LLM system prompt (rule 18 from the
stash). Keep a defensive regex post-append as an FCC-window backstop; remove the
timer-driven sign-off variant from the delivery hot path.

### V5: Local TTS as an OpenClaw speech provider (partially done)
Piper and Kokoro HTTP daemons are shipped (see Completed). What remains: wire
them as `api.registerSpeechProvider(...)` plugins so they join OpenClaw's TTS
fallback chain and are available to other channels, not just this one.

### V6: Streaming TTS (deferred)
Chunked per-clause TTS with gapless `aplay`, PTT keyed on the first clause, held
until the playback buffer drains. Biggest theoretical win; biggest correctness
risk (under-runs, PTT state, sign-off ordering). Explicitly deferred in
`claude-redesign.md` in favor of simpler wins first. Full exploratory design
lives in `archive/stale-docs/tts-streaming-design.md`.

---

## 📋 Action items for Rich

**Decisions needed:**
- IC-705 timeline — when will CAT control hardware be ready? (P2-1)

**Things to test on-air after each claude-redesign step:**
1. Plugin-managed STT daemon restart behavior.
2. faster-whisper accuracy vs. `openai-whisper`.
3. Anti-doubling under busy conditions.
4. FCC compliance response.
