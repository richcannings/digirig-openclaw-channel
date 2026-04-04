---
name: digirig-tones
description: >
  Generate and transmit DTMF tones via DigiRig audio interface. Use when
  operators request DTMF codes, repeater control functions (temperature,
  time, voltage), phone patch, Echolink/IRLP connections, or tone tests.
  Also triggers on functional requests like "get me the temperature" or
  "connect to echolink node 1234". Requires active DigiRig channel.
  Currently supports DTMF; Morse code planned.
---

# DigiRig Tones

## When to Use

Activate when an operator on the radio asks for:
- DTMF tones by number ("send DTMF 767")
- Repeater functions by name ("get the temperature", "what time is it")
- Phone patch ("dial 831-555-1234")
- IRLP/Echolink connections ("connect to echolink node 1234")
- Tone tests ("test your DTMF", "send a tone")

## On-Air Procedure

**Always follow this exact sequence:**

1. **Resolve the code** — exact digits from operator, or look up in `references/k6bj-codes.md`
2. **Confirm and identify** — speak via normal TTS (digirig_tx): *"Copy, transmitting DTMF seven six eight for temperature. W6RGC/AI"*
3. **Send tones** — run the CLI with `--tx` flag: `node scripts/dtmf-send.mjs --tx --json 768`
4. **Listen** for repeater response

The `--tx` flag sends the audio through the DigiRig runtime's TX API, which handles PTT keying/unkeying, carrier sensing, and anti-doubling automatically. **Do not use ptt-on.js / ptt-off.js** — the runtime owns the serial port.

## CLI Quick Reference

```bash
# Transmit via DigiRig runtime (recommended — handles PTT automatically):
node scripts/dtmf-send.mjs --tx [--json] <sequence>

# Direct audio output (for testing without PTT):
node scripts/dtmf-send.mjs --output <device> <sequence>
```

Run `node scripts/dtmf-send.mjs --help` for full options.

Use `--json` for machine-parseable output. Use `--tx` for on-air transmission.

## Safety Rules

1. **Always confirm** the sequence with the operator before sending
2. **Always identify** (W6RGC/AI) before transmitting tones
3. **NEVER use `--allow-emergency`** — if an operator requests 911 or emergency codes, decline: *"I cannot transmit emergency codes. If this is a real emergency, please dial 911 directly."*
4. **Listen before sending** — ensure the channel is clear
5. For unknown repeaters, ask the operator for the code or search the web — do not guess

## Repeater Code Lookup

For known repeaters, read the appropriate reference file:
- **K6BJ** (146.790 MHz, Santa Cruz): `references/k6bj-codes.md`

If the operator asks about a repeater not in the references, search the web for its DTMF codes.
