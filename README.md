# 📻 DigiRig OpenClaw Channel

### The world's first AI ham radio operator.

An AI that talks on the radio. Not a chatbot reading scripts — a genuine conversational partner that keys up, listens, researches, thinks, and responds like a real operator. It tells jokes with regulars, performs QSOs, sends and receives APRS messages and positions, sends DTMF tones, and pretty much anything a ham radio operator can do in front of a computer.

Built on [OpenClaw](https://github.com/openclaw/openclaw) + [DigiRig Mobile](https://digirig.net/). Currently operating as **W6RGC/AI (Overlord)** on the K6BJ repeater in Santa Cruz, California. 

Try it on your repeater!

---

## What It Can Do

🎙️ **Voice QSOs** — Natural conversations on any voice repeater or simplex frequency. Adapts tone for different operators — professional with newcomers, cheeky with regulars.

📡 **DTMF Control** — Sends repeater control codes on command. "Get me the temperature from K6BJ" → identifies with callsign, sends DTMF 768, reports the result. Knows K6BJ codes, AllStar commands, and can discover codes for unknown repeaters.

🗺️ **APRS** — Reads messages, sends messages, and locates stations via findu.com. "Where is KN6TYR-1?" → "0.4 miles southwest of Santa Cruz, heading north-northeast at 6.9 MPH."

🔍 **Callsign Intelligence** — Fuzzy-matches garbled speech-to-text against a 141-member club roster. When Whisper hears "WB60WP," the AI knows it's WB6DWP (Dave in Aptos).

🛡️ **Safety Built In** — Triple carrier-sense prevents doubling. Emergency 911 codes blocked by default. Security boundaries refuse API key requests with humor. FCC Part 97.1 compliant.

📊 **Structured Logging** — Every transmission logged as JSON with signal strength, STT latency, LLM dispatch time, and AI-identified sender callsigns. Pretty log viewer included.

---

## How It Works

```
Radio → DigiRig USB → Audio Capture → Speech Detection (dual-tier VAD)
  → Callsign Fuzzy Matching (SCCARC roster)
  → Whisper STT (GPU daemon, sub-second)
  → OpenClaw Agent + Claude LLM
  → [SENDER:WB6DWP] extraction for logging
  → Text-to-Speech → Triple Carrier Sense Check
  → PTT Key → 300ms settle → Audio Out → PTT Unkey

DTMF path: dtmf-send CLI → POST localhost:18089/tx/raw → PTT + raw PCM tones
```

The AI doesn't just parrot responses. It maintains conversation context across a session, remembers who it's been talking to, corrects garbled callsigns, and knows when to stay quiet (most of the time).

---

## Quick Start

### Prerequisites
- Linux (tested on Debian/Ubuntu)
- [OpenClaw](https://github.com/openclaw/openclaw) installed
- [DigiRig Mobile](https://digirig.net/) connected to your radio
- An amateur radio license and a callsign

> **Note:** Whisper (speech-to-text) is **not** required before installation. Once OpenClaw is running, your AI assistant can download, install, and configure the Whisper STT server for you — just ask it.

### Install

```bash
cd ~/src
git clone https://github.com/richcannings/digirig-openclaw-channel
cd digirig-openclaw-channel
npm install
openclaw plugins install -l ~/src/digirig-openclaw-channel
```

### Configure

The easiest way: let the plugin auto-detect your hardware:

```bash
/digirig setup    # detects audio devices, PTT serial, prints config commands
/digirig doctor   # verifies everything is working
```

Or configure manually:

```bash
# Audio devices (find yours with: arecord -l && aplay -l)
openclaw config set channels.digirig.audio.inputDevice "plughw:0,0"
openclaw config set channels.digirig.audio.outputDevice "plughw:0,0"

# PTT serial (find yours with: ls /dev/ttyUSB*)
openclaw config set channels.digirig.ptt.device "/dev/ttyUSB0"
openclaw config set channels.digirig.ptt.rts true

# Your callsign
openclaw config set channels.digirig.tx.callsign "YOURCALL/AI"
openclaw config set channels.digirig.tx.policy "proactive"
openclaw config set channels.digirig.tx.aliases "YourName"
```

### Recommended Tuning

```bash
# RX sensitivity
openclaw config set channels.digirig.rx.energyThreshold 0.1
openclaw config set channels.digirig.rx.carrierSenseThreshold 0.0008
openclaw config set channels.digirig.rx.maxSilenceMs 250
openclaw config set channels.digirig.rx.preRollMs 600

# TX timing
openclaw config set channels.digirig.ptt.leadMs 300
```

### Set Up STT (Speech-to-Text)

You have two options:

**Option A: Ask your AI to do it.** Once OpenClaw is running, just say:
> *"Set up Whisper for DigiRig speech-to-text"*

Your AI assistant will download Whisper, install the hot-loaded daemon, and configure everything.

**Option B: Run the script manually:**
```bash
./scripts/setup-stt-daemon.sh
```

The hot-loaded daemon keeps the Whisper model in GPU VRAM for sub-second transcription. Without it, the system falls back to a slower CLI — still works, just adds 2-4 seconds of latency per transmission.

### Go Live

```bash
openclaw gateway restart
```

Key up your radio: *"[YourName], this is [YourCall]. Radio check."*

### Watch the Logs

```bash
node scripts/digirig-tail.cjs
```

---

## Features in Detail

### Voice Operation
- Dual-tier voice activity detection handles squelch tails and noise
- 600ms pre-roll buffer captures the start of fast talkers
- 250ms end-of-speech detection for snappy turn-taking
- TTS speed configurable (default 1.25x for radio pacing)
- Callsign auto-appended to every transmission

### Anti-Doubling
Three checks before every transmission:
1. Wait for 800ms of channel silence
2. Final energy sample right before PTT key
3. Listen during 300ms PTT lead delay — abort if carrier detected

Up to 3 retries with 1200ms backoff. After 60 seconds of busy channel, drops the message instead of transmitting over someone.

### DTMF Tones
Standalone CLI generates pure dual-tone PCM and transmits via local TX API:

```bash
# Send K6BJ temperature code
node scripts/dtmf-send.mjs --tx --json 768

# All options
node scripts/dtmf-send.mjs --help
```

Emergency sequences (911) blocked by default. K6BJ control codes, AllStar commands, and Echolink codes documented in the skill.

### APRS via findu.com
No API key needed:

```bash
# Locate a station
web_fetch http://www.findu.com/cgi-bin/find.cgi?call=KN6TYR-1

# Read messages
web_fetch http://www.findu.com/cgi-bin/msg.cgi?call=KE6AFE-2

# Send a message
web_fetch http://www.findu.com/cgi-bin/sendmsg.cgi?fromcall=W6RGC&tocall=KE6AFE-2&msg=Hello
```

### Callsign Fuzzy Matching
Loads a club roster CSV on startup. When Whisper garbles a callsign, Levenshtein distance matching corrects it:
- `WB60WP` → `WB6DWP` (distance 1)
- `KU6AFE` → `KE6AFE` (distance 1)

Also tracks callsigns identified by the LLM during conversation, building a dynamic roster.

### FCC Compliance
Operates under FCC Part 97 with a licensed control operator. If someone asks about AI on amateur radio, responds with a lighthearted, positive take — we're here to advance the radio art and have fun.

---

## Performance (April 2026)

| Metric | Value |
|--------|-------|
| STT latency | 300-900ms (hot daemon) |
| LLM dispatch | 7-15s (Sonnet) |
| PTT lead time | 300ms |
| End-of-speech | 250ms |
| Callsign roster | 141 entries (SCCARC) |
| Anti-doubling | 3 checks + 3 retries |

---

## Project Structure

```
src/
  runtime.ts          Main loop, TX API, callsign matching
  audio-monitor.ts    RX capture, VAD, carrier sensing
  prompt.ts           15-section ham radio persona
  ptt.ts              Serial PTT control
  tts.ts              TTS synthesis + playback
  config.ts           Configuration schema
  defaults.ts         Default values
  channel-core.ts     OpenClaw integration

scripts/
  dtmf-send.mjs       DTMF tone CLI (zero dependencies)
  digirig-tail.cjs    Pretty log viewer

skills/
  digirig-tones/      DTMF skill + K6BJ/AllStar codes

docs/
  ROADMAP-CURRENT.md  Where this project is going
  DESIGN.md           Architecture deep-dive
  DTMF-DESIGN.md      DTMF CLI design document
  SMOKE_TEST.md       Post-update test checklist
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/digirig tx <message>` | Manual transmit |
| `/digirig doctor` | Diagnostics |
| `/digirig setup` | Auto-detect devices |

---

## Where This Project Is Going

See **[docs/ROADMAP-CURRENT.md](docs/ROADMAP-CURRENT.md)** for the full roadmap. Highlights:

🔜 **Coming Soon:**
- Faster radio model (Sonnet) for sub-10s responses
- FCC 10-minute auto-ID timer
- Improved Whisper hallucination filtering

🔮 **On the Horizon:**
- **CAT Control** — Full ICOM IC-705 integration (change frequency, mode, read S-meter)
- **CW Send/Receive** — Morse code via ggmorse
- **Offline APRS** — Direct RF packets via Direwolf on 144.390
- **SSB Mode** — VAD-based speech detection without squelch
- **Live Web Dashboard** — Real-time transcript, AI reasoning, active operators
- **Offline Mode** — Local LLM + offline knowledge for field/emergency deployments
- **Winlink** — Email over radio for emergency communications
- **QSO Logging** — Automatic ADIF export for LoTW/eQSL

See the [full roadmap](docs/ROADMAP-CURRENT.md) for details, priorities, and architecture notes.

---

## Contributing

This project is in active development. If you're a ham who codes (or a coder who hams), we'd love your help. The best way to get started is to read the roadmap, pick something that interests you, and open a PR.

**Key docs for contributors:**
- [AGENT.md](AGENT.md) — Architecture decisions and gotchas
- [docs/DESIGN.md](docs/DESIGN.md) — How the pipeline works
- [docs/ROADMAP-CURRENT.md](docs/ROADMAP-CURRENT.md) — What needs building

---

## License

MIT

---

*73 de W6RGC/AI — Overlord, Santa Cruz CA*
