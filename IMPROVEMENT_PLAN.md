# DigiRig OpenClaw Channel — Code Review & Improvement Plan

_Updated: 2026-04-02 — Reflecting major performance improvements_

---

## What It Does

**DigiRig OpenClaw Channel** is a plugin that turns an amateur radio transceiver into a voice-controlled AI assistant using a DigiRig Mobile USB audio/PTT interface. An operator keys up, asks a question, and the AI responds over the air with proper ham radio etiquette.

The full pipeline:
1. **RX:** ALSA captures 16kHz PCM audio. A dual-tier VAD separates speech from squelch noise, buffering the full transmission.
2. **STT:** A hot-loaded Whisper HTTP daemon (Python, CUDA) transcribes the recording in ~0.2–0.8s. Falls back to CLI Whisper if the daemon is down.
3. **Dispatch:** The transcription + RF signal metrics (RMS/Peak dBFS) are routed through OpenClaw's agent system with an injected ham radio persona (ITU phonetics, FCC IDs, 50-word limit, prowords).
4. **TX:** TTS audio is synthesized *before* keying PTT to prevent dead air. Serial RTS controls the PTT relay with lead/tail timing. A 120s watchdog prevents stuck-key hardware damage.

Key non-obvious engineering: batch-only STT (no streaming), dual-threshold VAD (energy vs. carrier sense), 1500ms post-TX mute to suppress relay pop echoes, pre-PTT audio synthesis, and phonetic callsign deduplication.

**Current state:** Stable at v0.6.0. **Major performance improvements in December 2024:**
- **Response time:** Reduced from ~16s to ~7s average (2.2x improvement via Claude Opus→Sonnet switch)
- **Timeout optimization:** VAD silence detection reduced from 500ms to 250ms
- **Enhanced persona:** Conversational continuity, emergency protocols, new ham inspiration features
- **Field proven:** Successfully operating on K6BJ repeater with positive operator feedback
- Works on Linux with DigiRig Mobile and various radio interfaces

---

## Prioritized Improvement Plan

### P0 — Legal/Safety (Must-have before wide distribution)

**1. FCC Automatic ID Cadence (ROADMAP M1)**
The FCC requires station identification every 10 minutes during communications and at the end of a contact (97.119). An AI operating autonomously without enforced periodic ID is a Part 97 violation. This is the single highest-priority item before recommending this to any licensed operator.
- Implement a timer that fires during active QSOs, triggering a station ID transmission
- Log ID events in the JSON-L log
- Make the interval configurable (default 10 min)

**2. Configurable TX Power Budget / Duty Cycle Guard**
Many radios have duty-cycle limits (especially HF rigs). The 120s watchdog is a good start but a cumulative duty-cycle tracker would protect hardware and signal good RF citizenship.

---

### P1 — Accessibility (Biggest barrier to wide adoption)

**3. Hardware Abstraction Beyond DigiRig Mobile**
The DigiRig is excellent but many hams use SignaLink USB, Tigertronics, or radio-native USB audio (Icom IC-705, Kenwood TH-D75). Abstracting the audio/PTT interface to support these would dramatically expand the user base. The PTT abstraction layer could support:
- Serial RTS (current — DigiRig, SignaLink)
- VOX mode (no separate PTT control)
- CAT/CI-V PTT (Icom, Yaesu, Kenwood radios directly)
- GPIO PTT (Raspberry Pi deployments)

**4. CPU-Only STT Path (No GPU Required)**
Currently the fast path requires CUDA + an RTX 3060. Most hams run older hardware or Raspberry Pi. Adding a `faster-whisper` CPU-optimized path (using quantized `int8` models) would make the daemon viable on low-power hardware at ~1–2s latency. This removes the largest single barrier to entry.

**5. Guided Setup / Auto-Configuration**
The existing `/digirig setup` and `/digirig doctor` commands are a great foundation but setup still requires ALSA knowledge and systemd familiarity. A first-run wizard that:
- Detects all connected USB audio devices and presents radio-friendly names
- Tests audio levels and advises on adjustment
- Validates Whisper installation and daemon health
- Writes a ready-to-use config

would make this accessible to hams without Linux sysadmin skills.

---

### P2 — On-Air Experience

**6. Fast-Ack Mode (ROADMAP M2)**
The 2–3s silence after PTT release feels unresponsive to operators used to instant radio feedback. An immediate acknowledgement ("Copy, stand by" or a short tone) while the pipeline runs in the background dramatically improves perceived responsiveness. This is especially important for net operations where others are waiting.

**7. Band/Mode Awareness**
Injecting current band (2m, 40m, etc.) and mode (FM, SSB, AM) into the agent context would enable smarter responses — propagation questions, appropriate power limits, band plan reminders, and context-sensitive signal reports. Could be populated from CAT control or manual config.

**8. Proactive Net Check-In Handling**
Many hams use repeaters with regular nets. A mode where the AI monitors for net control calling for check-ins and automatically responds with callsign would be a compelling feature for ARES/RACES operators.

---

### P3 — Integration & Ecosystem

**9. APRS / Winlink Integration**
Extend beyond voice — integrate with `direwolf` (APRS) or `pat` (Winlink) so the AI can relay messages, report position, or respond to APRS queries. This puts the plugin in the digital modes ecosystem, not just voice.

**10. Repeater Directory Integration**
Integrate with RepeaterBook's API so the AI can answer "what repeaters are on this frequency?" or auto-populate context with local repeater information based on configured operating frequency.

**11. Logging Export to ADIF/Cabrillo**
The structured JSON-L logs are excellent but hams use ADIF for logbook software (Log4OM, WSJT-X, etc.) and Cabrillo for contests. An export command (`/digirig export adif`) would connect this to the broader amateur radio software ecosystem.

---

### P4 — Platform & Distribution

**12. macOS Support (CoreAudio + USB Serial)**
Many hams use Macs. The intentional Linux-only stance is reasonable for stability but a macOS audio/serial backend using `sox` or `portaudio` instead of ALSA would expand reach significantly. Could be gated behind a `platform: "macos"` config flag.

**13. Packaged Distribution**
Currently requires cloning the repo and npm install. A Homebrew formula (macOS), `.deb` package (Ubuntu/Raspberry Pi OS), or Docker image with the Whisper daemon pre-configured would lower the installation barrier substantially.

---

### Summary Table

| Priority | Item | Impact | Effort |
|---|---|---|---|
| **P0** | FCC automatic periodic ID | Legal compliance | Low |
| **P0** | Duty cycle guard | Hardware safety | Low |
| **P1** | CAT/VOX PTT abstraction | 10x hardware support | Medium |
| **P1** | CPU-only Whisper path | Remove GPU requirement | Medium |
| **P1** | First-run setup wizard | Accessibility | Medium |
| **P2** | Fast-Ack mode | On-air UX | Low |
| **P2** | Band/mode context injection | Smarter responses | Low |
| **P2** | Net check-in mode | ARES/RACES use case | Medium |
| **P3** | APRS/Winlink integration | Digital modes ecosystem | High |
| **P3** | ADIF/Cabrillo log export | Logbook integration | Low |
| **P4** | macOS backend | Platform reach | High |
| **P4** | Packaged distribution | Installation UX | Medium |

The **P0 items are non-negotiable** before any public distribution — an AI transmitting without enforced station ID is a Part 97 violation and reflects poorly on the amateur radio community. The P1 items (especially CPU-only STT and CAT/VOX PTT) will determine whether this reaches the general ham population or stays a hobbyist tool for Linux/GPU users.
