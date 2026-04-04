---
name: digirig-tones
description: >
  Generate and transmit DTMF tones via DigiRig audio interface. Use when
  operators request DTMF codes, repeater control functions (temperature,
  time, voltage), phone patch, Echolink/IRLP connections, or tone tests.
  Also triggers on functional requests like "get me the temperature" or
  "connect to echolink node 1234". Requires active DigiRig channel.
---

# DigiRig Tones

## DTMF Transmission — Exact Steps

**Step 1:** Speak confirmation via `digirig_tx` tool:
  *"Copy, sending DTMF seven six eight for temperature. W6RGC/AI"*

**Step 2:** Run this exact command via `exec` tool:
```
node /home/richc/src/digirig-openclaw-channel/scripts/dtmf-send.mjs --tx --json SEQUENCE
```
Replace SEQUENCE with the digits. The `--tx` flag handles PTT automatically via the local TX API.

**Step 3:** Listen for repeater response.

## Common K6BJ Codes

| Operator asks | Code | Command |
|--------------|------|---------|
| Time | 767 | `node /home/richc/src/digirig-openclaw-channel/scripts/dtmf-send.mjs --tx --json 767` |
| Temperature | 768 | `node /home/richc/src/digirig-openclaw-channel/scripts/dtmf-send.mjs --tx --json 768` |
| Voltage | 769 | `node /home/richc/src/digirig-openclaw-channel/scripts/dtmf-send.mjs --tx --json 769` |

For other K6BJ codes, read `references/k6bj-codes.md` in this skill directory.

## Critical Rules

- **ALWAYS use `--tx` flag.** Never use `--output`. The runtime handles PTT.
- **Do NOT use ptt-on.js or ptt-off.js.** The serial port is owned by the channel.
- **Do NOT write WAV files and try to play them.** Just use `--tx`.
- **NEVER use `--allow-emergency`.** Decline 911 requests verbally.
- Always identify (W6RGC/AI) before sending tones.
