# DigiRig Smoke Test

Run after updates to confirm everything works.

## Pre-flight
```bash
# Check devices
lsusb | grep -i "cp21\|digirig\|silicon"
arecord -l
aplay -l
ls /dev/ttyUSB*

# Check STT daemon is accepting connections (it only serves POST /transcribe;
# a 404 means the daemon is up — connection refused means it isn't).
curl -sf --max-time 2 http://127.0.0.1:18088/ >/dev/null; \
  [ $? -eq 22 ] && echo "STT daemon listening" \
  || echo "STT daemon not running"

# Check TX API
curl -s http://127.0.0.1:18089/tx/status || echo "TX API not running (restart gateway)"

# Check local TTS daemons (only whichever you've installed)
curl -sf http://127.0.0.1:18090/healthz && echo "Piper TTS listening"  || echo "Piper TTS: not running"
curl -sf http://127.0.0.1:18091/healthz && echo "Kokoro TTS listening" || echo "Kokoro TTS: not running"

# Or use the plugin's own check, which covers all the above plus device detection:
# /digirig doctor

# Check gateway
openclaw status
```

## Audio Test
```bash
# Record 3 seconds, verify audio capture works
arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -d 3 /tmp/test.wav
aplay /tmp/test.wav
rm /tmp/test.wav
```

## DTMF Test
```bash
# Dry run (no audio)
node scripts/dtmf-send.mjs --dry-run --verbose 767

# WAV output (verify with sox)
node scripts/dtmf-send.mjs --wav-out /tmp/dtmf-test.wav 767
sox /tmp/dtmf-test.wav -n stat 2>&1 | head -5
rm /tmp/dtmf-test.wav

# TX API test (requires running gateway)
node scripts/dtmf-send.mjs --tx --json --dry-run 767
```

## Local TTS Test (if configured)
```bash
# Piper — should return ~100+ KB of audio/l16 for a short phrase
curl -sS -o /tmp/piper.pcm -D /tmp/piper.hdr \
  -X POST -H "Content-Type: application/json" \
  --data '{"text":"Five by nine, loud and clear."}' \
  http://127.0.0.1:18090/tts
grep -i "x-sample-rate" /tmp/piper.hdr

# Kokoro — same idea on 18091
curl -sS -o /tmp/kokoro.pcm -D /tmp/kokoro.hdr \
  -X POST -H "Content-Type: application/json" \
  --data '{"text":"Five by nine, loud and clear."}' \
  http://127.0.0.1:18091/tts
grep -iE "x-sample-rate|x-voice" /tmp/kokoro.hdr
rm -f /tmp/piper.pcm /tmp/piper.hdr /tmp/kokoro.pcm /tmp/kokoro.hdr
```

## Log Viewer
```bash
node scripts/digirig-tail.cjs
# Should show color-coded RX/TX entries; shows last 30 lines of history on startup.
```

## On-Air Test
1. Transmit: "[Your alias], this is [your callsign]. Radio check."
2. Verify a voice response within ~15 seconds (depends on LLM).
3. Check log: `tail -5 ~/.openclaw/logs/digirig-$(date +%Y-%m-%d).log`
4. In the METRIC line, `speakMs` and `responseTimeMs` should be non-null —
   that proves the full RX → STT → LLM → TTS → PTT → aplay loop ran.
5. Verify callsign correction in logs (if applicable).
6. Verify sender identification in log viewer.
7. Try `/digirig unkey` — PTT should drop instantly even mid-transmission.
