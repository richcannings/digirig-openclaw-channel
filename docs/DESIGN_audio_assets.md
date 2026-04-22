# Audio Assets & Acknowledgment Tones Design

**Status: SHIPPED.** Implemented in `src/pipeline/audio-assets.ts` and
`src/runtime.ts`. Kept here as the spec the implementation was built against.

## 1. Overview
This document outlines the technical design for managing, loading, and transmitting pre-recorded audio assets (like `ai.wav`, `standby.wav`, and `error.wav`) over the DigiRig channel. These assets provide immediate, low-latency feedback to human operators without waiting for the LLM or TTS engine.

## 2. Asset Inventory
The channel will support the following standard audio assets, stored in the `audio/` directory:

| Filename | Type | Purpose | Transcription/Content |
| :--- | :--- | :--- | :--- |
| `ai.wav` | Tone | Legacy fast-acknowledgment (Apollo-style telemetry beep). | N/A |
| `standby_short.wav` | TTS Voice | Quick latency acknowledgment. | "Stand by." |
| `standby_long.wav` | TTS Voice | Latency acknowledgment with station ID. | "Stand by. W6RGC stroke AI." |
| `error.wav` | TTS Voice | Fatal error notification / HAL 9000 homage. | "I'm sorry, I cannot do that Dave. W6RGC stroke AI." |

## 3. Technical Specifications
To ensure zero-latency playback and avoid runtime resampling overhead, all audio assets must match the native output format expected by the ALSA playback stream.

*   **Format:** Uncompressed WAV (PCM)
*   **Bit Depth:** 16-bit integer
*   **Channels:** 1 (Mono)
*   **Sample Rate:** Must match the configured `audio.sampleRate` (typically 16000 Hz or 48000 Hz for DigiRig).

*Note: If custom assets are generated via OpenClaw's TTS engine, they should be exported to match these exact specifications using `ffmpeg` before deployment.*

## 4. Memory Management (Eager Loading)
To achieve the lowest possible latency (bypassing disk I/O when a timeout hits), the audio assets will be loaded directly into memory when the channel plugin boots.

1.  **Boot Phase:** The plugin reads `plugin.config.json` to find the configured paths for the audio assets.
2.  **Buffering:** Node.js `fs.readFileSync()` loads the WAV files.
3.  **Header Parsing:** The system strips or parses the WAV header so only the raw PCM data is held in the `Buffer`, ready to be piped directly to the ALSA speaker instance.
4.  **In-Memory Store:** The parsed PCM buffers are stored in a static dictionary (e.g., `AudioCache.get('standby_short')`).

## 5. TX Queue Injection
The TX queue (`src/pipeline/queue.ts`) is a single async FIFO that supports
priority injection via `unshift`. Two `TxJob` kinds flow through it today:

```typescript
type TxJob =
  | { kind: "text"; text: string; hooks?: {...}; done?: {...}; abortSignal?: AbortSignal }
  | { kind: "raw"; pcm: Buffer; sampleRate: number; label?: string;
      done?: {...}; abortSignal?: AbortSignal };
```

When the latency timer (`tones.timeoutMs`, default 2000 ms) fires without a voice
response, the runtime `unshift`s a `raw` job to the front of the queue:

```typescript
txQueue.unshift({
  kind: "raw",
  pcm: AudioAssets.get("standby") || AudioAssets.get("beep"),
  sampleRate: config.audio.sampleRate,
  label: "standby",
});
```

On hard dispatch failure the same shape is used with `AudioAssets.get("error")`.

### TX Worker behavior for raw jobs (`executeRawTx`)
1. Wait for the channel to clear (same anti-doubling as a text TX).
2. Compute `muteMs = leadMs + tailMs + audioMs + 500`, then mute the monitor.
3. `ptt.open()` → `ptt.setTx(true)`.
4. Listen during `leadMs` — abort if carrier is detected mid-lead.
5. Pipe the raw PCM to `aplay -f S16_LE -r <sampleRate> -c 1`.
6. `tailMs` delay → `ptt.setTx(false)`.
7. `muteFor(POST_TX_MUTE_MS)` to avoid hearing our own tail.
8. Log a `TX_RAW` metric (with `label` if present).

## 6. Configuration Schema Updates
The `DigirigConfig` interface will be extended to support customizable audio assets:

```typescript
interface DigirigConfig {
  // ... existing config
  tones: {
    enabled: boolean;          // Master toggle for latency tones
    timeoutMs: number;         // Time before playing standby tone (e.g., 2000)
    assets: {
      standby: string;         // path to standby_short.wav or standby_long.wav
      error: string;           // path to error.wav
      beep: string;            // path to ai.wav
    }
  }
}
```

## 7. Future expansion (dynamic assets)
The architecture leaves room for the LLM to select a pre-loaded asset by emitting
a control tag (e.g. `[PLAY:error]`). Similar to how `[SENDER:…]` is parsed out of
the response today, an asset tag could be intercepted, stripped from the spoken
text, and its buffer `unshift`'d to the TX queue. Not yet implemented.