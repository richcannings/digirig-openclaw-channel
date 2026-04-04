# DTMF Tone CLI — Design Document

## Overview

A standalone CLI tool for generating and transmitting DTMF (Dual-Tone Multi-Frequency) tones through the DigiRig audio interface. Designed as a pluggable external tool that the AI calls after voice identification, keeping DTMF completely decoupled from the core TTS/TX pipeline.

This is the first in a family of radio signal CLI tools (DTMF, Morse code, etc.) that follow the same pattern: standalone executables the AI invokes via shell, packaged as OpenClaw skills for discoverability and knowledge.

## Why Standalone CLI

The previous DTMF implementation failed because tones were routed through the TTS synthesis pipeline, which filtered/distorted the dual-tone frequencies. A standalone CLI writes raw PCM directly to the audio device — no TTS, no filters, no intermediaries.

**Separation of concerns:**
- Core DigiRig channel handles voice (STT → LLM → TTS → audio)
- CLI tools handle non-voice signals (DTMF, Morse, test tones)
- AI orchestrates the sequence (voice ID → CLI tool → voice confirmation)

## Usage

```bash
# Basic: send 767 to audio device
dtmf-send --output plughw:0,0 767

# Custom timing
dtmf-send --output plughw:0,0 --tone-ms 500 --spacing-ms 500 767

# Scale amplitude to match voice output level
dtmf-send --output plughw:0,0 --voice-scale 1.4 767

# Phone patch number
dtmf-send --output plughw:0,0 8315551234

# All valid digits
dtmf-send --output plughw:0,0 "123*#ABCD"

# Dry run — validate without playing
dtmf-send --output plughw:0,0 --dry-run 767

# Write to WAV file for analysis
dtmf-send --output plughw:0,0 --wav-out /tmp/dtmf-767.wav 767

# Verbose output showing frequencies and timing
dtmf-send --output plughw:0,0 --verbose 767
```

## Primary Use Case

An operator on the air asks the AI to send DTMF tones. The request may come in several forms:

### 1. Exact sequence provided
```
Operator: "Overlord, send DTMF 767"
```
The AI knows the exact digits. Confirm and send.

### 2. Functional request — AI looks up the code
```
Operator: "Overlord, get me the temperature from the K6BJ repeater"
```
The AI knows (from its skill knowledge base / `references/k6bj-codes.md`) that K6BJ's temperature code is `768`. It looks up the code, confirms what it's doing, and sends.

### 3. Unknown code — AI researches
```
Operator: "Overlord, send the autopatch code for the W6QAP repeater"
```
The AI doesn't have W6QAP codes in its knowledge base. It searches the web or asks the operator for the specific code before transmitting.

### AI Decision Flow

```
Operator requests DTMF
    │
    ├─ Exact digits given? → Confirm and send
    │
    ├─ Functional request for known repeater? 
    │   → Look up code in references/k6bj-codes.md (or similar)
    │   → Confirm the code and what it does
    │   → Send
    │
    └─ Unknown repeater or code?
        → Search web / ask operator for the code
        → Confirm before sending
        → Send (or decline if unsure)
```

**The AI always confirms before sending.** Example responses:

- *"Copy, sending DTMF seven six seven for K6BJ time announcement. W6RGC/AI"* → sends tones
- *"Copy, K6BJ temperature is code seven six eight. Transmitting now. W6RGC/AI"* → sends tones
- *"I don't have the codes for that repeater. Do you have the DTMF sequence?"* → waits for operator

## On-Air Sequence

The AI handles DTMF requests in a three-step sequence:

```
Step 1 — Voice confirmation + station ID (existing TTS/PTT pipeline):
  AI speaks: "Copy, transmitting DTMF seven six eight for K6BJ temperature. W6RGC/AI"
  PTT keys → 300ms lead → TTS audio plays → PTT unkeys

Step 2 — DTMF tones (standalone CLI, separate PTT cycle):
  AI keys PTT (ptt-on.js)
  AI runs: dtmf-send --output plughw:0,0 --lead-ms 300 768
  AI unkeys PTT (ptt-off.js)

Step 3 — Listen for result:
  AI monitors for repeater response (e.g., time/temperature announcement)
```

**Important:** The CLI does NOT manage PTT. It only generates audio. PTT keying/unkeying is handled by the calling code (the DigiRig channel runtime or a wrapper script).

**Why voice first:** FCC requires station identification. The AI must identify as W6RGC/AI before transmitting any signal. Speaking the callsign via TTS before the DTMF tones satisfies this requirement and also tells the operator (and anyone listening) what's about to happen.

## CLI Specification

### Name
`dtmf-send`

### Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `SEQUENCE` | Yes | — | DTMF digits to send: `0-9`, `A-D`, `*`, `#` |
| `--output` | Yes | — | ALSA audio device (e.g., `plughw:0,0`) |
| `--tone-ms` | No | 250 | Duration of each tone in milliseconds |
| `--spacing-ms` | No | 250 | Silence between tones in milliseconds |
| `--lead-ms` | No | 0 | Silence before first tone (PTT settling) |
| `--amplitude` | No | 0.3 | Base output amplitude, 0.0–1.0 (before scaling) |
| `--voice-scale` | No | 1.0 | Scale amplitude relative to voice output level (see Amplitude Calibration) |
| `--sample-rate` | No | 16000 | Audio sample rate in Hz (matches DigiRig audio chain) |
| `--dry-run` | No | false | Don't play audio, just validate and report |
| `--wav-out` | No | — | Write generated audio to WAV file |
| `--verbose` | No | false | Print timing and frequency details |

### Help Output

`dtmf-send --help` prints usage information designed to be readable by both humans and AI agents:

```
dtmf-send — Generate and transmit DTMF tones via ALSA audio device.

USAGE:
  dtmf-send --output <device> [options] <sequence>

SEQUENCE:
  One or more DTMF digits: 0-9 A-D * #
  Examples: 767, 8315551234, "123*#A"

OPTIONS:
  --output <device>      ALSA audio device (required). Example: plughw:0,0
  --tone-ms <ms>         Duration of each tone in ms (default: 250)
  --spacing-ms <ms>      Silence between tones in ms (default: 250)
  --lead-ms <ms>         Silence before first tone for PTT settling (default: 0)
  --amplitude <0.0-1.0>  Base output amplitude (default: 0.3)
  --voice-scale <float>  Scale amplitude relative to voice output level (default: 1.0)
  --sample-rate <hz>     Audio sample rate (default: 16000)
  --wav-out <path>       Write audio to WAV file instead of playing
  --dry-run              Validate sequence and show timing without audio output
  --verbose              Print detailed frequency and timing info
  --help                 Show this help message

DTMF FREQUENCY MATRIX:
            1209Hz  1336Hz  1477Hz  1633Hz
  697Hz:     1       2       3       A
  770Hz:     4       5       6       B
  852Hz:     7       8       9       C
  941Hz:     *       0       #       D

EXAMPLES:
  dtmf-send --output plughw:0,0 767
  dtmf-send --output plughw:0,0 --lead-ms 300 --voice-scale 1.4 767
  dtmf-send --output plughw:0,0 --tone-ms 500 --spacing-ms 500 8315551234
  dtmf-send --output plughw:0,0 --wav-out /tmp/test.wav --verbose 767

EXIT CODES:
  0  Success
  1  Invalid arguments or sequence
  2  Audio device error
  3  Playback error
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success — tones played |
| 1 | Invalid arguments or sequence |
| 2 | Audio device error (can't open, busy, etc.) |
| 3 | Playback error |

### Stdout (normal mode)
```
DTMF 767 sent (3 tones, 1250ms total)
```

### Stdout (verbose mode)
```
DTMF sequence: 7 6 7
  Lead silence: 300ms
  Tone 7: 852Hz + 1209Hz, 250ms
  Spacing: 250ms
  Tone 6: 770Hz + 1477Hz, 250ms
  Spacing: 250ms
  Tone 7: 852Hz + 1209Hz, 250ms
Output: plughw:0,0 @ 16000Hz 16-bit mono
Amplitude: 0.3 × 1.0 voice-scale = 0.3
Total duration: 1550ms (300ms lead + 1250ms tones)
DTMF 767 sent (3 tones, 1550ms total)
```

## DTMF Frequency Matrix

Standard ITU-T DTMF dual-tone pairs:

```
           1209 Hz   1336 Hz   1477 Hz   1633 Hz
697 Hz:      1         2         3         A
770 Hz:      4         5         6         B
852 Hz:      7         8         9         C
941 Hz:      *         0         #         D
```

Each DTMF digit is two simultaneous sine waves (one row + one column frequency).

## Audio Generation

### Approach: Direct PCM synthesis

No external libraries. Pure math — generate 16-bit signed PCM samples:

```
For each sample i at sampleRate:
  t = i / sampleRate
  sample = finalAmplitude * (sin(2π * freq_row * t) + sin(2π * freq_col * t)) / 2
  output int16 = round(sample * 32767)
```

### Amplitude Calibration

DTMF tones must match the voice output level so the repeater's DTMF decoder sees consistent amplitude. The CLI supports a `--voice-scale` parameter that scales the base amplitude relative to voice TTS output.

```
finalAmplitude = clamp(baseAmplitude * voiceScale, 0.0, 1.0)
```

**How to determine the right scale value:**

1. Record a voice TTS transmission: `arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -d 5 voice-sample.raw`
2. Measure RMS: `sox -r 16000 -e signed -b 16 -c 1 voice-sample.raw -n stat 2>&1 | grep "RMS amplitude"`
3. Record a DTMF test tone at default amplitude: `dtmf-send --wav-out dtmf-test.wav --output plughw:0,0 5`
4. Measure its RMS and compute the ratio: `voiceScale = voiceRMS / dtmfRMS`
5. Use that value: `dtmf-send --voice-scale 1.4 --output plughw:0,0 767`

The AI can automate this calibration by reading the TTS audio buffer RMS from the last transmission and passing an appropriate `--voice-scale`. The DigiRig channel runtime already computes RMS for inbound audio — extending this to outbound TTS buffers is straightforward.

**Future automation:** The DigiRig runtime could emit a `lastTxRmsDb` metric after each voice transmission. The AI would then compute `voiceScale` automatically:
```
voiceScale = 10^(lastTxRmsDb / 20) / baseAmplitude
```

### Sample Rate

Default: **16000 Hz** — matches the DigiRig audio chain (STT capture, TTS output). Using the same sample rate as voice ensures the audio device doesn't need to resample, and the output path is identical to what works for voice.

Note: 16000 Hz provides adequate Nyquist headroom for all DTMF frequencies (highest column frequency is 1633 Hz, well below the 8000 Hz Nyquist limit).

### Playback

Pipe raw PCM to `aplay`:
```bash
<generated PCM> | aplay -D plughw:0,0 -f S16_LE -r 16000 -c 1 -t raw
```

No temp files. Stream directly to stdout of aplay via stdin.

### Timing Accuracy

Tone and spacing durations are sample-exact:
```
samples_per_tone = floor(sampleRate * toneMs / 1000)
samples_per_gap  = floor(sampleRate * spacingMs / 1000)
```

## Implementation

### Language: Node.js (single file)

Fits the existing DigiRig ecosystem (all TypeScript/Node). No build step needed — runs directly with `node`.

### File: `scripts/dtmf-send.mjs`

Single self-contained ES module. No npm dependencies. Uses only:
- `node:child_process` (spawn aplay)
- `node:process` (args, exit codes)
- `node:fs` (WAV output, if requested)
- Math (sine wave generation)

### Size Target

Under 200 lines. This is a focused tool, not a framework.

## Verification Before On-Air Use

Before transmitting DTMF over the air, verify with:

1. **`--dry-run`**: Validate sequence and timing without audio output
2. **`--wav-out`**: Generate WAV file, inspect in Audacity or with `sox --stat`
3. **Loopback test**: Play to audio device with DigiRig disconnected, record with `arecord`, verify tones with spectrum analysis
4. **Repeater test**: Send `729 nnnnn` (DTMF test code on K6BJ) — repeater reads back your digits

## OpenClaw Skill Design

This tool ships as part of a `digirig-tones` OpenClaw skill:

```
digirig-tones/
├── SKILL.md              # When/how to use tone tools
├── scripts/
│   ├── dtmf-send.mjs     # DTMF tone CLI
│   └── (future: morse-send.mjs, test-tone.mjs)
└── references/
    └── k6bj-codes.md     # K6BJ repeater DTMF control codes
```

### SKILL.md (sketch)

```yaml
---
name: digirig-tones
description: >
  Generate and transmit DTMF tones and other radio signals via DigiRig.
  Use when operators request DTMF codes, repeater control, phone patch,
  or tone tests. Also use when an operator asks for repeater functions
  by name (e.g., "get me the temperature", "what time is it", "connect
  to echolink node"). Requires active DigiRig PTT session. Currently
  supports DTMF; Morse code planned.
---
```

The SKILL.md body would contain:
- **Trigger conditions**: When to activate (operator mentions DTMF, tone, repeater code, temperature, time, autopatch, echolink, IRLP, phone patch)
- **Decision flow**: How to resolve the DTMF sequence (exact digits vs. lookup vs. research)
- **On-air procedure**: Voice ID first, then CLI tool, then listen for result
- **CLI usage**: How to run `dtmf-send` with correct device and timing params
- **Safety rules**: Always confirm before sending, never send emergency codes (78911) without explicit operator instruction, identify before and after

### references/k6bj-codes.md

Repeater-specific DTMF code reference. The AI reads this file when an operator asks for a function on a known repeater. Example content:

```markdown
# K6BJ Repeater DTMF Codes (146.790 MHz, Santa Cruz CA)

## Function Codes
| Code | Function | Description |
|------|----------|-------------|
| 767 | Time | Current time announcement |
| 768 | Temperature | Outside temp and equipment rack temp |
| 769 | Voltage | AC power and battery voltage |
| 729 nnnnn | DTMF test | Repeater reads back your digits (1-16 digits) |
| 28* | Signal replay | Transmit up to 10s of audio for playback |

## Phone Patch
| Code | Function |
|------|----------|
| 831 nnn nnnn | Dial local number |
| 73 | Hang up (must ID after) |
| 78911 | EMERGENCY — calls 911 (use only in genuine emergency) |
| ** | Extend patch timeout |

## IRLP / Echolink
| Code | Function |
|------|----------|
| 33 nnnn | Connect to IRLP node (K6BJ is node 3318) |
| *nnnnnn | Connect to Echolink node |
| 73 | Disconnect (must ID after) |

## Usage Protocol
- Listen 30+ seconds before using any control codes
- Always identify (W6RGC/AI) before and after using control functions
- For signal replay: Send 28*, wait for "Ready" prompt, then transmit
```

Additional repeater code files can be added as the AI operates on other repeaters (e.g., `references/w6qap-codes.md`). The AI can also be asked to research codes for unfamiliar repeaters and save them for future use.

### Integration with DigiRig Channel

The AI calls the CLI as a follow-up after its voice response. Two integration patterns:

**Pattern A — Sequential (current implementation):**
```
1. AI resolves the DTMF sequence (from operator, knowledge base, or web search)
2. AI generates voice text: "Copy, K6BJ temperature is code 768. Transmitting now. W6RGC/AI"
3. speak() handles voice TTS + PTT as normal (keys, speaks, unkeys)
4. AI keys PTT manually:     node ptt-on.js /dev/ttyUSB1
5. AI runs DTMF CLI:         node dtmf-send.mjs --output plughw:0,0 --lead-ms 300 768
6. AI unkeys PTT:            node ptt-off.js /dev/ttyUSB1
7. AI listens for repeater response
```

The `--lead-ms` value should match the DigiRig channel's `ptt.leadMs` config (currently **300ms**). This ensures the radio and repeater have time to fully open before the first tone. The AI reads this value from the channel config and passes it through.

The `--output` device matches the DigiRig channel's `audio.outputDevice` config (currently `plughw:0,0`).

**Pattern B — Combined (future optimization):**
A wrapper script or runtime enhancement that keeps PTT keyed across both voice and DTMF, eliminating the gap between voice ID and tones. This is a future improvement once the basic flow is proven.

## Future: Radio Signal CLI Family

This establishes the pattern for similar tools:

| Tool | Purpose | Status |
|------|---------|--------|
| `dtmf-send` | DTMF tone generation | This design |
| `morse-send` | Morse code generation | Planned |
| `test-tone` | Continuous tone for testing | Planned |
| `cwid` | CW station identification | Planned |

All follow the same pattern:
- Standalone CLI, no dependencies
- Take `--output` device, timing params, and content
- Generate raw PCM, pipe to aplay
- Don't manage PTT
- Packaged as OpenClaw skills

## Resolved Design Questions

1. **Sample rate**: **16000 Hz** — matches DigiRig audio chain. All DTMF frequencies are well within Nyquist. Avoids resampling artifacts.
2. **Amplitude**: **Scaled to voice output levels** via `--voice-scale`. Base amplitude 0.3, multiplied by a calibration scalar derived from voice TTS RMS. Future: auto-computed from last TX metrics.
3. **PTT gap**: **Acceptable.** Pattern A (sequential: voice → unkey → rekey → tones) is the initial implementation. Pattern B (continuous PTT) deferred to future optimization if gap proves problematic on-air.
