# DigiRig Channel (OpenClaw)

Talk to OpenClaw over ham radio. 

This project bridges ham radio voice operation to OpenClaw. It is implemented as a first‑class OpenClaw "Channel", with local Whisper-based speech recognition (CUDA GPU recommended). The plugin currently runs on Linux only.

We recommend using a DigiRig. This will work on all radios with vox enabled.

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

