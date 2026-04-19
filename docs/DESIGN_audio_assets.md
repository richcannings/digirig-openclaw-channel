# Audio Assets & Acknowledgment Tones Design

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
The `UnifiedTxQueue` manages all outbound transmissions. It supports priority injection for these pre-loaded assets.

### Payload Structure
When a timeout occurs, the system pushes an object to the queue:
```typescript
{
  type: 'pcm_buffer',
  data: AudioCache.get('standby_short'),
  priority: true,        // Jumps to the front of the queue
  preRollMs: 300,        // Standard repeater settling delay
  requireUnkey: true     // Force PTT unkey after playback (don't hold dead air)
}
```

### State Machine Handling
1.  The TX Worker pops the high-priority item.
2.  Asserts PTT (RTS High).
3.  Waits `preRollMs` (300ms).
4.  Writes the raw PCM `Buffer` directly to the ALSA stream.
5.  Waits for the ALSA drain event.
6.  De-asserts PTT (RTS Low).

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

## 7. Future Expansion (Dynamic Assets)
While the initial implementation uses static files, the architecture allows the LLM to dynamically select which pre-loaded asset to play by outputting a specific control tag (e.g., `[PLAY:error]`) in its text stream. The STT-to-Agent middleware can intercept this tag, strip it from the TTS text, and inject the corresponding buffer into the TX queue.