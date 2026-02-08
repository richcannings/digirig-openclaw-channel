# DigiRig Channel (OpenClaw)

Local ham radio RX/TX via DigiRig audio + PTT.

## Install from ZIP (fresh OpenClaw)
1) Download the plugin ZIP.
2) Extract it somewhere on disk.
3) Install deps and register the plugin:
```bash
unzip ~/digirig-openclaw-channel-1.0.zip -d ~/digirig-openclaw-channel-1.0
cd ~/digirig-openclaw-channel-1.0
npm install
openclaw plugins install -l ~/digirig-openclaw-channel-1.0
openclaw gateway restart
```

## Install from source
```bash
openclaw plugins install -l /path/to/openclaw/.openclaw/extensions/digirig
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

### STT (command)
Defaults are `command="whisper"` and `args="-f {input}"`. Override if needed:
```bash
openclaw config set channels.digirig.stt.command "whisper"
openclaw config set channels.digirig.stt.args -- "-m /path/to/model.bin -l en -f {input} -otxt -of {output}"
```

**STT args placeholders**
- `{input}` → path to WAV file
- `{sr}` → sample rate (Hz)
- `{output}` → output text file path

### TX callsign
```bash
openclaw config set channels.digirig.tx.callsign "W6RGC/AI"
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

# STT
whisper -f /tmp/rx.wav
```
