# DigiRig Smoke Test

Run after updates to confirm everything works.

## Pre-flight
```bash
# Check devices
lsusb | grep -i "cp21\|digirig\|silicon"
arecord -l
aplay -l
ls /dev/ttyUSB*

# Check STT daemon
curl -s http://127.0.0.1:18088/health || echo "STT daemon not running"

# Check TX API
curl -s http://127.0.0.1:18089/tx/status || echo "TX API not running (restart gateway)"

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

## Log Viewer
```bash
node scripts/digirig-tail.cjs
# Should show color-coded RX/TX entries
```

## On-Air Test
1. Transmit: "Seven, this is [callsign]. Radio check."
2. Verify response within ~10 seconds
3. Check log: `tail -5 ~/.openclaw/logs/digirig-$(date +%Y-%m-%d).log`
4. Verify callsign correction in logs (if applicable)
5. Verify sender identification in log viewer
