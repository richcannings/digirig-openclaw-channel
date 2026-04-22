# DigiRig Development Roadmap
*Updated: April 12, 2026 — 18:15 PM PDT*

## ✅ Completed (April 12, 2026)

- [x] **Pipeline Threading (P1-2)** — Replaced monolithic loop with 4 asynchronous queue workers (`src/pipeline/queue.ts`).
- [x] **Async Audio Ack** — Automatic CW "AI" tone plays before tool execution via Agent Loop middleware.
- [x] **Faster Model for Radio Sessions (P1-1)** — Switched from Opus to Gemini 3.1 Pro Preview for speed.
- [x] **STT Callsign Fuzzy Matching (P1-2)** — Implemented via Levenshtein matching against SCCARC roster.
- [x] **FCC ID Timer (P2-2)** — 10-minute auto-ID interval tracked in `runtime.ts`.
- [x] **preRollMs Default (P2-4)** — Increased to 600ms in `defaults.ts`.
- [x] **DTMF Tones** — Standalone CLI `dtmf-send.mjs` + TX API on port 18089. Verified on K6BJ.
- [x] **Anti-Doubling** — Triple carrier-sense check with retry and backoff + Courtesy Delay (2000ms).
- [x] **PTT Lead Time** — 150ms → 300ms. Prevents clipped first syllables.
- [x] **FCC Compliance** — Part 97 awareness in prompt. Lighthearted, positive response if asked.
- [x] **APRS Skill** — Read/send messages + locate stations via findu.com.
- [x] **K6BJ Codes** — Complete from k6bj.org. AllStar/Echolink/phone patch.
- [x] **AllStar Discovery** — Standard commands to detect AllStar on unknown repeaters.
- [x] **Emergency Safety Gate** — Blocks 911 sequences by default.
- [x] **maxSilenceMs Default** — 500ms → 250ms.
- [x] **SCCARC Roster** — 141 members saved for callsign fuzzy matching.
- [x] **Tactical Callsign Reset** — Open for future operator assignment.

---

## 🔥 Priority 1 — Near Term

### P1-1: DTMF Runtime Integration
**Impact:** High — radio session struggles to call `exec` → `dtmf-send --tx`  
**Options:** A) First-class tool, B) Auto-detect from response, C) Rely strictly on the `digirig-tones` skill
**Status:** Skill path chosen and enforced in `prompt.ts`. Monitoring reliability.

### P1-2: Latency Acknowledgments & Unified TX Queue
**Impact:** High UX improvement  
**Description:** Implement a unified priority TX queue (Voice, DTMF, Pre-recorded WAVs) and a timeout-based acknowledgment system. If the AI needs more than ~2000ms to fetch data or run a tool, it plays a fast "Stand by" tone or voice clip to prevent operators from retrying their transmission. Keeps channel clear by unkeying while thinking.  
**Status:** PRD written (`PRD_latency_ack.md`). Ready to implement.

### P1-3: Configurable Radio LLM & Offline Fallback
**Impact:** High — UX speed and emergency survivability  
**Description:** Add configuration to allow the radio channel to specify a distinct LLM (e.g., Gemini Flash for speed) instead of inheriting the global OpenClaw default. Implement an automatic fallback mechanism so that if the internet connection is lost, the channel automatically fails over to a local Ollama model (e.g., `ollama/llama3`), allowing continuous off-grid operation.  
**Status:** PRD written (`PRD_radio_llm_fallback.md`).

---

## 🟡 Priority 2 — This Sprint

### P2-1: Whisper Hallucination Filter (BUG-8)
Repetition detector + expanded static filter list. Ready to implement.

### P2-2: Energy Log Spam (BUG-13)
Gate frame-level logging behind verbose flag. Ready to implement.

### P2-3: Over-Response Bug (BUG-14)
The system sometimes responds too often and interrupts third-party conversations. We need to improve the conversational continuity logic so it only transmits when directly addressed or contextually required.
**Status:** Documented in AGENT.md. Waiting for logic refinement.

---

## 🔵 Priority 3 — Medium Term Features

### P3-1: CAT Control (ICOM IC-705 & General)
**Impact:** Transformative — full radio control & multi-VFO awareness  
**Description:** Integrating CAT (Computer Aided Transceiver) control. This enables the AI to change frequency, mode (FM/SSB/CW/digital), power, filters, and read radio status — not just voice+PTT.  
**Capabilities unlocked:**
- Change bands/frequencies on command ("go to 7.074 MHz for FT8")
- Switch modes (FM ↔ SSB ↔ CW ↔ digital)
- Read S-meter, SWR, frequency, mode status
- Band scanning and signal hunting
- Automated band/mode switching for multi-mode operation
- QSY (change frequency) during QSO when requested
- **Dual VFO monitoring:** Listen to both APRS/digital and phone/voice frequencies simultaneously, creating a true digital bridge.  
**Integration:** CI-V protocol over serial/USB. Existing Node.js libraries available.  
**Depends on:** Pipeline threading (P1-4) for multi-mode operation  
**Status:** Waiting for hardware hookup

### P3-2: True Digital Bridge via Direwolf (AX.25/APRS)
**Impact:** High — digital packet radio without internet  
**Description:** Integrate with Direwolf software modem to send/receive APRS/Winlink packets directly via RF. The AI will serve as a bridge, allowing other agents/tools to communicate over packet radio while it handles humans via voice.  
**Capabilities:**
- AI sends/receives APRS/Winlink natively without findu.com.
- TX Queue dispatches binary packet payloads to Direwolf.
- Combine with CAT control: "Send APRS message to X" -> AI QSYs to 144.390, sends packet, returns to voice.
**Depends on:** Unified TX Queue (P1-2), CAT control (P3-1) or dedicated second radio.  
**Status:** Design stage.

### P3-3: CW Send and Receive
**Impact:** Medium-high — opens HF CW bands  
**Description:** Two components:
1. **Send:** `morse-send.mjs` CLI tool (same pattern as `dtmf-send.mjs`). Generates audio-frequency CW tones piped through TX API.
2. **Receive:** Integrate with `ggmorse` for CW-to-text decoding. Create a CW RX pipeline parallel to the voice STT pipeline.  
**Use cases:** CW QSOs, contest operation, CW practice/training for hams  
**Depends on:** Pipeline threading (P1-4) for parallel CW + voice, CAT control (P3-1) for mode switching  
**Status:** Design needed. `morse-send` CLI follows established pattern.

### P3-4: SSB Mode Support
**Impact:** High — unlocks HF voice operation  
**Description:** Current RX uses squelch open/close to detect transmission boundaries. SSB (Single Sideband) has no squelch — the receiver is always "open" with background noise. Need a different approach to speech detection.  
**Approach options:**
- Voice Activity Detection (VAD) using WebRTC VAD or Silero VAD model
- Energy-based detection with adaptive noise floor (track rolling average and trigger on significant deviation)
- Hybrid: VAD for detection, energy for confirmation  
**Depends on:** CAT control (P3-1) to know when we're in SSB mode  
**Status:** Research needed

### P3-4: Offline/Local Mode (Project Nomad Philosophy)
**Impact:** High for emergency/field deployments  
**Description:** Building on the Ollama offline fallback (P1-3), run entirely offline with a local knowledge base and local tools. Inspired by Project Nomad (projectnomad.us) which bundles offline Wikipedia, local LLMs (Ollama), offline maps, and education tools.  
**Approach:** May not need to integrate Nomad directly. OpenClaw + local LLM (Ollama/llama.cpp) + Kiwix for offline Wikipedia + offline maps could achieve the same thing.  
**Components:**
- Local LLM backend (Ollama with appropriate model)
- Offline knowledge corpus (Kiwix ZIM files: Wikipedia, medical, survival, ham radio references)
- Local STT (already have Whisper running locally)
- Local TTS (already have options)
- No internet dependency for core operation  
**Use cases:** ARES/RACES emergency deployments, field day, remote/off-grid operation, natural disaster communications  
**Status:** Research needed. Evaluate Ollama model quality for radio operations.

---

## 🟣 Priority 4 — Backlog

### P4-1: USB Device Path Stability (BUG-10)
udev rule for `/dev/digirig` symlink.

### P4-2: Audio Level Monitoring (BUG-12)
TX loopback for level verification.

### P4-3: Log Timestamps Local Time (BUG-6)
Local time alongside UTC in logs.

### P4-4: Callsign Pronunciation Dictionary
TTS phonetic overrides for common callsigns.

### P4-5: Automatic QSO Logging
Log every QSO automatically: callsign, time, frequency, mode, signal report, notes. Export to ADIF format for upload to LoTW/eQSL/QRZ. Data already exists in DigiRig logs — needs extraction and formatting.

### P4-6: Band Condition Reporting
Monitor propagation beacons, VOACAP predictions, or solar data (solar flux, K-index, A-index) and report band conditions on request. Useful for HF operations. Could check automatically and announce when conditions change.

### P4-7: Winlink Integration
Send and receive Winlink email over radio using VARA or packet. Useful for emergency communications when internet is down. Pairs well with offline mode (P3-5) and Direwolf (P3-2).

### P4-8: Live Web Dashboard
Turn the log parser (`digirig-tail.cjs`) into a web server that serves a live dashboard showing:
- Real-time transcript (RX/TX with timestamps and callsigns)
- AI thinking/tool usage (what the AI is doing and why)
- Active operators on frequency (callsign roster with last-heard times)
- Signal quality graphs (RMS/peak over time)
- System status (STT latency, LLM dispatch time, PTT state)
- APRS station locations on a map
Allows others to follow along on the internet without a radio. Could be served from OpenClaw's existing web server or a standalone Express app.

### P4-9: Multi-Repeater Profile System
Store per-repeater configs (codes, frequencies, etiquette rules, known operators) and auto-switch when changing repeaters.

### P4-10: QRZ Integration (API Skill)
Look up callsign info via QRZ.com XML API. Requires QRZ XML subscription (paid).  
**Capabilities:** Name, location, grid square, license class, email, QSL info, bio.  
**Use cases:** Personalize greetings ("Good evening Dave in Aptos"), verify callsigns, get grid squares for signal reports, research new stations heard on frequency.  
**Implementation:** OpenClaw skill using `web_fetch` to QRZ XML API. API key stored in skill config.  
**Waiting on:** Rich to get QRZ API account.

### P4-11: Net Control Assistant
Help run nets: check-in tracking, relay management, priority traffic handling, timed announcements.

---

## 🧠 Ideas for Later

- **Multi-Radio Operation** — Multiple radios sharing one AI brain (VHF monitor + HF)
- **Satellite Pass Prediction** — GPredict/n2yo integration for amateur satellites
- **Audio Waterfall / Spectrum Display** — Signal visualization via web UI canvas
- **Training/Elmer Mode** — Practice QSOs, teach procedure, quiz regulations
- **Contest Mode** — Rapid exchanges, serial numbers, dupe checking, rate display

---

## 📋 For Rich — Action Items

**Decisions needed:**
1. ~~SCCARC club roster~~ ✅ Provided and saved
2. ~~Confirm Sonnet for radio~~ ✅ Switched to Gemini 3.1 Pro Preview

3. **DTMF integration preference** — A, B, or C? (P1-3)
4. **IC-705 timeline** — When will CAT control hardware be ready? (P3-1)

**Things to test on-air:**
1. APRS locate/read/send
2. DTMF tones via radio session
3. Anti-doubling under busy conditions
4. FCC compliance response
5. New PTT lead time (300ms) — first syllables clear?

### P4-12: Hard Abort / Barge-in (from BUG-15)
If the AI is transmitting or running a long background task, and the operator keys up to say 'Cancel', the system should immediately abort the current context (hard abort). Low priority for now.

### P4-13: Chunked Audio Streaming for TTS (Plan B)
**Impact:** High UX improvement (zero-latency voice start)  
**Description:** Rewrite the TTS and audio playback pipeline to stream audio chunk-by-chunk rather than waiting for the complete sentence buffer. This will provide the absolute lowest latency from LLM thought to RF transmission.  
**Implementation:** Requires migrating away from spawning `aplay` (to prevent popping/process overhead) towards a native ALSA Node.js binding, and modifying OpenClaw's core TTS API to support chunked streaming. Replaces the block-based buffer queue.  
**Status:** Documented as a future architectural upgrade.
