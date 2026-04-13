# DigiRig Pipeline Threading Architecture

This document describes the event-driven queue architecture designed to solve sequential processing constraints in the `digirig-openclaw-channel`.

## The Core Problem
In the original architecture, `runtime.ts` operates as a single `while(true)` loop: 
**Listen → Transmit → Wait for LLM → Speak → Repeat**.

This creates two major issues:
1. **Deafness during processing:** If an operator speaks while the STT or LLM is processing a previous transmission, the audio is missed because the capture loop is blocked.
2. **Synchronous tool blocking:** If the LLM needs to perform a long-running task (e.g., `web_search`), it cannot easily push a "Standby" message to the radio and keep the channel open. The loop expects a single text output per transaction.

## The Solution: Event-Driven Queue Architecture
We break the monolith into independent workers connected by asynchronous queues. The radio never stops listening, the agent never blocks the radio, and the transmitter only keys up when there's actually audio ready to go.

### 1. Component Breakdown

*   **RX Audio Monitor (Continuous)**
    *   *Job:* Listens to the sound card 100% of the time. 
    *   *Action:* When squelch drops, it saves the WAV file and pushes its path to the `Inbound Audio Queue`. It immediately goes back to listening.
*   **STT Worker Pool**
    *   *Job:* Pulls WAVs from the `Inbound Audio Queue`.
    *   *Action:* Runs Whisper transcription, performs callsign fuzzy matching, and pushes the text to the `Inbound Message Queue`.
*   **Agent Session Controller (The Brain)**
    *   *Job:* Pulls from the `Inbound Message Queue`. 
    *   *Action:* Feeds text to the LLM. If the LLM uses a tool (like Web Search), the Agent Controller handles it asynchronously. If the LLM generates a partial response (e.g., "Stand by..."), it pushes that text immediately to the `Outbound Text Queue` *while* it keeps running the tool in the background. When the tool finishes, it pushes the final answer to the queue.
*   **TTS Router**
    *   *Job:* Pulls from the `Outbound Text Queue`.
    *   *Action:* Converts text to PCM audio (or routes DTMF/CW commands) and pushes to the `Outbound PCM Queue`.
*   **PTT Controller (Half-Duplex Master)**
    *   *Job:* Pulls from the `Outbound PCM Queue`.
    *   *Action:* Manages the physical radio. Applies courtesy delays, checks for channel carrier (anti-doubling), keys the PTT, plays the PCM buffer, and unkeys.

### 2. Example: Asynchronous Task (Dow Futures) & Async Audio Ack
1. Operator asks: *"What are the Dow futures doing?"*
2. **RX** captures audio -> pushes to Queue.
3. **STT** transcribes -> pushes to Queue.
4. **Agent** gets text. Decides it needs to run `web_search`.
5. **Middleware** detects the tool invocation and automatically pushes a special CW audio cue (`~/src/w6rgc-ai/audio/ai.wav`) to the Outbound Queue as an "Async Audio Ack".
6. **PTT Controller** keys up and plays the short CW tone (`.- ..`).
7. *[Radio goes silent, humans can use the repeater while the tool runs in the background]*
8. **Agent** finishes the web search 4 seconds later and pushes the TTS answer: *"Rich, Dow futures are currently up 150 points. W6RGC/AI"* to the Outbound Queue.
9. **PTT Controller** waits for the channel to be clear, keys up, and delivers the final answer.

## Architecture Diagram

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 550" width="100%" height="100%" style="background-color: #1e1e1e; font-family: sans-serif; color: #fff;">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#88ccff" />
    </marker>
    <style>
      .box { fill: #2d2d30; stroke: #555; stroke-width: 2; rx: 8; ry: 8; }
      .queue { fill: #1e1e1e; stroke: #e6a822; stroke-width: 2; stroke-dasharray: 5,5; rx: 4; ry: 4; }
      .text { fill: #ffffff; font-size: 14px; text-anchor: middle; font-weight: bold; }
      .subtext { fill: #aaaaaa; font-size: 12px; text-anchor: middle; }
      .line { stroke: #88ccff; stroke-width: 3; fill: none; marker-end: url(#arrow); }
      .dashed { stroke: #88ccff; stroke-width: 2; fill: none; stroke-dasharray: 4,4; }
      .title { fill: #ffffff; font-size: 20px; font-weight: bold; }
    </style>
  </defs>

  <!-- Title -->
  <text x="30" y="40" class="title">DigiRig Pipeline Threading Architecture</text>
  
  <!-- Hardware Boundaries -->
  <rect x="20" y="80" width="120" height="420" fill="#252526" stroke="#444" stroke-width="2" rx="4" />
  <text x="80" y="105" class="text">HARDWARE</text>
  <text x="80" y="125" class="subtext">(Radio / USB)</text>

  <!-- RX Path -->
  <rect x="180" y="80" width="160" height="70" class="box" />
  <text x="260" y="115" class="text">RX Audio Monitor</text>
  <text x="260" y="135" class="subtext">Continuous Loop</text>
  
  <path d="M 120 115 L 170 115" class="line" />
  <text x="50" y="115" class="text" transform="rotate(-90 50,115)">RF IN</text>

  <!-- Queue 1 -->
  <rect x="380" y="80" width="140" height="70" class="queue" />
  <text x="450" y="115" class="text" fill="#e6a822">Inbound Audio</text>
  <text x="450" y="135" class="subtext">Queue (WAVs)</text>
  <path d="M 340 115 L 370 115" class="line" />

  <!-- STT Worker -->
  <rect x="560" y="80" width="140" height="70" class="box" />
  <text x="630" y="115" class="text">STT Worker</text>
  <text x="630" y="135" class="subtext">Whisper Daemon</text>
  <path d="M 520 115 L 550 115" class="line" />

  <!-- Queue 2 -->
  <rect x="740" y="160" width="140" height="70" class="queue" />
  <text x="810" y="195" class="text" fill="#e6a822">Inbound Text</text>
  <text x="810" y="215" class="subtext">Queue (Strings)</text>
  <path d="M 700 115 C 720 115, 810 115, 810 150" class="line" />

  <!-- LLM / Brain -->
  <rect x="560" y="240" width="320" height="100" class="box" fill="#1e3a5f" stroke="#4a8ce8" />
  <text x="720" y="275" class="text">Agent Session Controller</text>
  <text x="720" y="295" class="subtext">OpenClaw Runtime</text>
  <text x="720" y="320" class="subtext" fill="#88ccff">Handles Async Tool Calls</text>
  <path d="M 810 230 L 810 240" class="line" />

  <!-- Queue 3 -->
  <rect x="380" y="255" width="140" height="70" class="queue" />
  <text x="450" y="290" class="text" fill="#e6a822">Outbound Text</text>
  <text x="450" y="310" class="subtext">Queue (Strings)</text>
  <path d="M 560 290 L 530 290" class="line" />

  <!-- TTS Router -->
  <rect x="180" y="255" width="160" height="70" class="box" />
  <text x="260" y="290" class="text">TTS / Mode Router</text>
  <text x="260" y="310" class="subtext">Text -> Audio</text>
  <path d="M 380 290 L 350 290" class="line" />

  <!-- Queue 4 -->
  <rect x="190" y="380" width="140" height="70" class="queue" />
  <text x="260" y="415" class="text" fill="#e6a822">Outbound PCM</text>
  <text x="260" y="435" class="subtext">Queue (Audio)</text>
  <path d="M 260 325 L 260 370" class="line" />

  <!-- PTT Controller -->
  <rect x="380" y="400" width="160" height="90" class="box" />
  <text x="460" y="430" class="text">PTT Controller</text>
  <text x="460" y="450" class="subtext">Anti-Doubling</text>
  <text x="460" y="470" class="subtext">Courtesy Delays</text>
  <path d="M 330 415 L 370 415" class="line" />

  <!-- TX Path -->
  <path d="M 380 445 L 120 445" class="line" />
  <text x="50" y="445" class="text" transform="rotate(-90 50,445)">RF OUT</text>

  <!-- Lock Path (Half Duplex enforcement) -->
  <path d="M 460 400 L 460 180 L 260 180 L 260 150" class="dashed" />
  <text x="360" y="170" class="subtext" fill="#88ccff">Mutes RX when Transmitting</text>
</svg>
```