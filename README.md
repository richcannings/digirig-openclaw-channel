# DigiRig Channel for OpenClaw

Talk to OpenClaw over ham radio. This plugin bridges RF audio into OpenClaw with streaming WhisperLive STT, policy‑aware routing, and PTT‑controlled TX.

## Overview
The DigiRig Voice Channel bridges ham radio voice interactions into the OpenClaw conversational system. Radio operators speak over RF, speech is transcribed to text, routed through OpenClaw’s agent system, and spoken replies are transmitted back over the radio. It provides a voice interaction surface comparable in richness to a chat channel, with structured routing, context handling, command processing, and policy‑aware TX.

## Goals
- **Bidirectional voice interface**: RX → STT → agent response → TTS → TX
- **Low‑latency interaction**: streaming STT via WhisperLive WebSocket
- **Simple local deployment**: local audio + DigiRig/PTT
- **Turnkey installation**: OpenClaw provisions WhisperLive and required models
- **Traceability**: transcript logs + timing metrics

## Non‑Goals
- Media attachments or rich cards
- Multi‑party chat threading (not yet)
- Cloud‑hosted STT/TTS services (local by default)

## Highlights
- **Streaming STT (WhisperLive WS)** for low‑latency replies
- **PTT‑controlled TX** with lead/tail timing and RX mute during TX
- **Policy gating** (`direct-only`, `value-and-wait`, `proactive`)
- **RX tuning** (energy threshold, silence, cooldowns)
- **Daily transcript logs** in `~/.openclaw/logs/`
- **Simplex/half‑duplex** behavior (no RX during TX)

## Install from source
```bash
# pick a location
mkdir -p ~/src
cd ~/src

git clone https://github.com/richcannings/digirig-openclaw-channel
cd digirig-openclaw-channel
npm install

openclaw plugins install -l ~/src/digirig-openclaw-channel
openclaw gateway restart
```

> **WhisperLive install:** the plugin setup provisions WhisperLive for you. You can override the WS URL if you already run a WhisperLive server.

## Configure
Configuration is possible through the web UI, CLI, or by voice. Common settings:

### Audio devices
```bash
arecord -l
aplay -l
openclaw config set channels.digirig.audio.inputDevice "plughw:0,0"
openclaw config set channels.digirig.audio.outputDevice "plughw:0,0"
```

### PTT
```bash
openclaw config set channels.digirig.ptt.device "/dev/ttyUSB0"
```

### STT (WhisperLive WebSocket)
```bash
openclaw config set channels.digirig.stt.wsUrl "ws://127.0.0.1:28080"
```

### TX callsign + policy
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
openclaw config set channels.digirig.tx.policy "direct-only"   # direct-only | value-and-wait | proactive
openclaw config set channels.digirig.tx.aliases "Overlord,Seven,7"
```

### TX disable (RX‑only)
```bash
openclaw config set channels.digirig.ptt.rts false
```

### RX tuning
If transmissions are truncated or missed, tune RX thresholds:
```bash
openclaw config set channels.digirig.rx.energyThreshold 0.0015
openclaw config set channels.digirig.rx.minSpeechMs 200
openclaw config set channels.digirig.rx.maxSilenceMs 900
openclaw config set channels.digirig.rx.maxRecordMs 60000
openclaw config set channels.digirig.rx.busyHoldMs 1500
openclaw config set channels.digirig.rx.startCooldownMs 500
```

## Logs
Daily transcripts are written to:
```
~/.openclaw/logs/digirig-YYYY-MM-DD.log
```

## Simplex behavior
This channel is **half‑duplex**: when TX is keyed, RX is muted/ignored. Overlapping speech during TX will not be transcribed.
