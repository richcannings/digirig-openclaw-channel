# Design Document: Streaming Text-to-Speech (TTS) Pipeline

## 1. Objective
Reduce the dispatch latency (time to PTT key-up) in the DigiRig OpenClaw channel by streaming Text-to-Speech (TTS) output. Instead of waiting for the full LLM text generation and subsequent full audio synthesis, the system will process and transmit audio in smaller chunks (e.g., sentences or clauses) as they become available.

## 2. Current vs. Proposed Architecture

### Current Pipeline (Synchronous)
1. STT completes.
2. LLM processes and generates the *entire* text response.
3. Text is sent to the TTS provider.
4. TTS generates the *entire* audio payload.
5. PTT is keyed (with 300ms lead).
6. Audio is played over ALSA.
*Result: PTT key-up is delayed by the sum of total LLM generation time and total TTS synthesis time.*

### Proposed Pipeline (Streaming)
1. STT completes.
2. LLM generates text as a *stream* of tokens.
3. A **Stream Parser** buffers tokens until a logical boundary is reached (e.g., period, comma, question mark, or max character limit).
4. As each chunk is complete, it is asynchronously dispatched to the TTS provider.
5. Upon receiving the *first* audio chunk:
   - Key PTT (300ms lead).
   - Begin playback over ALSA.
6. Subsequent chunks are queued and appended to the playback buffer seamlessly.
7. Unkey PTT after the final chunk finishes playing.
*Result: PTT key-up latency is reduced to the time it takes to generate and synthesize the first sentence/clause.*

## 3. Core Components

### A. Token Chunking Engine
- Listens to the LLM token stream.
- Uses regex or basic punctuation matching (`.`, `,`, `!`, `?`, `\n`) to identify natural pauses.
- Emits text chunks to the TTS queue.

### B. Asynchronous TTS Worker Queue
- Takes text chunks and fetches audio from the TTS provider concurrently.
- Maintains sequence order.

### C. Continuous ALSA Playback Buffer
- Handles playback of sequential audio buffers.
- Requires gapless playback between chunks to sound natural.
- **Risk:** Audio under-run. If the LLM or TTS network calls stall, the playback buffer might empty before the next chunk arrives.
- **Mitigation:** Introduce a slight initial buffer (e.g., wait for 2 chunks before starting if they are very short) or inject a subtle "radio static" or "uh" filler/breathing gap if an under-run occurs, though gapless is the primary goal.

### D. PTT State Manager
- Must transition from a single-shot `play(buffer)` to an `open_stream()` model.
- Key PTT immediately before the first chunk starts.
- Keep PTT keyed as long as the playback buffer is not empty or the LLM stream is still open.
- Unkey only when the LLM stream is closed AND the ALSA buffer is fully drained.

## 4. Implementation Phases

**Phase 1: Token Chunking & Logging**
- Implement the LLM token stream parser.
- Log the chunks and their timing without changing the actual audio playback.

**Phase 2: Gapless Audio Playback POC**
- Create a script to queue multiple pre-generated WAV files and play them gaplessly over ALSA while keeping PTT keyed.

**Phase 3: Integration**
- Connect the live TTS chunk fetching to the continuous playback buffer.
- Tune the chunk size for the optimal balance between latency and audio quality (too short = choppy intonation, too long = high latency).

## 5. Known Challenges
- **Intonation:** TTS models often rely on full sentence context for proper inflection. Chunking at commas might make the voice sound slightly robotic or disjointed.
- **Under-runs:** Network jitter to the TTS API could cause dead air while keyed.
