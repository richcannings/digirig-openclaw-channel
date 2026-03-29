# Reference for AI Agents: DigiRig OpenClaw Channel

This document is a foundational reference for AI agents assisting in this repository. It documents the non-obvious "whack-a-mole" engineering decisions made to bridge imperfect analog radio hardware with digital AI.

## 📻 Core Engineering Principles

### 1. The "Batch over Streaming" Mandate
**CRITICAL:** Do not re-introduce real-time streaming STT (WebSockets). 
- **The Problem:** Half-duplex radios have noisy squelch tails and operators often pause mid-sentence. Streaming models (like WhisperLive) see this as "end of sentence" and then repeat or hallucinate (e.g., "Thanks for watching!").
- **The Solution:** Use **Single-Shot Batch Execution**. Record the entire transmission into a WAV buffer, then transcribe it once the PTT is released.

### 2. Dual-Tier VAD (Voice Activity Detection)
The system distinguishes between **Speech** and **Carrier** using two thresholds:
- **`energyThreshold` (~0.1):** Triggers the *start* of a recording. It ignores static and "kerchunks."
- **`carrierSenseThreshold` (~0.0008):** *Holds* the recording open. As long as the squelch static is above this floor, the user can be dead silent for 30 seconds and the AI will wait for them.
- **`maxSilenceMs` (~500ms):** Because we track the carrier, we can use a very short timeout. When the static drops to zero (PTT release), we process the audio instantly.

### 3. Hardware Interaction Timing
- **Pre-PTT Synthesis:** Always generate the TTS audio buffer **BEFORE** keying the PTT relay. Radio finals are not 100% duty cycle; do not transmit "dead air" while waiting for an API response.
- **Unkey Masking:** When a transmission finishes, the `AudioMonitor` MUST be muted for at least **1500ms**. This hides the loud mechanical "POP" of the PTT relay opening, which otherwise triggers a loop of "You" hallucinations.
- **Max TX Guard:** A hard watchdog timer (default 120s) kills the `aplay` process and unkeys the radio if a transmission exceeds the safety limit, protecting hardware finals.
- **ALSA Overrides:** Always use the `plug` ALSA wrapper (e.g., `plug:"dsnoop:CARD=Device"`) to handle hardware samplerate mismatches.

## 🚀 The STT Pipeline
The plugin uses a hybrid STT approach:
1. **Primary:** HTTP POST to a **Hot-Loaded Python Daemon** (`scripts/stt_daemon.py`) running on port `18088`. This keeps the `medium.en` model hot in GPU VRAM (using CUDA + FP16) for sub-second latency.
2. **Fallback:** If the daemon is down, it spawns a local `whisper` CLI process (cold-start, takes 3-5 seconds).

## 📝 Logging & Observability
We use **Structured JSON-L Logging** in `~/.openclaw/logs/digirig-*.log`.
- Every entry contains a `summary` field for human-readability.
- Every RX entry contains `rmsDb` and `peakDb` metrics.
- The AI is fed these metrics as `[System Data]` so it can give natural signal reports (e.g., "You are loud and clear").

## 🤖 The On-Air Persona
**`src/prompt.ts`** is the master persona. 
- It is injected only for radio-originating messages.
- It forces the AI to use ITU Phonetics ("Whiskey 6"), prowords ("Roger", "Over"), and adhere to FCC ID requirements.
- **Do not move this to a global OpenClaw skill.** It must remain channel-specific to avoid polluting non-radio interfaces.

## 🛠️ Maintenance Commands
- **Restart Gateway:** `openclaw gateway restart`
- **Restart STT Daemon:** `systemctl --user restart whisper-daemon.service`
- **Check Hardware:** `amixer -c Device sget Mic` / `arecord -L`

## ⚠️ Common Pitfalls for Future Agents
1. **Double Identification:** `src/runtime.ts` has a complex `appendCallsign` function. If the AI signs off with phonetics ("Whiskey Six..."), the code must detect it to avoid appending a second "W6RGC/AI" to the end.
2. **Race Conditions:** Utterances terminated by a `tx` event MUST be ignored. The `AudioMonitor` tags these; do not process them or you will create infinite AI-talking-to-itself loops.
3. **OS Portability:** This plugin is intentionally tightly coupled to **Linux ALSA** and **Serial RTS**. Do not attempt to abstract this for Windows/Mac unless explicitly asked; raw hardware control is required for radio stability.
