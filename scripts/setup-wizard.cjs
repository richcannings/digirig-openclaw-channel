#!/usr/bin/env node
/**
 * Interactive DigiRig Setup Wizard
 *
 * Configures callsign, activation aliases, hardware audio/PTT ports,
 * local TTS daemons, and ALSA mixer settings in ~/.openclaw/openclaw.json.
 *
 * Usage:
 *   node scripts/setup-wizard.cjs
 */

const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }).trim();
  } catch (err) {
    return "";
  }
}

function detectSerial() {
  try {
    const devFiles = fs.readdirSync("/dev");
    const port = devFiles.find((f) => f.startsWith("ttyUSB") || f.startsWith("ttyACM"));
    return port ? `/dev/${port}` : "/dev/ttyUSB0";
  } catch (err) {
    return "/dev/ttyUSB0";
  }
}

function detectAlsaDevice() {
  try {
    const cards = run("cat /proc/asound/cards");
    const match = cards.match(/(\d+)\s+\[([^\]]+)\]:\s+USB-Audio/i);
    if (match) {
      return `plughw:CARD=${match[2].trim()},DEV=0`;
    }
  } catch (err) {
    // Ignore
  }
  return "plughw:CARD=Device,DEV=0";
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, defaultValue) {
  return new Promise((resolve) => {
    const prompt = defaultValue !== undefined ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(prompt, (ans) => {
      const trimmed = ans.trim();
      resolve(trimmed ? trimmed : defaultValue);
    });
  });
}

async function main() {
  console.log("\n=======================================================");
  console.log("       DigiRig OpenClaw Channel Interactive Setup      ");
  console.log("=======================================================\n");

  const configDir = path.join(process.env.HOME || "", ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");

  let existingCfg = {};
  if (fs.existsSync(configPath)) {
    try {
      existingCfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (err) {
      console.warn("Warning: Could not parse existing openclaw.json. Creating backup.");
      fs.copyFileSync(configPath, `${configPath}.bak-${Date.now()}`);
    }
  }

  const currentDigirig = existingCfg.channels?.digirig || {};

  // 1. Station Identity & Callsign
  console.log("--- 1. Station Identity & FCC Compliance ---");
  const callsign = await ask(
    "Enter your FCC Callsign with optional AI suffix",
    currentDigirig.tx?.callsign || "W6RGC/AI"
  );

  // 2. Persona & Trigger Aliases
  console.log("\n--- 2. Assistant Persona & Trigger Aliases ---");
  const personaName = await ask(
    "Enter the name/call of the AI persona",
    currentDigirig.persona?.name || "Boss"
  );
  const aliases = await ask(
    "Enter comma-separated wake aliases that trigger the bot",
    currentDigirig.tx?.aliases || personaName
  );
  const location = await ask(
    "Enter station city / location",
    currentDigirig.persona?.location || "Santa Cruz, CA"
  );

  // 3. Hardware Auto-Detection
  console.log("\n--- 3. Audio & PTT Hardware Configuration ---");
  const autoInput = detectAlsaDevice();
  const autoPtt = detectSerial();

  const inputDevice = await ask("ALSA Audio Input Device", currentDigirig.audio?.inputDevice || autoInput);
  const outputDevice = await ask("ALSA Audio Output Device", currentDigirig.audio?.outputDevice || autoInput);
  const pttDevice = await ask("Serial PTT Device", currentDigirig.ptt?.device || autoPtt);

  // 4. TTS Engine
  console.log("\n--- 4. Text-to-Speech (TTS) Backend ---");
  console.log("  [P] Piper   - Fast, local neural TTS on :18090 (Recommended)");
  console.log("  [K] Kokoro  - Natural local neural TTS on :18091");
  console.log("  [C] Cloud   - OpenClaw cloud TTS provider");
  const ttsChoice = await ask("Choose TTS engine (P/K/C)", "P");
  let ttsEngine = "piper";
  let ttsUrl = "http://127.0.0.1:18090";
  if (ttsChoice.toUpperCase() === "K") {
    ttsEngine = "kokoro";
    ttsUrl = "http://127.0.0.1:18091";
  } else if (ttsChoice.toUpperCase() === "C") {
    ttsEngine = "off";
    ttsUrl = "";
  }

  // 5. Sensitivity Threshold
  console.log("\n--- 5. Audio Sensitivity & Squelch ---");
  const energyThresholdStr = await ask(
    "Energy VAD Threshold (0.003 recommended for handheld audio)",
    String(currentDigirig.rx?.energyThreshold || 0.003)
  );
  const energyThreshold = parseFloat(energyThresholdStr) || 0.003;

  // Build new configuration
  const newDigirig = {
    ...currentDigirig,
    enabled: true,
    audio: {
      ...(currentDigirig.audio || {}),
      inputDevice,
      outputDevice,
      sampleRate: 48000,
    },
    ptt: {
      ...(currentDigirig.ptt || {}),
      device: pttDevice,
      rts: true,
    },
    tx: {
      ...(currentDigirig.tx || {}),
      callsign,
      aliases,
      policy: "direct-only",
      maxTxMs: 120000,
      courtesyDelayMs: 800,
      allowToolTx: true,
    },
    rx: {
      ...(currentDigirig.rx || {}),
      energyThreshold,
      carrierSenseThreshold: 0.0004,
    },
    localTts: {
      engine: ttsEngine,
      url: ttsUrl,
    },
    persona: {
      name: personaName,
      location,
    },
  };

  if (!existingCfg.channels) existingCfg.channels = {};
  existingCfg.channels.digirig = newDigirig;

  // Save config
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(existingCfg, null, 2), "utf-8");
  console.log(`\n✔ Configuration saved to: ${configPath}`);

  // Apply ALSA Mixer
  console.log("\n--- 6. ALSA Hardware Mixer Calibration ---");
  const fixMixer = await ask("Apply optimal ALSA mixer gains and unmute hardware? (Y/n)", "Y");
  if (fixMixer.toUpperCase().startsWith("Y")) {
    try {
      execSync("node " + path.join(__dirname, "doctor.cjs") + " --fix-mixer", { stdio: "inherit" });
    } catch (e) {
      // Ignore
    }
  }

  // Ask to restart gateway
  const restartGateway = await ask("\nRestart OpenClaw Gateway now to apply changes? (Y/n)", "Y");
  if (restartGateway.toUpperCase().startsWith("Y")) {
    try {
      console.log("Restarting openclaw-gateway.service...");
      execSync("openclaw gateway restart || systemctl --user restart openclaw-gateway.service", { stdio: "inherit" });
      console.log("✔ Gateway restarted.");
    } catch (e) {
      console.warn("Could not restart gateway automatically. Run: openclaw gateway restart");
    }
  }

  console.log("\n=======================================================");
  console.log("             DigiRig Setup Complete! 📻               ");
  console.log("=======================================================");
  console.log("Next steps:");
  console.log("  1. Run diagnostic:  npm run doctor");
  console.log("  2. Test TX beacon:  npm run test:tx");
  console.log("  3. Tune RX audio:   npm run test:rx-meter");
  console.log("  4. Monitor QSOs:    node scripts/digirig-tail.cjs\n");

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
