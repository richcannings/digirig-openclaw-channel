# Claude Redesign: Latency Reduction Plan

**Goal:** Reduce raw latency from operator PTT-release → AI TX key-up, building on the
exploratory work Gemini 3.1-Pro-Preview did since commit `acf23b6`. That work is
preserved in `stash@{0}: gemini-3.1-pro-preview latency reduction attempt
(pre-claude-redesign)` and will be reintroduced one step at a time.

---

## Framing (user priorities)

1. **The plugin must install, start, monitor, and recover its own dependencies.**
   A new user should be able to install this plugin and get working local services
   without hand-rolling systemd units, venvs, or downloads. Hooks off `openclaw`
   lifecycle, not the user's shell.
2. **Simplicity beats latency.** Given a choice between a ~200 ms saving and a
   bespoke module, take the 200 ms loss. Prefer reusing OpenClaw SDK seams over
   rolling our own.
3. **Cloud is the default.** No offline goal. Local daemons exist *only* when they
   meaningfully cut round-trip latency vs. the cloud path.
4. **Out of scope:** swapping the reasoning LLM, perceived-latency tricks
   (ack tones, filler audio — `acf23b6` already covered that).

The previous draft of this plan optimized latency first and layered on a bespoke
streaming pipeline. It has been rewritten to optimize for *simplicity with an honest
latency win*, reusing `~/src/openclaw` (pulled to `714598774f`) where possible.

---

## OpenClaw SDK seams we can reuse

A review of `~/src/openclaw/src/plugin-sdk/` surfaced the following that Gemini's
work reimplemented from scratch:

| Need | OpenClaw seam | Notes |
| --- | --- | --- |
| Long-lived background service owned by the plugin (start/stop with plugin) | `api.registerService({ id, start, stop })` in `plugins/types.ts` | Exactly the "plugin owns its daemons" pattern we want. `ctx` includes `stateDir`, `logger`, `workspaceDir`. |
| Spawn + supervise child processes (restart, kill-tree, timeouts, PTY) | `openclaw/plugin-sdk/process-runtime` (wraps `src/process/exec.ts` + `src/process/supervisor/`) | Replaces Gemini's bare `spawn()` + ad-hoc restart. |
| Find/download binaries, extract archives, locate brew, get the config dir | `openclaw/plugin-sdk/setup-tools` → `detectBinary`, `extractArchive`, `resolveBrewExecutable`, `CONFIG_DIR` | Use for Python venv / Piper binary provisioning. |
| First-run prompts, allowlist wizards, setup adapters | `openclaw/plugin-sdk/setup` and `setup-runtime` | Already rich; we don't reinvent. |
| Cloud TTS (block + telephony) with provider fallback, summarization, directives | `api.runtime.tts.textToSpeech*` (already used by the plugin today) | Keep using. |
| Streaming STT as a first-class provider | `api.registerRealtimeTranscriptionProvider(...)` + `RealtimeTranscriptionSession { connect, sendAudio, onPartial, onTranscript }` in `plugin-sdk/realtime-transcription.ts` | If we ever want *true* streaming STT, this is the contract — not our own HTTP + queue. |
| Register a TTS engine as a speech provider (so it joins the fallback chain) | `api.registerSpeechProvider(...)` with `SpeechProviderPlugin` | Future optional route for local TTS. |
| `doctor` / install-path health check utilities | `openclaw/plugin-sdk/runtime-doctor` | Slot plugin-specific probes into the standard doctor surface. |

The upshot: almost everything Gemini built as a bespoke module has a first-class
OpenClaw equivalent. The remaining question for each step is "is the local speed-up
worth enough to justify any code beyond wiring an existing seam?"

---

## Summary of what Gemini tried (stashed)

1. Local STT — `faster-whisper` (CUDA) via a custom `http.server` daemon on `:18088`.
2. Local TTS — Coqui XTTSv2 **and** Piper, both WebSocket on `:18090`, custom protocol.
3. Streaming TTS pipeline — new `TokenChunker`, `TtsStreamer`, `AlsaStream`, new
   `pcm_stream` TX job kind and `executeStreamTx` in `runtime.ts`,
   `onPartialReply` wired through `dispatchRadioReply`.
4. Acronym phoneticizer — `W6RGC` → `W 6 R G C` in the TTS stream.
5. Prompt-level FCC sign-off — rule 18 in `HAM_RADIO_PROMPT`.
6. Always-ID — `lastIdTxAt = 0`.
7. RX-knob bumps — pre-roll 600→1000 ms, silence 250→500 ms (latency *regression*).
8. TTS resample fix in `playPcm` (force 16 kHz).
9. `index.ts doctor` — probe daemon ports, drop systemd probes.

Known issues in the stash (carried over from prior revision of this doc):

- Port mismatch: `tts-stream.ts` → 18090, config → 18089, doctor → 18089, daemons → 18090.
- `src/config.ts.orig` merge artifact.
- `piper/` (113 MB), `venv/`, `audio/test_*.wav`, `test-alsa-gapless.*`, `test-debug.ts`
  tracked as untracked files. `piper_linux_x86_64.tar.gz` is 0 bytes.
- Empty `src/pipeline/queues.ts`.
- `isSpeakableStreamingReply` unconditionally `true`.
- Pre-buffer 1 clause contradicts design doc's 2.
- Chunker boundary bug when a punctuation chunk exceeds `maxLength`.
- RX-knob bumps directly add ~650 ms latency.
- Acronym phoneticizer's blanket `\b[A-Z0-9]{2,}\b` regex mangles `OK`, `TX`, `LA`.

---

## Ordered implementation plan

Each step is independently mergeable, independently revertable, and stops at a point
where the plugin still works end-to-end. Do one at a time; measure before/after with
a live on-air pass.

### Step 0 — Repo hygiene (prereq, no behavior change) — **partially done**

Done in the April 21 cleanup pass (see commit after this doc):

- [x] Deleted empty stub `src/pipeline/queues.ts`.
- [x] Removed `require("node:fs")` inside an ES module (`runtime.ts`).
- [x] Eliminated `(config.stt as any)` casts by tightening the Zod schema.
- [x] Replaced hardcoded `W6RGC` / phonetic strings in `appendCallsign` with a
      generic NATO-phonetic callsign check that works for any callsign.
- [x] Named magic numbers (`TX_MAX_ATTEMPTS`, `TX_BACKOFF_MS`, `POST_TX_MUTE_MS`,
      `FCC_ID_INTERVAL_MS`, `LOCAL_WHISPER_URL`, …).
- [x] Aligned `openclaw.plugin.json` with the actual Zod config schema (dropped
      stale `wsUrl` / `whisperLiveService`, added `llm`, `tones`, `allowToolTx`).
- [x] Rewrote `/digirig doctor` to probe the real ports (18088 STT, 18089 TX API)
      instead of the WhisperLive systemd unit that isn't how the runtime talks.
- [x] Moved `docs/tts-streaming-design.md` to `archive/stale-docs/`.

Still to do when the stash is revisited:

- Add to `.gitignore`: `piper/`, `venv/`, `*.orig`, `audio/test_*.wav`,
  `test-alsa-gapless.*`, `test-debug.ts`, `unkey_ptt.py`.
- Do **not** restore `src/config.ts.orig`.
- Local binaries/models live under `~/.openclaw/digirig/` (or whatever the plugin
  SDK's `CONFIG_DIR` resolves to), not in the repo — the plugin downloads them at
  setup time.

**Revert:** trivial.

---

### Step 1 — Plugin-owned STT daemon lifecycle (the big structural change)

**Why first:** the user's #1 priority. Everything else rides on the plugin being the
one process that creates, starts, supervises, and tears down local services. Once
this scaffolding is in place, upgrading the daemon implementation in step 2 is a
one-file swap.

**Design:**

- Register a `stt-daemon` service via `api.registerService({ id: "digirig-stt",
  start, stop })`.
- On `start`:
  1. **Ensure** a Python venv under `${CONFIG_DIR}/digirig/venv/stt/`. If missing,
     create with `python3 -m venv`, `pip install faster-whisper`.
     Pin versions in a `requirements.txt` shipped with the plugin.
  2. **Ensure** the daemon script is in place at
     `${CONFIG_DIR}/digirig/scripts/stt_daemon.py` (copy from the plugin's
     packaged assets).
  3. **Start** the daemon via the OpenClaw process supervisor
     (`openclaw/plugin-sdk/process-runtime`) with a scope key so a plugin-wide
     cancel tears it down cleanly. Auto-restart on non-zero exit, with exponential
     backoff capped at 30 s.
  4. Health-probe `POST /healthz` every 5 s; log transitions only.
- On `stop`: cancel the supervisor scope. Supervisor handles kill-tree.
- **`doctor` integration:** the digirig `doctor` command asks the service for its
  status (`running`, `starting`, `crashed`, `healthy`) and surfaces the last N log
  lines. No shelling out to `systemctl` or `ss`.
- **First-run setup:** the plugin's setup wizard uses the existing OpenClaw
  `channel-setup` helpers. A single prompt: "Install local STT for low latency?
  (Y/n)". If the user declines, the plugin falls back to a cloud STT path
  (see step 3) and the service is not registered.
- **Delete** the hand-rolled `scripts/setup-stt-daemon.sh` and the
  `whisper-daemon.service` systemd workflow. Replace any references in
  `docs/TROUBLESHOOTING.md`.

**Measurement:** service reliability — manual kill of the daemon should trigger
automatic restart within 2 s; plugin reload should cleanly stop and restart it.

**Revert:** remove the `registerService` call; the old systemd path is gone, but a
cloud-only path (step 3) still works.

---

### Step 2 — Swap STT implementation to `faster-whisper`

**Why now:** isolated change inside the daemon script. The lifecycle from step 1
already handles the rest.

- Port the packaged `stt_daemon.py` from `openai-whisper` to `faster-whisper` with
  `compute_type="float16"`, `beam_size=1`, `medium.en`.
- Keep the HTTP contract (`POST /transcribe`, WAV body, `{"text":"..."}` response);
  plugin-side code (`transcribeWithLocalWhisper`) is unchanged.
- Use in-memory `BytesIO` — no temp file.
- Add `POST /healthz` for step 1's probe.
- Pin `faster-whisper`, `ctranslate2`, Torch/CUDA wheel versions in
  `requirements.txt`. Document the NVIDIA/cuDNN expectation in `TROUBLESHOOTING.md`.

**Measurement:** log `sttMs` (already logged at `runtime.ts:544`) before vs. after;
expect several-hundred-ms → tens-of-ms on short utterances with GPU.

**Revert:** keep `requirements.txt` pointing at `openai-whisper` and use the prior
daemon script; no plugin-side changes.

---

### Step 3 — Cloud STT fallback path (safety net for step 1)

**Why now:** step 1 introduces "STT is opt-in." If the user declines the install
or the daemon fails to start, the plugin must keep working with cloud STT.

- In `transcribeWithLocalWhisper`: if the local daemon's `/healthz` hasn't been
  healthy in the last N seconds, route the request through a cloud STT provider.
- Cloud path: call a registered realtime-transcription or audio-transcription
  provider via the OpenClaw SDK seams (`realtime-transcription.ts` for streaming,
  or an existing plugin extension — Deepgram already implements
  `transcribeDeepgramAudio` in `extensions/deepgram/audio.ts`).
- **Do not** add a new provider if one already exists; instead, ensure the digirig
  plugin's setup wizard offers to enable e.g. Deepgram or OpenAI Whisper via
  their existing extension setup flow.

**Measurement:** kill the local daemon mid-QSO; the next transmission still
transcribes (via cloud) within a reasonable timeout.

**Revert:** `transcribeWithLocalWhisper` returns the daemon's error like it does
today.

---

### Step 4 — Prompt-level FCC sign-off

**Why now:** smallest change, noticeable simplification. Removes the
`appendCallsign` / `lastIdTxAt` tangle from the delivery path.

- Land the stashed `HAM_RADIO_PROMPT` rule 18 (always end with "W6RGC stroke AI").
- Remove `appendCallsign(...)` from `runtime.ts` delivery. Keep
  `lastIdTxAt`-based timing as a *defensive* post-append only if the final text
  fails a sign-off regex — belt-and-braces for FCC compliance.
- Do **not** set `lastIdTxAt = 0`. The defensive check makes that redundant.

**Measurement:** every AI transmission on air ends with a phonetic callsign sign-off.

**Revert:** one-line prompt change.

---

### Step 5 — TTS resample fix

**Why now:** genuine bug fix from the stash. Independent of everything else.

- Fold the stashed `playPcm` resample-to-16 kHz block into `src/tts.ts`.
- Add a unit test for the `Int16Array` alignment issue called out in
  `docs/TROUBLESHOOTING.md` (the "garbled robot voice" symptom).

**Measurement:** no regression; AI audio remains intelligible across provider
sample rates.

**Revert:** one file.

---

### Step 6 — Local TTS behind the same lifecycle — **SHIPPED**

Landed in late April 2026 out of the planned order. Cloud TTS was blocked by a
provider-resolution bug we never fully diagnosed (the google speech provider's
`isConfigured` returned true in isolation but false in the live gateway), so
local TTS ended up being the faster path to audio on the air, not the
post-step-2 optimization it was originally planned as.

What shipped:
- HTTP-contract daemons for **Piper** (port 18090) and **Kokoro** (port
  18091). Both respond to `POST /tts` with `{text, voice?}` and return raw
  16-bit LE PCM + an `X-Sample-Rate` header.
- `scripts/setup-piper-daemon.sh` / `scripts/setup-kokoro-daemon.sh` install
  binaries, models, and user systemd units. Both daemons can run in parallel;
  a config flag picks which the plugin uses.
- `channels.digirig.localTts.{engine,voice,speed,url}` config block.
  `engine="off"` preserves cloud TTS as the fallback path.
- Plugin-side routing in `src/tts.ts` — `synthesizeLocalTts()` branch that
  talks to whichever daemon the config selects.

What's still **deferred**:
- Registering the daemons as proper `api.registerSpeechProvider(...)` plugins
  so they join OpenClaw's TTS fallback chain and are usable from other
  channels, not just this one (this is V5 in [ROADMAP.md](./ROADMAP.md)).
- Plugin-managed daemon lifecycle (step 1 of this plan) — the setup scripts
  still drop user systemd units.

---

## Shipped outside the original plan

Items that landed while we were working the plan above, not from the Gemini
stash. Each is a permanent part of the current design; see [ROADMAP.md](./ROADMAP.md)
Completed section for the one-line summaries.

- **Configurable persona** — callsign, aliases, name, location, control
  operator, known-operator quirks all moved from hardcoded strings into
  `channels.digirig.persona.*`. Prompt templates interpolate; generic defaults
  ship with the plugin.
- **Prompt modularized** — `src/prompt/` split into concern-specific files
  (`persona`, `perception`, `contracts`, `protocols`, `safety`, `capabilities`,
  `operators`, `phonetic`) with tests.
- **Dynamic script paths** — `src/prompt/capabilities.ts` computes absolute
  paths to `aprs.mjs` / `dtmf-send.mjs` from `import.meta.url` at load time,
  so the prompt names the actual install location instead of a hardcoded
  `/home/<user>/...` that would break for any new clone.
- **`/digirig unkey`** — operator-safety command; drops PTT, aborts in-flight
  TX, drains the TX queue.
- **`[SENDER:...]` leak fix** — both the `deliver` observer and
  `outbound.sendText` paths strip the metadata tag before it can reach TTS.
- **Stale-socket opt-out** — `skipStaleSocketHealthCheck: true` on the channel
  plugin, to stop OpenClaw's 30-minute chat-channel health check from
  restarting the RF channel every 35 min.
- **RST-format signal reports** — `formatSignalReport()` + a perception-prompt
  rule that tells the LLM to lead with R (its own STT intelligibility) and S
  (computed from audio RMS). No T — voice mode, not CW.
- **Log viewer auto-rotate** — `scripts/digirig-tail.cjs` shows recent history
  on startup and switches to the new date file automatically at midnight.
- **Repo hygiene** — `.gitignore` tightened, `LICENSE` added, unused
  dependency removed, `archive/voice-call-refactor-attempt/` deleted.

---

## Explicitly dropped from the stash (do not reintroduce)

- Token chunker (`src/pipeline/chunker.ts`) and streaming-TTS pipeline (`tts-stream.ts`,
  `alsa-stream.ts`, `pcm_stream` TxJob, `executeStreamTx`). Streaming was the big
  complexity bet and the user explicitly chose simplicity over that latency win.
  If the streaming question is ever revisited, the right home is
  `registerRealtimeVoiceProvider` + existing OpenClaw streaming plumbing, not
  custom code inside this plugin.
- `onPartialReply` hook plumbing through `dispatchRadioReply`. Same reason.
- Acronym phoneticizer. Blanket regex mangled short words; Piper/Coqui pronounce
  most callsigns acceptably; the LLM can write phonetically on its own
  (the prompt-rule-18 approach).
- Pre-roll 1000 ms / silence 500 ms bumps. Pure latency regression; no evidence
  they were needed.
- Dual Coqui + Piper daemons. Pick one at a time; step 6 picks Piper.
- `src/config.ts.orig` and `audio/test_*.wav`.
- Custom `AsyncQueue` driving the streaming pipeline (the existing `AsyncQueue` in
  `src/pipeline/queue.ts` for RX/STT/Agent/TX workers stays — that's fine).

---

## Non-goals

- No reasoning-LLM swap.
- No ack-tone / filler-audio work (already covered in `acf23b6`).
- No offline-only mode; cloud remains the default and the fallback.
- No streaming TTS.
- No new bundled dependencies beyond what the registered service installs into
  its own venv / `${CONFIG_DIR}/digirig/`.

---

## Risk register

| Risk | Step | Mitigation |
| --- | --- | --- |
| First-run `pip install` fails (no net, no GPU, no cuDNN) | 1, 2 | Setup wizard clearly says "local STT unavailable — falling back to cloud STT" and does not register the service. |
| User already has a conflicting `whisper-daemon.service` from the old setup | 1 | Setup wizard detects the systemd unit, prompts to disable it, then proceeds. |
| CUDA / cuDNN version drift breaks `faster-whisper` after an OS update | 2 | `doctor` surfaces the daemon's healthz; `TROUBLESHOOTING.md` documents the rebuild-venv path; cloud fallback keeps the plugin working while the user fixes it. |
| LLM forgets to say "W6RGC stroke AI" and we miss the FCC window | 4 | Defensive post-append regex in runtime remains as a backstop. |
| Piper pronounces a callsign incorrectly | 6 | Narrow LLM-prompt substitution (already done elsewhere in the prompt) for known troublesome callsigns only; no blanket regex. |
| Daemon PID leaks on plugin reload | 1 | Always go through the OpenClaw process supervisor's scope cancel, not bare `spawn()`. |
