# Product Requirements Document (PRD): Latency Acknowledgments & Unified TX Queue

**Status: SHIPPED.** Implemented in `src/runtime.ts` (the `tonesTimer` block around
the dispatch call) and `src/pipeline/audio-assets.ts`. Kept here for historical
context and as the spec the implementation was built against.

## 1. Objective
To provide a graceful, natural-sounding user experience over Ham Radio (via DigiRig) when the OpenClaw AI experiences latency due to tool usage or complex generation. By playing short audio acknowledgments ("stand by" tones/voice), the operator knows the system heard them and is processing the request, preventing duplicate transmissions and confusion.

## 2. Core Architecture: Unified TX Queue
To support latency handling and future protocol expansions, the Node.js channel plugin will implement a **Unified Priority TX Queue**.

*   **Queue Items:** The queue will handle Voice TTS buffers, DTMF tone sequences, pre-recorded WAV files (Ack/Error tones), and future data payloads (e.g., Direwolf AX.25 packets).
*   **Priority Injection:** Acknowledgment tones (`ai.wav`, `standby.wav`) can bypass the standard FIFO queue and jump to the absolute front of the line to ensure immediate transmission.
*   **State Machine:** 
    *   If the queue is active (transmitting) and the radio detects incoming RF, the system finishes the current transmission.
    *   It records the incoming audio and queues the *next* LLM processing job behind the new audio payload.

## 3. Acknowledgment Logic (Timeout-Based Detection)
The system will use a **Timeout-Based Detection** combined with a **Time-Based Definition of "Quick"**. 

### Why the Timeout Approach is Optimal:
While intercepting the initial LLM tool-call request is technically the fastest way to *know* a tool is being used, it results in a worse user experience because it would play a "stand by" beep even for micro-tools that execute in 100ms (like reading a cached memory file). 
The timeout-based approach is superior because it guarantees the absolute fastest *voice* response for quick tasks, and only introduces the "Stand by" beep if a true delay is occurring.

*   **The Timer:** The moment the user stops transmitting (COR drops/VAD silence), a timer starts (e.g., `ACK_TIMEOUT_MS = 2000`).
*   **Fast Path:** If the LLM generates a response and the TTS engine pushes audio to the TX Queue *before* the timer expires, the timer is cancelled. Voice is transmitted immediately.
*   **Slow Path:** If the timer hits `2000ms` and the TX Queue is empty, the system injects the `standby_short.wav` to the front of the queue, transmits it, and unkeys. 
*   **Single Ack:** The system plays the acknowledgment tone only once per user interaction.

## 4. RF Etiquette & PTT Rules
*   **Unkey During Thought:** The system will key up, play the acknowledgment WAV, and immediately **unkey**. It will not transmit dead air while thinking. It leaves the channel open.
*   **Standard Pre-roll:** All queue items, including quick acknowledgment beeps, will respect the standard `300ms` Repeater Settling Delay (pre-roll) to ensure the first syllable/tone is not truncated by repeater latency.

## 5. Error Handling
*   If the LLM or tool chain fails entirely (e.g., API timeout, fatal error), the system will not drop silently.
*   It will inject an `error.wav` into the TX queue and then abort the session interaction.

## 6. Audio Assets
The system will support hot-swappable audio assets configured via the channel configuration. Assets should be generated using the persona's designated TTS voice for seamless integration.

*   `ai.wav`: Classic telemetry/Apollo beep (Legacy/Alternative).
*   `standby_short.wav`: Synthetic voice saying "Stand by."
*   `standby_long.wav`: Synthetic voice saying "Stand by. W6RGC stroke AI."
*   `error.wav`: Synthetic voice saying "I'm sorry, I cannot do that Dave. W6RGC stroke AI."

## 7. Configuration Flags
*   `radio.use_tool_ack_tones`: Boolean (default: true)
*   `radio.ack_timeout_ms`: Integer (default: 2000)
*   `radio.audio_paths.standby`: String path to WAV
*   `radio.audio_paths.error`: String path to WAV