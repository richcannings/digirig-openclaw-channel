# DigiRig Channel for OpenClaw.

Talk to OpenClaw over ham radio. 

This plugin provides local ham radio RX/TX using VOX or PTT via a digirig.

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

### STT (WhisperLive WebSocket)
Streaming STT uses the collabora/WhisperLive server over WebSocket.

1) Run WhisperLive (example)
```bash
# inside your WhisperLive venv
python3 /path/to/whisperlive/run_server.py --port 28080 --backend faster_whisper   -fw Systran/faster-whisper-medium.en -c /path/to/models/whisper
```

2) Point DigiRig at the WS endpoint
```bash
openclaw config set channels.digirig.stt.wsUrl "ws://127.0.0.1:28080"
```

**Notes**
- WS STT is the only supported STT mode.
- Ensure the WhisperLive server is running before starting DigiRig.

### TX callsign
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
```

### TX disable (RX-only)
```bash
openclaw config set channels.digirig.ptt.rts false
```
