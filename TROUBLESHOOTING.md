# DigiRig Channel Troubleshooting Guide

This guide covers diagnosing and solving common audio, RF, ALSA, and daemon issues with the DigiRig OpenClaw channel.

---

## ⚡ Quick Diagnostic Commands

Run these tools from the repository directory:

```bash
# 1. Full subsystem audit (Hardware, Mixer, FFmpeg, Daemons, Synthetic Loopback)
npm run doctor

# 2. Automatically fix and persist ALSA mixer settings
npm run doctor -- --fix-mixer

# 3. Transmit an on-air test voice beacon over RF
npm run test:tx

# 4. Open a real-time ASCII VU meter to calibrate radio volume and squelch
npm run test:rx-meter

# 5. Tail formatted live radio QSO traffic
node scripts/digirig-tail.cjs
```

---

## 🎛️ ALSA Mixer Calibration Cheatsheet

The DigiRig Mobile uses a C-Media USB Audio Controller (CM108/CM119). Proper mixer levels are required for RF audio capture and transmission.

### Optimal Settings Table

| Control Name | `numid` | Recommended Setting | Purpose |
| :--- | :--- | :--- | :--- |
| **Mic Capture Switch** | `7` | `on` | Enables microphone/RX line input |
| **Mic Capture Volume** | `8` | `16` (Max / +23.81 dB) | Provides full dynamic range for incoming RF audio |
| **Auto Gain Control (AGC)** | `9` | **`off`** | **Must be OFF**; AGC dynamically crushes radio squelch bursts |
| **Mic Playback Switch** | `3` | `on` | Hardware monitor loopback (unmuted) |
| **Mic Playback Volume** | `4` | `64` (~50%) | Internal monitoring gain |
| **Speaker Playback Switch**| `5` | `on` | Enables TX audio playback |
| **Speaker Playback Volume**| `6` | `110, 110` (~75%) | Clean FM deviation without over-modulating transmitter |

### One-Line Fix & Save

To apply all optimal mixer settings and make them permanent across reboots:

```bash
npm run doctor -- --fix-mixer
```

Or manually via `amixer`:
```bash
# Unmute and set capture gain to max, turn AGC OFF
amixer -c Device cset numid=7 on
amixer -c Device cset numid=8 16
amixer -c Device cset numid=9 off

# Unmute playback and set clean TX level
amixer -c Device cset numid=5 on
amixer -c Device cset numid=6 110,110

# Unmute internal loopback
amixer -c Device cset numid=3 on
amixer -c Device cset numid=4 64

# Save permanently to /var/lib/alsa/asound.state
sudo alsactl store
```

---

## 📻 Audio & Volume Knob Tuning

### Symptoms & Root Causes

| Symptom | Observation in Logs | Root Cause & Resolution |
| :--- | :--- | :--- |
| **No response from AI** | `energy avg=0.0002` flat during transmission | Audio not reaching soundcard. Check radio volume knob (~40%–50%), verify cable in `AUDIO` port (not `SERIAL`). Run `npm run test:rx-meter` to see squelch breaks live. |
| **STT: (empty)** | `RX session start` followed by empty STT | Missing `ffmpeg` or STT timeout. Check `npm run doctor` to verify FFmpeg backend. |
| **Voice clips discarded** | `discarded low-energy clip` | Energy threshold set too high. Set `channels.digirig.rx.energyThreshold` to `0.003` in `~/.openclaw/openclaw.json`. |
| **Over-modulation / Hum** | Distorted TX audio on handheld | `Speaker Playback Volume` is too high (lower to 100-110). Ensure DigiRig ferrite beads are installed on USB and audio cables. |

### Calibrating with the Live RX Meter

Run:
```bash
npm run test:rx-meter
```
1. **With squelch closed (quiet channel):** The meter should read `RMS: ~0.0002` (idle baseline noise).
2. **Key your mic and speak:** The meter should jump to `RMS: ~0.02 to 0.15` and show `[VOICE DETECTED]`.
3. **If audio does not cross threshold:** Slightly raise your radio's physical volume knob until normal voice comfortably triggers the meter.

---

## ⚡ STT Performance & Inference Latency

### CPU vs. GPU Acceleration

| Hardware | Recommended Model | Typical Latency | Notes |
| :--- | :--- | :--- | :--- |
| **NVIDIA GPU (CUDA)** | `small.en` or `medium.en` | **~200ms – 500ms** | Tensor core FP16 acceleration |
| **CPU / Jetson (Host CPU)** | `base.en` *(Default)* | **~800ms – 1.2s** | Fast and lightweight for real-time radio QSO |

> **Model Quality vs Latency Note:**
> By default, the service uses `base.en` to keep radio turnaround times under ~1.5 seconds. If the bot is having trouble hearing noisy, static-heavy, or distorted transmissions accurately, bump the model up to `medium.en` (or `small.en`).
>
> To upgrade to `medium.en`:
> 1. Edit `~/.config/systemd/user/whisper-daemon.service` and change `--model base.en` to `--model medium.en`.
> 2. Reload and restart:
>    ```bash
>    systemctl --user daemon-reload && systemctl --user restart whisper-daemon.service
>    ```

### Missing FFmpeg Error
If logs show:
```
[Errno 2] No such file or directory: 'ffmpeg'
```
Whisper requires `ffmpeg` to process audio files. Install `static-ffmpeg`:
```bash
~/.openclaw/venv/whisper-live/bin/pip install static-ffmpeg
```

### Checking Daemon Status
```bash
# Check STT daemon
systemctl --user status whisper-daemon.service

# Check TTS daemon
systemctl --user status piper-daemon.service

# View live daemon logs
journalctl --user -u whisper-daemon.service -f
```

---

## 🚨 Emergency Unkey & PTT Safety

If the transmitter remains keyed or gets stuck in a transmit loop:

1. In OpenClaw chat, send:
   ```
   /digirig unkey
   ```
2. Or via terminal:
   ```bash
   openclaw gateway restart
   ```
