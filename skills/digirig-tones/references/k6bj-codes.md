# K6BJ Repeater DTMF Codes

**Source:** https://k6bj.org/wordpress/repeaters-2  
**Repeater:** K6BJ VHF, 146.790 MHz (−), PL 94.8 Hz  
**Location:** City of Santa Cruz, 330' AMSL, Grid CM96ax  
**Linked to:** K6RMW/W 147.945− PL 94.8 (Watsonville, full-time link)  
**AllStar Node:** 60216  
**Echolink:** K6BJ-R #354814

## Before Using Any Codes
1. Listen at least 30 seconds to ensure repeater is not in use
2. Identify (W6RGC/AI)

## Function Codes

| Code | Function | Description |
|------|----------|-------------|
| 767 | Time | Repeater announces current time |
| 768 | Temperature | Outside temp and equipment rack temp |
| 769 | Voltage | AC power and battery voltage |
| 729 nnnnn | DTMF test | Repeater reads back your digits (1–16 digits, letter D cannot be read back) |
| 28* | Signal replay | Send code, wait for "Ready", transmit up to 10s of audio for playback |
| *920 | Help | Interactive help on repeater functionality |

## Phone Patch

| Code | Function |
|------|----------|
| *6 nnn nnn nnnn | Dial 10-digit phone number with area code |
| *0 | Hang up (must ID after) |
| *6911 | EMERGENCY — calls 911 ⚠️ |

> **⚠️ *6911 is blocked by the CLI safety gate.** AI will never transmit this.

## AllStar (Node 60216)

| Code | Function |
|------|----------|
| *70 | Link status — what nodes are connected |
| *3 <node> | Connect to AllStar node in transceive mode |
| *2 <node> | Connect to AllStar node in monitor (listen only) mode |
| *1 <node> | Disconnect from a specific node |
| *76 | Disconnect from all nodes |

**To connect K6BJ from another AllStar repeater:** `*3 60216`  
**To disconnect:** `*1 60216`

## Echolink (K6BJ-R #354814)

| Code | Function |
|------|----------|
| *33 <node> | Connect to Echolink node |
| *13 <node> | Disconnect from Echolink node |
| *76 | Disconnect from all nodes |

## Common Operator Requests → Codes

| Operator says | Code |
|---------------|------|
| "What time is it?" | 767 |
| "Get the temperature" | 768 |
| "Check the voltage" / "How's the power?" | 769 |
| "Test my DTMF" / "Read back my tones" | 729 + digits |
| "Check link status" / "What's connected?" | *70 |
| "Connect to AllStar node 12345" | *3 12345 |
| "Disconnect from node 12345" | *1 12345 |
| "Disconnect all links" | *76 |
| "Connect to Echolink node 1234" | *33 1234 |
| "Play back my signal" | 28* |
| "Dial 831-555-1234" | *6 831 555 1234 |
| "Hang up the phone" | *0 |
| "Help" / "What can the repeater do?" | *920 |
