# DigiRig Channel for OpenClaw.

Talk to OpenClaw over ham radio. 

This plugin provides local ham radio RX/TX via DigiRig audio using VOX or PTT with a digirig.

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

## Configure

Configuration is possible through the web ui, command line, and of course by talking with openclaw. Here are the commmand line settings.

### Audio devices
```bash
arecord -l
aplay -l
openclaw config set channels.digirig.audio.inputDevice "plughw:0,0"
openclaw config set channels.digirig.audio.outputDevice "plughw:0,0"
```

### PTT
This can also be used for testing so that openclaw does not transmit.
```bash
openclaw config set channels.digirig.ptt.device "/dev/ttyUSB0"
openclaw config set channels.digirig.ptt.rts true
```

### STT (streaming via whisper-server)
Streaming STT reduces latency by sending rolling audio windows to a local `whisper-server` (required).

1) Build whisper.cpp
```bash
# Clone once (example path)
git clone https://github.com/ggerganov/whisper.cpp ~/src/whisper.cpp

# Ensure helper scripts are executable
chmod +x /path/to/digirig/scripts/whisper-*.sh

# CPU build
cd ~/src/whisper.cpp
bash /path/to/digirig/scripts/whisper-build.sh cpu ~/src/whisper.cpp
```

**CUDA build (GPU acceleration)**
```bash
# Install CUDA toolkit (Debian/Ubuntu)
sudo apt-get update
sudo apt-get install -y nvidia-cuda-toolkit

# Build with CUDA
bash /path/to/digirig/scripts/whisper-build.sh cuda ~/src/whisper.cpp
```

2) Download a model
```bash
cd ~/src/whisper.cpp
bash ./models/download-ggml-model.sh medium.en
```

3) Configure OpenClaw to auto-start whisper-server
```bash
openclaw config set channels.digirig.stt.server.modelPath "/path/to/whisper.cpp/models/ggml-medium.en.bin"
openclaw config set channels.digirig.stt.server.command "whisper-server"
openclaw config set channels.digirig.stt.server.args -- "-m {model} --host {host} --port {port}"
```

4) Configure OpenClaw streaming endpoint + tuning
```bash
openclaw config set channels.digirig.stt.streamUrl "http://127.0.0.1:18080/inference"
# Optional tuning:
openclaw config set channels.digirig.stt.streamIntervalMs 1000
openclaw config set channels.digirig.stt.streamWindowMs 4000
```

**Notes**
- GPU build requires NVIDIA drivers + CUDA toolkit installed.
- whisper-server auto-starts when DigiRig starts (if modelPath is set).
- You can still run the server manually:
```bash
bash /path/to/digirig/scripts/whisper-server.sh ~/src/whisper.cpp ~/src/whisper.cpp/models/ggml-medium.en.bin 127.0.0.1 18080
```

### TX callsign
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
```

### TX disable (RX-only)
```bash
openclaw config set channels.digirig.ptt.rts false
```
