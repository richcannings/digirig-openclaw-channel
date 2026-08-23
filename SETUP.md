# DigiRig OpenClaw Channel Setup Guide 📻

This guide walks through configuring and running the **DigiRig OpenClaw Channel** to connect your amateur radio to OpenClaw.

---

## 📋 Prerequisites

1. **DigiRig Mobile Interface** (v1.9 or Mobile) connected via USB.
2. **Radio Cable** plugged into the DigiRig **`AUDIO`** port and your transceiver.
3. System packages:
   ```bash
   sudo apt-get update && sudo apt-get install -y alsa-utils
   ```

---

## 🚀 Quickstart (3 Steps)

### Step 1: Install Dependencies & Local Speech Daemons

Run the automated installer:
```bash
npm install
bash scripts/setup.sh
```
- Installs local **Whisper STT** daemon (`whisper-daemon.service` on port `18088`, defaults to `base.en`).
- Installs local **Piper TTS** daemon (`piper-daemon.service` on port `18090`).

> 💡 **Note on STT Model Selection:** `base.en` is selected by default for rapid ~1.0s turnaround. If the model has trouble hearing or transcribing radio audio under noisy RF conditions, bump `--model` in `~/.config/systemd/user/whisper-daemon.service` to `medium.en`.

---

### Step 2: Run the Interactive Setup Wizard

Configure your FCC callsign, persona name, and hardware ports:
```bash
npm run setup
```
This wizard will prompt you for:
- **FCC Callsign** (e.g. `W6RGC/AI`)
- **Assistant Persona & Wake Aliases** (e.g. `Boss`, `Radio`, `Base`)
- **Station Location** (e.g. `Santa Cruz, CA`)
- **Audio & Serial Ports** (auto-detected from your system)
- **ALSA Mixer Calibration** (automatically sets gains and saves with `alsactl store`)

---

### Step 3: Run Diagnostics & On-Air Test

Verify the entire pipeline before making your first live call:

```bash
# 1. Run full subsystem health check
npm run doctor

# 2. Transmit an on-air voice beacon to verify TX & PTT
npm run test:tx

# 3. (Optional) Open the live RX audio meter to check your radio's volume knob
npm run test:rx-meter
```

---

## 🎙️ Making Your First QSO

1. In a terminal window, start the live log tailer:
   ```bash
   node scripts/digirig-tail.cjs
   ```
2. Key your handheld microphone and speak:
   > *"Boss, this is [YOUR_CALLSIGN]. Give me a radio check and tell me what 2 plus 2 is."*
3. Release PTT and listen for the AI's response on your radio!

---

## 🔧 Useful Slash Commands in OpenClaw

| Command | Action |
| :--- | :--- |
| `/digirig doctor` | Runs doctor audit directly inside OpenClaw chat |
| `/digirig setup` | Displays current hardware configuration |
| `/digirig tx <text>` | Manually transmits text via radio |
| `/digirig unkey` | Emergency PTT release / cancel active transmissions |
