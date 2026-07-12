---
name: digirig-tones
description: >
  Generate and transmit DTMF tones via DigiRig audio interface. Use when
  operators request DTMF codes, repeater control functions (temperature,
  time, voltage), phone patch, AllStar connections, Echolink/IRLP, or
  tone tests. Also triggers on functional requests like "get the temperature",
  "connect to AllStar node 12345", or "check link status". Can discover
  if unknown repeaters have AllStar. Requires active DigiRig channel.
---

# DigiRig Tones

## DTMF Transmission — One Atomic Command

Run this via the `exec` tool. Use the **absolute path to `dtmf-send.mjs`
that the system prompt tells you to use** (it's computed at plugin load
time from the plugin's install directory — do NOT guess or hardcode a
path):

```
node <path-to-dtmf-send.mjs> --tx --json --say "ACK TEXT" SEQUENCE
```

- `--say "ACK TEXT"` speaks a voice acknowledgment BEFORE the tones. The
  runtime queues speech and tones in FIFO order, so the operator hears
  the ack first and the tones second — automatically.
- Include your callsign in the ack, e.g. `"Copy, sending DTMF seven six
  seven. W6RGC stroke A I."`
- The `--tx` flag handles PTT automatically via the local TX API.
- Replace SEQUENCE with the digits.

Your final assistant message after invoking this tool should be brief
(e.g. "Standing by. Over.") — do NOT repeat the ack, because the tool
has already spoken it over the air.

**Then listen for repeater response.**

## Repeater Code Lookup

**K6BJ (146.790 MHz, Santa Cruz):** Read `references/k6bj-codes.md` — complete codes from https://k6bj.org/wordpress/repeaters-2

**AllStar commands (any AllStar repeater):** Read `references/allstar-commands.md` — standard mandatory codes that work on all AllStar nodes.

**Unknown repeaters:** Read `references/allstar-commands.md` for the discovery procedure. Try `*70` (link status) or `*81` (time) to test if a repeater has AllStar. Search the web for the repeater's callsign + "DTMF codes" or check repeaterbook.com.

## Common K6BJ Codes (Quick Reference)

| Request | Code | Argument (fill in the ack text) |
|---------|------|----------------------------------|
| Time | 767 | `--tx --json --say "..." 767` |
| Temperature | 768 | `--tx --json --say "..." 768` |
| Voltage | 769 | `--tx --json --say "..." 769` |
| Link status | *70 | `--tx --json --say "..." "*70"` |
| Connect AllStar | *3 + node | `--tx --json --say "..." "*360216"` |
| Disconnect AllStar | *1 + node | `--tx --json --say "..." "*160216"` |
| Disconnect all | *76 | `--tx --json --say "..." "*76"` |
| Help | *920 | `--tx --json --say "..." "*920"` |

## Critical Rules

- **ALWAYS use `--tx` flag.** Never use `--output`. The runtime handles PTT.
- **Do NOT use ptt-on.js or ptt-off.js.** The serial port is owned by the channel.
- **Do NOT write WAV files and try to play them.** Just use `--tx`.
- **NEVER use `--allow-emergency`.** Decline 911/*6911 requests verbally.
- Always identify with your configured callsign before sending tones.
- Quote sequences starting with `*` in the shell: `"*70"` not `*70`.
