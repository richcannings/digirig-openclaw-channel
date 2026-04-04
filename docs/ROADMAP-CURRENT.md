# DigiRig Development Roadmap
*Updated: April 4, 2026*

## ✅ Completed (April 4, 2026)

- [x] **DTMF Tones** — Standalone CLI `dtmf-send.mjs` + TX API on port 18089. Verified on K6BJ (triggered temperature announcement). Old TTS-based approach archived.
- [x] **Anti-Doubling** — Triple carrier-sense check (holdoff wait → final energy sample → listen during PTT lead). 3 retries with backoff. Timeout drops message instead of transmitting.
- [x] **PTT Lead Time** — Increased from 150ms → 300ms. Prevents clipped first syllables.
- [x] **DTMF False Claims Removed** — Prompt sections 11/12/14 (old numbering) removed. Replaced with accurate section 13 with working CLI command.
- [x] **FCC Legitimacy Response** — Part 97.1 citations in prompt section 11. Respectful, confident defense when challenged.
- [x] **APRS Skill** — Read/send messages + locate stations via findu.com. No API key needed.
- [x] **K6BJ Codes** — Complete from official k6bj.org website. AllStar/Echolink/phone patch.
- [x] **AllStar Discovery** — Standard commands to detect AllStar on unknown repeaters.
- [x] **Emergency Safety Gate** — `--allow-emergency` blocks 911 sequences by default.
- [x] **maxSilenceMs Default** — Changed from 500ms → 250ms in defaults.ts.
- [x] **BUG-3 Response Verbosity** — Closed. Current response length is appropriate per Rich.
- [x] **Tactical Callsign Reset** — "Bridges" removed. Open for future operator assignment.

## 🔥 Priority 1 — Next Up

### P1-1: Faster Model for Radio Sessions
**Type:** Feature  
**Impact:** High — dispatch times currently 30-60 seconds with Opus  
**Description:** Radio session should use Claude Sonnet (or similar fast model) instead of Opus. Voice radio needs speed over depth. Opus is great for complex webchat tasks but too slow for on-air responsiveness.  
**Fix:** Configure DigiRig radio session to use a faster model. Could be a per-channel model override in OpenClaw config.  
**Status:** Design needed

### P1-2: STT Callsign Fuzzy Matching
**Type:** Bug fix (BUG-4)  
**Impact:** High — callsigns garbled by Whisper cause misattribution  
**Description:** Whisper mangles callsigns: "WB60WP" → WB6DWP, "KU6AFE" → KE6AFE, "W6DVP" → WB6DWP. Need post-STT normalization using a known callsign roster.  
**Fix:**
1. Rich provides SCCARC club roster (common callsigns on K6BJ)
2. Build callsign normalization function in `runtime.ts` that fuzzy-matches STT output against known roster
3. Use Levenshtein distance or phonetic similarity (Soundex/Metaphone) for matching
4. Log corrections for tuning  
**Rich can help:** Provide club roster file (list of callsigns for K6BJ regulars)  
**Status:** Ready to implement once roster is available

### P1-3: DTMF Runtime Integration
**Type:** Feature  
**Impact:** High — radio session doesn't reliably use `exec` for dtmf-send  
**Description:** The radio AI knows about DTMF (prompt section 13) but struggles to actually call `exec` → `dtmf-send --tx` in practice. The skill/prompt instructions aren't enough.  
**Fix Options:**
- A) Register `dtmf-send` as a first-class OpenClaw tool (like `digirig_tx`) so the AI calls it naturally
- B) Add DTMF detection in the channel runtime — if the AI response contains "DTMF 768" or similar, auto-trigger the CLI
- C) Keep current approach but test more with Sonnet (faster model may handle tool-calling better)  
**Status:** Needs design decision

## 🟡 Priority 2 — This Sprint

### P2-1: Whisper Hallucination Filter Improvements (BUG-8)
**Type:** Bug fix  
**Impact:** Medium — false triggers waste processing and occasionally cause inappropriate responses  
**Fix:**
1. Add repetition detector: if >60% of words are identical, discard (catches "Noisy noisy noisy")
2. Add minimum unique word count for short utterances
3. Expand static hallucination list  
**Status:** Ready to implement

### P2-2: FCC ID Timer (BUG-9)
**Type:** Feature — regulatory compliance  
**Impact:** Medium — FCC requires station ID every 10 minutes during operation  
**Fix:** Implement timer that tracks last TX with callsign. If 10 minutes elapse during active operation, append callsign to next TX or send standalone ID.  
**Status:** Ready to implement

### P2-3: Energy Log Spam (BUG-13)
**Type:** Quality of life  
**Impact:** Low-medium — thousands of noisy log lines per minute on busy repeater  
**Description:** Every audio frame above energy 0.0001 logs a line. This drowns out useful RX/TX entries in the log.  
**Fix:** Raise the frame-level log threshold to match `energyThreshold` (0.1) or gate behind a `--verbose-audio` config flag. Only log frames that are meaningful (near speech threshold).  
**Status:** Ready to implement

### P2-4: preRollMs Default (BUG-11)
**Type:** Defaults improvement  
**Impact:** Low — Rich's config already overrides to 600ms  
**Description:** Default pre-roll buffer is 100ms. This clips the first syllable of fast-talking operators. Pre-roll captures audio from *before* speech detection triggers, like a dashcam buffer. 600ms is the right default for repeater work.  
**Fix:** Change `DEFAULT_RX_PRE_ROLL_MS` from 100 → 600 in defaults.ts (one-liner).  
**Status:** Ready to implement

## 🔵 Priority 3 — Backlog

### P3-1: USB Device Path Stability (BUG-10)
Create udev rule for stable `/dev/digirig` symlink. Prevents manual reconfig after USB replug.

### P3-2: Audio Level Monitoring (BUG-12)
TX audio loopback to verify output levels match repeater expectations. Useful for DTMF amplitude calibration.

### P3-3: Log Timestamps Local Time (BUG-6)
Add local time alongside UTC in structured logs for easier correlation with real-world events.

### P3-4: Callsign Pronunciation Dictionary
TTS mispronounces some callsigns. Build a phonetic override dictionary for common calls.

## 📋 For Rich

**Things Rich can provide to unblock work:**
1. **SCCARC club roster** — List of callsigns for K6BJ regulars (for P1-2 fuzzy matching)
2. **Model preference for radio** — Confirm Sonnet is acceptable for radio sessions (for P1-1)
3. **DTMF integration preference** — Option A, B, or C for P1-3

**Things to test on-air:**
1. APRS locate/read/send (skill is ready)
2. DTMF tones via radio session (may need Sonnet for reliable exec calls)
3. Anti-doubling behavior under busy repeater conditions
4. FCC legitimacy response (have someone challenge you)
