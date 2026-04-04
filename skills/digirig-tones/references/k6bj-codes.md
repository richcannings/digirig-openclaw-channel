# K6BJ Repeater DTMF Codes

**Repeater:** K6BJ, 146.790 MHz (−), PL 94.8 Hz  
**Location:** Santa Cruz, California  
**IRLP Node:** 3318

## Function Codes

| Code | Function | Description |
|------|----------|-------------|
| 767 | Time | Current time announcement |
| 768 | Temperature | Outside temperature and equipment rack temperature |
| 769 | Voltage | AC power and battery voltage report |
| 729 nnnnn | DTMF test | Repeater reads back your digits (1–16 digits) |
| 28* | Signal replay | Transmit up to 10 seconds of audio for playback |

## Phone Patch

| Code | Function |
|------|----------|
| 831 nnn nnnn | Dial local number (7-digit with area code) |
| 73 | Hang up phone patch (must identify after) |
| ** | Extend patch timeout (resets timer during long calls) |
| 78911 | EMERGENCY — calls 911 Emergency Center ⚠️ |

> **⚠️ 78911 is blocked by the CLI safety gate.** The AI will never transmit this code. Only the human operator can use `--allow-emergency` from the command line.

## IRLP / Echolink

| Code | Function |
|------|----------|
| 33 nnnn | Connect to IRLP node nnnn |
| *nnnnnn | Connect to Echolink node nnnnnn |
| 73 | Disconnect IRLP/Echolink (must identify after) |

## Usage Protocol

1. Listen for at least 30 seconds before using any control codes
2. Identify (W6RGC/AI) before and after using control functions
3. For signal replay (28*): send code, wait for "Ready" prompt, then transmit test audio
4. After phone patch or IRLP/Echolink disconnect (73), you must identify

## Common Operator Requests → Codes

| Operator says | Code | Notes |
|---------------|------|-------|
| "What time is it?" | 767 | |
| "Get the temperature" | 768 | |
| "Check the voltage" / "How's the power?" | 769 | |
| "Test my DTMF" / "Read back my tones" | 729 + digits | |
| "Connect to echolink node 1234" | *1234 | |
| "Connect to IRLP node 5678" | 33 5678 | |
| "Disconnect" / "Drop the link" | 73 | Must ID after |
| "Dial 831-555-1234" | 8315551234 | Phone patch |
| "Hang up" | 73 | Must ID after |
