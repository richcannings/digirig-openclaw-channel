# DigiRig Smoke Test

Use this after updates to confirm the local Whisper batch pipeline + DigiRig still work.

## 1) Microphone Check

```bash
amixer -c Device sget Mic
```

Expected:
- Capture channel should indicate `[on]` and a non-zero volume.

## 2) Plugin doctor

```bash
/digirig doctor
```

Expected:
- Provides configuration overview and device statuses.

## 3) Gateway state

```bash
openclaw status
openclaw gateway status
```
Expected:
- The DigiRig channel should say "ON" and "configured".

## 4) On-air test phrase

Say this over RF:

> Overlord, this is Rich W6RGC. Give me a radio check and tell me what 2 plus 2 is.

*Wait for about 4-5 seconds of silence.*

Expected:
- RX line appears in `~/.openclaw/logs/digirig-YYYY-MM-DD.log` containing exactly what you said.
- Short spoken TX reply is heard shortly after.

## 5) Failure recovery

If you encounter `arecord exited with 1`, check the ALSA configuration:

```bash
openclaw config set channels.digirig.audio.inputDevice 'plug:"dsnoop:CARD=Device,DEV=0"'
openclaw gateway restart
```
