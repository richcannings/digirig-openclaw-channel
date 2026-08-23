#!/usr/bin/env node
/**
 * DigiRig Live RX Audio VU Meter & Calibration Tool
 *
 * Streams raw audio from the DigiRig sound card and renders a live
 * real-time ASCII volume / energy meter in the terminal.
 *
 * Use this to:
 * 1. Measure background RF noise floor when squelch is closed (~0.0002)
 * 2. Observe squelch breaking when an incoming signal arrives
 * 3. Tune the radio's volume knob so voice peaks reach ~0.05 to ~0.30
 *
 * Usage:
 *   node scripts/rx-meter.cjs
 *   node scripts/rx-meter.cjs --device plughw:CARD=Device,DEV=0 --threshold 0.003
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function getAutoDetectedInputDevice() {
  try {
    const cards = execSync("cat /proc/asound/cards 2>/dev/null", { encoding: "utf-8" });
    const match = cards.match(/(\d+)\s+\[([^\]]+)\]:\s+USB-Audio/i);
    if (match) {
      return `plughw:CARD=${match[2].trim()},DEV=0`;
    }
  } catch (err) {
    // Ignore
  }
  return "plughw:CARD=Device,DEV=0";
}

function getConfiguredThreshold() {
  try {
    const configPath = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return cfg.channels?.digirig?.rx?.energyThreshold || 0.003;
    }
  } catch (err) {
    // Ignore
  }
  return 0.003;
}

const ARGS = process.argv.slice(2);
let device = getAutoDetectedInputDevice();
let threshold = getConfiguredThreshold();

for (let i = 0; i < ARGS.length; i++) {
  if (ARGS[i] === "--device" && ARGS[i + 1]) {
    device = ARGS[++i];
  } else if (ARGS[i] === "--threshold" && ARGS[i + 1]) {
    threshold = parseFloat(ARGS[++i]);
  }
}

console.log("\x1b[2J\x1b[H"); // Clear screen
console.log("=========================================================");
console.log("     DigiRig Live RX Audio VU Meter & Calibration        ");
console.log("=========================================================");
console.log(` Audio Input: ${device}`);
console.log(` Trigger Threshold: ${threshold}`);
console.log(" Press Ctrl+C to stop.\n");
console.log(" Instructions:");
console.log(" 1. With squelch CLOSED, the bar should be near the far left (~0.0002).");
console.log(" 2. Key your handheld and speak: the bar should cross THRESHOLD [VOICE].");
console.log(" 3. Adjust your radio's volume knob if audio is too quiet or clipping.");
console.log("---------------------------------------------------------\n");

const arecord = spawn("arecord", [
  "-D", device,
  "-f", "S16_LE",
  "-r", "48000",
  "-c", "1",
  "-t", "raw",
  "-q",
]);

let maxRecentPeak = 0;
let peakDecayTimer = Date.now();

arecord.stdout.on("data", (chunk) => {
  const samples = new Int16Array(
    chunk.buffer,
    chunk.byteOffset,
    chunk.byteLength / 2
  );
  if (samples.length === 0) return;

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768.0;
    sumSquares += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  if (peak > maxRecentPeak) {
    maxRecentPeak = peak;
    peakDecayTimer = Date.now();
  } else if (Date.now() - peakDecayTimer > 500) {
    maxRecentPeak = maxRecentPeak * 0.9;
  }

  renderMeter(rms, peak, threshold);
});

arecord.stderr.on("data", (data) => {
  console.error(`arecord: ${data.toString()}`);
});

arecord.on("error", (err) => {
  console.error(`Failed to spawn arecord: ${err.message}`);
  process.exit(1);
});

arecord.on("close", (code) => {
  console.log(`\narecord exited with code ${code}`);
  process.exit(code);
});

function renderMeter(rms, peak, thr) {
  const barWidth = 36;
  const isTriggered = rms >= thr;
  const scaled = Math.min(1.0, rms * 3.0); // Scale 0.0 - 0.33 to full bar
  const filled = Math.round(scaled * barWidth);

  let bar = "";
  for (let i = 0; i < barWidth; i++) {
    if (i < filled) {
      if (i > barWidth * 0.8) {
        bar += "\x1b[31m█\x1b[0m"; // Red (clipping)
      } else if (i > barWidth * 0.5) {
        bar += "\x1b[33m█\x1b[0m"; // Yellow (good voice)
      } else {
        bar += "\x1b[32m█\x1b[0m"; // Green
      }
    } else {
      bar += "\x1b[90m░\x1b[0m";
    }
  }

  const statusTag = isTriggered
    ? "\x1b[1m\x1b[32m[VOICE DETECTED]\x1b[0m"
    : "\x1b[90m[QUIET/IDLE]\x1b[0m   ";

  const rmsStr = rms.toFixed(4).padStart(6, " ");
  const peakStr = peak.toFixed(3).padStart(5, " ");
  const line = `\r RMS: ${rmsStr} | Peak: ${peakStr} [${bar}] ${statusTag} `;
  process.stdout.write(line);
}

process.on("SIGINT", () => {
  arecord.kill("SIGTERM");
  console.log("\n\nStopped RX meter.\n");
  process.exit(0);
});
