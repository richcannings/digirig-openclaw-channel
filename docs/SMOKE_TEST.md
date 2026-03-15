# DigiRig Smoke Test

Use this after updates to confirm WhisperLive + DigiRig still work.

## 1) Service + listener

```bash
systemctl --user is-enabled whisperlive.service
systemctl --user is-active whisperlive.service
ss -ltn | grep 28080
```

Expected:
- enabled
- active
- listener on 127.0.0.1:28080 (or 0.0.0.0:28080)

## 2) Plugin doctor

```bash
/digirig doctor
```

Expected:
- service active: active
- service enabled: enabled
- STT listener present: yes

## 3) Gateway state

```bash
openclaw status
openclaw gateway status
```

## 4) On-air test phrase

Say this over RF:

> Overlord, this is Rich W6RGC. Give me a radio check and tell me what 2 plus 2 is.

Expected:
- RX line appears in `~/.openclaw/logs/digirig-YYYY-MM-DD.log`
- Short spoken TX reply is heard

## 5) Failure recovery

```bash
npm run setup:quickstart
openclaw gateway restart
```
