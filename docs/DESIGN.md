# DigiRig Channel Design

## Goal
A reliable OpenClaw ham-radio channel with low RX→TX latency and room to grow into
multi-mode output (voice, DTMF, CW, packet) behind one unified TX path.

## Principles
- Keep the plugin focused on RF-specific concerns only.
- Reuse OpenClaw routing/session/dispatch primitives rather than reimplementing them.
- Prefer small increments with live on-air validation.
- Ham radio soul first, software engineering second.
- Simplicity over cleverness. Cloud-first; local daemons only where they
  meaningfully reduce latency. See [claude-redesign.md](./claude-redesign.md).

## Architecture

### Pipeline Architecture (Async Queues)
The runtime uses an event-driven async-queue architecture to decouple capture from
processing. See [PIPELINE-THREADING.md](./PIPELINE-THREADING.md) for the full
breakdown and diagram.

```
[RX Audio Worker] → (AudioQueue) → [STT Worker] → (AgentQueue) → [Agent Worker] → (TxQueue) → [TX Worker]
```

1. **RX Worker**: Receives utterances from `AudioMonitor` and forwards them to STT.
2. **STT Worker**: Calls the local Whisper daemon (with CLI fallback), normalizes
   hallucinations, fuzzy-corrects callsigns, and hands clean text to the agent.
3. **Agent Worker**: Dispatches through the OpenClaw agent. Handles the latency
   acknowledgment timer and sender-tag extraction.
4. **TX Worker (Unified Priority Queue)**: Serializes all outbound RF events — voice
   TTS, DTMF tones, latency acks, future data packets. Applies anti-doubling, keys
   PTT, plays PCM, unkeys.

### Latency Acknowledgments (shipped)
If the agent hasn't produced text within `tones.timeoutMs` (default 2000 ms) after
an RX ends, a pre-loaded "Stand by" WAV is `unshift`'d to the front of the TX queue.
On hard dispatch failure, `error.wav` is injected instead. See
[PRD_latency_ack.md](./PRD_latency_ack.md).

### Anti-Doubling
1. **Busy-hold wait** — wait up to 60 s for `AudioMonitor.getBusy()` to clear.
2. **Courtesy delay** — wait `tx.courtesyDelayMs` (default 2000 ms) after the last
   RX end before keying. Re-check carrier after the wait.
3. **Final energy sample** — `isCarrierPresent()` 50 ms before keying PTT.

Up to 3 attempts with 1200 ms backoff. Audio monitor is muted *before* PTT keys to
ignore the hardware electrical pop. Any `setTx(true)` that reaches `config.tx.maxTxMs`
is forcefully aborted.

### Callsign Processing
1. Post-STT: fuzzy-match against the SCCARC roster + heard callsigns (Levenshtein ≤ 2).
2. Post-LLM: extract `[SENDER:CALLSIGN]` tag from the response, log as `RX_SENDER`.
3. Log viewer uses the LLM-identified sender, falling back to regex.

### Per-Channel LLM Override (shipped)
`channels.digirig.llm.model` lets the radio session use a different model than the
global OpenClaw default. `channels.digirig.llm.offlineFallbackModel` is inserted
ahead of the agent's existing fallbacks so the channel keeps working if the primary
cloud provider is unreachable. See [PRD_radio_llm_fallback.md](./PRD_radio_llm_fallback.md).

## Plugin Boundary

### In plugin (RF-specific)
- ALSA capture/playback
- PTT serial control
- Audio energy detection and VAD
- STT transcription via local Whisper daemon (with `whisper` CLI fallback)
- Carrier sensing and anti-doubling
- TX API server (port 18089)
- Callsign fuzzy matching
- Unified Priority TX Queue (voice, DTMF, acks)
- Structured logging

### In OpenClaw core (reused)
- Agent routing and dispatch
- TTS synthesis (cloud path via `runtime.tts.textToSpeechTelephony`; local path
  bypasses this and talks directly to the plugin-managed Piper or Kokoro
  daemon — see TTS section below)
- Session management
- Tool execution (exec, web_fetch, etc.)
- Skill loading

### Text-to-Speech (shipped)
Two backends, selected by `channels.digirig.localTts.engine`:
- **`"piper"`** — local HTTP daemon on `127.0.0.1:18090` running the Piper
  binary + an ONNX voice. ~100 ms synthesis, CPU-only, ~60 MB install.
  Slightly robotic voice.
- **`"kokoro"`** — local HTTP daemon on `127.0.0.1:18091` running Kokoro-82M
  via `kokoro-onnx`. ~200 ms synthesis, CPU (or GPU if available), ~350 MB
  install. Much more natural voice; ~10 English voices selectable via
  `localTts.voice`.
- **`"off"`** (default) — routes through OpenClaw's cloud TTS chain
  (`runtime.tts.textToSpeechTelephony`). Requires a configured speech provider
  under `messages.tts.providers.*`.

Both daemons expose the same HTTP contract (`POST /tts` → raw 16-bit PCM + an
`X-Sample-Rate` header) so swapping engines is a config flag, and adding a new
engine is a new daemon plus a new enum entry. Daemons are installed as
user-owned systemd units by `scripts/setup-{piper,kokoro}-daemon.sh`; the
plugin-managed lifecycle path (no user systemd) remains step 1 in
[claude-redesign.md](./claude-redesign.md).

## Config Schema (DigirigConfig)
- `audio` — input/output device, sample rate
- `ptt` — serial device, RTS, lead/tail timing
- `rx` — energy thresholds, silence/speech timing, carrier sense, pre-roll
- `tx` — callsign, policy, aliases, max TX duration, courtesy delay, allowToolTx
- `stt` — language + CLI-fallback command/model (daemon URL is hard-coded to :18088)
- `llm` — per-channel model override and offline fallback model
- `localTts` — which local TTS engine to use (`off`, `piper`, `kokoro`) and
  optional voice / URL overrides. When `off`, the plugin uses OpenClaw's
  cloud TTS chain instead.
- `tones` — latency ack timeout + WAV asset paths
- `persona` — per-instance identity (name, location, control operator, known
  operators). These are interpolated into the system prompt; the plugin ships
  with generic defaults so it doesn't impersonate a specific station out of
  the box.

## Ports
- **18088** — local Whisper STT daemon (HTTP, plugin → daemon).
- **18089** — TX API (`/tx/status`, `/tx/raw` — used by `dtmf-send.mjs` and future
  out-of-process callers).
- **18090** — local Piper TTS daemon (HTTP, plugin → daemon) when
  `localTts.engine="piper"`.
- **18091** — local Kokoro TTS daemon (HTTP, plugin → daemon) when
  `localTts.engine="kokoro"`.

## Long-term vision (not yet built)

The following directions were explored in an April 2026 latency-reduction spike
(preserved in a git stash and summarized in [claude-redesign.md](./claude-redesign.md)).
They are not shipped — the current code uses cloud TTS, a user-installed Whisper
daemon, and block (non-streaming) synthesis. They are captured here so the
architectural direction is explicit even while we hold simplicity as the higher
value.

### Plugin-owned service lifecycle
Today the Whisper daemon is installed by a shell script and kept alive by the
user's systemd. The plugin should own its dependencies end-to-end:

- Use OpenClaw's `api.registerService({ id, start, stop })` seam.
- Provision the venv and daemon script on first boot under the plugin's state
  directory (no user systemd).
- Supervise the child process with the OpenClaw process supervisor
  (`openclaw/plugin-sdk/process-runtime`) so it restarts on crash and shuts down
  cleanly on plugin reload.
- `/digirig doctor` reads the service status from the plugin, not from the shell.

### faster-whisper STT backend
Swap `openai-whisper` for `faster-whisper` (CUDA, float16, `beam_size=1`,
in-memory `BytesIO`). Typically 3–10× faster on the same model with no change
to the HTTP contract the runtime already talks. This is the single largest raw
latency win available without changing architecture.

### Local TTS as a proper speech provider (partially done)
Piper and Kokoro HTTP daemons are shipped and plugin-callable today (see
**Text-to-Speech** section above). What's still deferred is wiring them as
OpenClaw `SpeechProvider` plugins via `api.registerSpeechProvider(...)`, which
would let them join the standard TTS fallback chain and be used by other
channels too — not just by this plugin's direct HTTP call.

### Streaming TTS (chunked clause synthesis)
The deepest latency win, and the highest complexity. The shape:

1. Tap the LLM token stream; chunk on punctuation (`.,!?\n`).
2. Fire per-clause TTS synthesis concurrently.
3. Keep a single `aplay` stdin open and append PCM as it arrives (gapless).
4. Key PTT as soon as the first clause is synthesized; unkey only when the
   LLM stream is closed AND the playback buffer is drained.

The explicit trade-off is clear in `claude-redesign.md`: this is the big latency
win, and we are deferring it. The full exploratory design is preserved in
`archive/stale-docs/tts-streaming-design.md`.

### Prompt-level FCC sign-off
Delegate the "W6RGC stroke AI" sign-off to the LLM via a prompt rule, and remove
`appendCallsign` from the delivery path. Keep a defensive post-append as a
backstop so a bad LLM response never causes an FCC window violation.

