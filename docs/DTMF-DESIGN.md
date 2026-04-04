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
# Basic: send 767 to default audio device
dtmf-send --output plughw:0,0 767

# Custom timing
dtmf-send --output plughw:0,0 --tone-ms 250 --spacing-ms 250 767

# Louder output (0.0–1.0)
dtmf-send --output plughw:0,0 --amplitude 0.5 767

# Phone patch number
dtmf-send --output plughw:0,0 8315551234

# All valid digits
dtmf-send --output plughw:0,0 "123*#ABCD"

# Sample rate override (default: 48000)
dtmf-send --output plughw:0,0 --sample-rate 16000 767

# Dry run — write to WAV file instead of playing
dtmf-send --output plughw:0,0 --dry-run --wav-out /tmp/dtmf-767.wav 767
```

## On-Air Sequence

The AI handles DTMF requests in a two-step sequence. PTT management is external to the CLI — the AI (or a wrapper script) keys PTT, speaks the callsign via TTS, then runs the CLI tool while PTT is still keyed.

```
Operator: "Overlord, send DTMF 767"

Step 1 — Voice ID (existing TTS pipeline, PTT keyed):
  AI speaks: "Copy, transmitting DTMF seven six seven. W6RGC/AI"

Step 2 — DTMF tones (CLI tool, PTT still keyed):
  AI runs: dtmf-send --output plughw:0,0 --tone-ms 250 --spacing-ms 250 767

Step 3 — PTT unkeys after CLI exits
```

**Important:** The CLI does NOT manage PTT. It only generates audio. PTT keying/unkeying is handled by the calling code (the DigiRig channel runtime or a wrapper script).

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
| `--amplitude` | No | 0.3 | Output amplitude, 0.0–1.0 |
| `--sample-rate` | No | 48000 | Audio sample rate in Hz |
| `--dry-run` | No | false | Don't play audio, just validate and report |
| `--wav-out` | No | — | Write generated audio to WAV file |
| `--verbose` | No | false | Print timing and frequency details |

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
  Tone 7: 852Hz + 1209Hz, 250ms
  Spacing: 250ms
  Tone 6: 770Hz + 1477Hz, 250ms
  Spacing: 250ms
  Tone 7: 852Hz + 1209Hz, 250ms
Output: plughw:0,0 @ 48000Hz 16-bit mono
Total duration: 1250ms
DTMF 767 sent (3 tones, 1250ms total)
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
  sample = amplitude * (sin(2π * freq_row * t) + sin(2π * freq_col * t)) / 2
  output int16 = round(sample * 32767)
```

### Playback

Pipe raw PCM to `aplay`:
```bash
<generated PCM> | aplay -D plughw:0,0 -f S16_LE -r 48000 -c 1 -t raw
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
  or tone tests. Requires active DigiRig PTT session. Currently supports
  DTMF; Morse code planned.
---
```

The skill body would contain:
- How to sequence voice ID + DTMF (PTT management)
- CLI usage examples
- Reference to K6BJ codes when on that repeater
- Verification procedures

### Integration with DigiRig Channel

The AI calls the CLI from within the existing `speak()` pipeline or as a follow-up command. Two integration patterns:

**Pattern A — Sequential (recommended):**
```
1. AI generates voice text: "Copy, transmitting DTMF 767. W6RGC/AI"
2. speak() handles voice TTS + PTT as normal
3. After speak() completes and PTT unkeys...
4. AI keys PTT manually (ptt-on.js)
5. AI runs: dtmf-send --output plughw:0,0 767
6. AI unkeys PTT (ptt-off.js)
```

**Pattern B — Combined (future optimization):**
A wrapper script or runtime enhancement that keeps PTT keyed across both voice and DTMF, eliminating the gap. This is a future improvement once the basic flow is proven.

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

## Open Questions

1. **Default sample rate**: 48000Hz (CD quality, good for tone precision) vs 16000Hz (matches DigiRig STT chain). Leaning 48000 for tone accuracy since DTMF decoders are frequency-sensitive.
2. **Amplitude calibration**: Should we auto-detect voice output levels and match? Or is a fixed 0.3 amplitude sufficient?
3. **PTT gap**: Pattern A has a brief PTT gap between voice and tones. Acceptable? Or do we need Pattern B from the start?
