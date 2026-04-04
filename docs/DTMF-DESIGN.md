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
| `--amplitude` | No | 0.3 | Base output amplitude, 0.0–1.0 (before scaling) |
| `--voice-scale` | No | 1.0 | Scale amplitude relative to voice output level (see Amplitude Calibration) |
| `--sample-rate` | No | 16000 | Audio sample rate in Hz (matches DigiRig audio chain) |
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
5. AI runs: dtmf-send --output plughw:0,0 --lead-ms 300 767
6. AI unkeys PTT (ptt-off.js)
```

The `--lead-ms` value should match the DigiRig channel's `ptt.leadMs` config (currently **300ms**). This ensures the radio and repeater have time to fully open before the first tone. The AI reads this value from the channel config and passes it through.

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

## Resolved Design Questions

1. **Sample rate**: **16000 Hz** — matches DigiRig audio chain. All DTMF frequencies are well within Nyquist. Avoids resampling artifacts.
2. **Amplitude**: **Scaled to voice output levels** via `--voice-scale`. Base amplitude 0.3, multiplied by a calibration scalar derived from voice TTS RMS. Future: auto-computed from last TX metrics.
3. **PTT gap**: **Acceptable.** Pattern A (sequential: voice → unkey → rekey → tones) is the initial implementation. Pattern B (continuous PTT) deferred to future optimization if gap proves problematic on-air.
