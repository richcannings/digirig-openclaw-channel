# DigiRig Channel (OpenClaw)

Talk to OpenClaw over ham radio. This project is a ham radio to OpenClaw bridge implemented as a first‑class OpenClaw channel (just like any other chat channel). It’s a playful nod to OpenClaw’s original “something you just talk to” intent, with local Whisper-based speech recognition (CUDA GPU recommended for faster STT). The initial git commit is 100% designed, implemented, and tested by OpenClaw using gpt-53-codex, and the plugin currently runs on Linux only.

We assume you already have a properly installed DigiRig and know how to use it.

## Checkout + use
```bash
git clone https://github.com/richcannings/digirig-openclaw-channel
cd digirig-openclaw-channel
npm install
openclaw plugins install -l .
openclaw gateway restart
```

## Configure
You can set these in the OpenClaw web app or via CLI.

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
openclaw config set channels.digirig.ptt.rts true
```

### STT (automatic)
Whisper is handled automatically and attempts to use CUDA when available. These settings usually don’t need changes, but the defaults are:
```bash
openclaw config set channels.digirig.stt.streamUrl "http://127.0.0.1:18080/inference"
openclaw config set channels.digirig.stt.streamIntervalMs 1000
openclaw config set channels.digirig.stt.streamWindowMs 4000
openclaw config set channels.digirig.stt.timeoutMs 15000
openclaw config set channels.digirig.stt.server.autoStart true
openclaw config set channels.digirig.stt.server.command "whisper-server"
openclaw config set channels.digirig.stt.server.args -- "-m {model} --host {host} --port {port}"
openclaw config set channels.digirig.stt.server.modelPath ""
openclaw config set channels.digirig.stt.server.host "127.0.0.1"
openclaw config set channels.digirig.stt.server.port 18080
openclaw config set channels.digirig.stt.server.restartMs 2000
```

### TX callsign
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
```

### TX disable (RX-only)
```bash
openclaw config set channels.digirig.ptt.rts false
```

