# DigiRig Channel (OpenClaw)

Local ham radio RX/TX via DigiRig audio + PTT.

## Install
```bash
openclaw plugins install -l /home/richc/.openclaw/workspace/.openclaw/extensions/digirig
openclaw gateway restart
```

## Configure
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

### STT (command mode)
```bash
openclaw config set channels.digirig.stt.mode command
openclaw config set channels.digirig.stt.command "/home/richc/src/openclaw/whisper.cpp/build/bin/whisper-cli"
openclaw config set channels.digirig.stt.args -- "-m /home/richc/src/openclaw/whisper.cpp/models/ggml-base.en.bin -l en -f {input}"
```

**STT args placeholders**
- `{input}` → path to WAV file
- `{sr}` → sample rate (Hz)

### STT (stream mode via whisper.cpp server)
This uses the official `whisper.cpp` HTTP server (persistent model, no per-utterance process spawn).

**Build & run whisper.cpp server**
```bash
# build (once)
git clone https://github.com/ggml-org/whisper.cpp /home/richc/src/openclaw/whisper.cpp
cd /home/richc/src/openclaw/whisper.cpp
cmake -B build
cmake --build build --config Release -j

# download a model (example)
./models/download-ggml-model.sh base.en

# run server on port 18080
./build/bin/whisper-server -m ./models/ggml-base.en.bin --host 127.0.0.1 --port 18080
```

**Configure OpenClaw to use the server**
```bash
openclaw config set channels.digirig.stt.mode stream
openclaw config set channels.digirig.stt.streamUrl "http://127.0.0.1:18080/inference"
```

Optional stream tuning:
```bash
# how often to send rolling-window partials while recording
openclaw config set channels.digirig.stt.streamIntervalMs 800
# rolling window size (ms)
openclaw config set channels.digirig.stt.streamWindowMs 4000
```

### RX acknowledgment tone
```bash
openclaw config set channels.digirig.rx.ackToneEnabled true
```

### TX disable (RX-only)
```bash
openclaw config set channels.digirig.ptt.rts false
```

## Permissions
If PTT serial access fails:
```bash
sudo usermod -aG dialout $USER
```
Log out/in afterward.

## Quick test
```bash
# RX capture
arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -d 5 /tmp/rx.wav
/home/richc/src/openclaw/whisper.cpp/build/bin/whisper-cli -m /home/richc/src/openclaw/whisper.cpp/models/ggml-base.en.bin -l en -f /tmp/rx.wav
```
