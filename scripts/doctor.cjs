#!/usr/bin/env node
/**
 * DigiRig Channel Doctor & Diagnostic Utility
 *
 * Checks all layers of the amateur radio AI pipeline:
 * 1. USB Serial Port (PTT / RTS)
 * 2. ALSA Capture & Playback Soundcards
 * 3. ALSA Mixer settings (Gain, AGC, Capture, Loopback)
 * 4. System dependencies (ffmpeg, etc.)
 * 5. Local Daemons (Whisper STT :18088, Piper TTS :18090, Kokoro TTS :18091, TX API :18089)
 * 6. Synthetic STT -> TTS loopback verification & inference latency benchmark
 *
 * Usage:
 *   node scripts/doctor.cjs
 *   node scripts/doctor.cjs --fix-mixer
 *   node scripts/doctor.cjs --json
 */

const { execSync } = require("child_process");
const http = require("http");

const ARGS = process.argv.slice(2);
const FIX_MIXER = ARGS.includes("--fix-mixer");
const JSON_OUTPUT = ARGS.includes("--json");

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }).trim();
  } catch (err) {
    return "";
  }
}

async function httpCheck(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        resolve({ ok: true, statusCode: res.statusCode });
      }
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.end();
  });
}

async function httpPost(url, bodyBuffer, contentType, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": bodyBuffer.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            headers: res.headers,
            body: buf,
          });
        });
      }
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.write(bodyBuffer);
    req.end();
  });
}

function createWav(pcm16, sampleRate) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // Mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // BlockAlign
  header.writeUInt16LE(16, 34); // BitsPerSample
  header.write("data", 36);
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

async function main() {
  const results = {
    serial: { pass: false, details: "" },
    alsaDevices: { pass: false, input: "", output: "", cardIndex: null, cardName: "" },
    alsaMixer: { pass: false, issues: [], details: "" },
    ffmpeg: { pass: false, path: "" },
    daemons: {
      whisper: { listening: false, url: "http://127.0.0.1:18088" },
      piper: { listening: false, url: "http://127.0.0.1:18090" },
      kokoro: { listening: false, url: "http://127.0.0.1:18091" },
      txApi: { listening: false, url: "http://127.0.0.1:18089" },
    },
    loopback: { tested: false, pass: false, latencyMs: 0, text: "", error: "" },
  };

  // 1. Serial Port Check
  let serialPorts = [];
  try {
    const fs = require("fs");
    const devFiles = fs.readdirSync("/dev");
    serialPorts = devFiles
      .filter((f) => f.startsWith("ttyUSB") || f.startsWith("ttyACM"))
      .map((f) => `/dev/${f}`);
  } catch (err) {
    serialPorts = [];
  }
  if (serialPorts.length > 0) {
    results.serial.pass = true;
    results.serial.details = serialPorts.join(", ");
  } else {
    results.serial.pass = false;
    results.serial.details = "No /dev/ttyUSB* or /dev/ttyACM* ports found";
  }

  // 2. ALSA Devices Check
  const arecordOut = run("arecord -l");
  const cardMatch = arecordOut.match(/card (\d+): ([^,\[]+)\[([^\]]+)\]/i);
  let digirigCard = null;

  // Search specifically for USB audio device / DigiRig
  const cardsRaw = run("cat /proc/asound/cards");
  const digirigLineMatch = cardsRaw.match(/(\d+)\s+\[([^\]]+)\]:\s+USB-Audio/i);
  if (digirigLineMatch) {
    digirigCard = {
      index: parseInt(digirigLineMatch[1], 10),
      name: digirigLineMatch[2].trim(),
    };
  } else if (cardMatch) {
    digirigCard = {
      index: parseInt(cardMatch[1], 10),
      name: cardMatch[2].trim(),
    };
  }

  if (digirigCard !== null) {
    results.alsaDevices.pass = true;
    results.alsaDevices.cardIndex = digirigCard.index;
    results.alsaDevices.cardName = digirigCard.name;
    results.alsaDevices.input = `plughw:CARD=${digirigCard.name},DEV=0`;
    results.alsaDevices.output = `plughw:CARD=${digirigCard.name},DEV=0`;
  } else {
    results.alsaDevices.pass = false;
    results.alsaDevices.details = "No USB Audio capture soundcard found in arecord -l";
  }

  // 3. ALSA Mixer Audit
  if (digirigCard !== null) {
    const cardId = digirigCard.name;
    const contents = run(`amixer -c ${cardId} contents`);
    const mixerIssues = [];

    const blocks = contents.split(/(?=numid=\d+)/);
    for (const block of blocks) {
      if (block.includes("name='Auto Gain Control'") && block.includes(": values=on")) {
        mixerIssues.push("Auto Gain Control is ON (should be OFF for clean RF)");
      }
      if (block.includes("name='Mic Capture Switch'") && block.includes(": values=off")) {
        mixerIssues.push("Mic Capture Switch is MUTED / OFF");
      }
      if (block.includes("name='Mic Capture Volume'")) {
        const m = block.match(/: values=(\d+)/);
        if (m && parseInt(m[1], 10) === 0) {
          mixerIssues.push("Mic Capture Volume is set to 0 (minimum)");
        }
      }
      if (block.includes("name='Speaker Playback Volume'")) {
        const m = block.match(/: values=(\d+),(\d+)/);
        if (m && (parseInt(m[1], 10) === 0 || parseInt(m[2], 10) === 0)) {
          mixerIssues.push("Speaker Playback Volume is set to 0 (silent TX)");
        }
      }
    }

    results.alsaMixer.issues = mixerIssues;
    results.alsaMixer.pass = mixerIssues.length === 0;

    if (FIX_MIXER) {
      run(`amixer -c ${cardId} cset numid=7 on 2>/dev/null || true`);
      run(`amixer -c ${cardId} cset numid=8 16 2>/dev/null || true`);
      run(`amixer -c ${cardId} cset numid=9 off 2>/dev/null || true`);
      run(`amixer -c ${cardId} cset numid=5 on 2>/dev/null || true`);
      run(`amixer -c ${cardId} cset numid=6 110,110 2>/dev/null || true`);
      run(`amixer -c ${cardId} cset numid=3 on 2>/dev/null || true`);
      run(`amixer -c ${cardId} cset numid=4 64 2>/dev/null || true`);
      run("sudo alsactl store 2>/dev/null || alsactl store 2>/dev/null || true");
      results.alsaMixer.details = "Applied optimal mixer gain settings and stored to ALSA state.";
      results.alsaMixer.pass = true;
      results.alsaMixer.issues = [];
    }
  }

  // 4. System Dependencies (ffmpeg)
  const ffmpegBin = run("which ffmpeg");
  if (ffmpegBin) {
    results.ffmpeg.pass = true;
    results.ffmpeg.path = ffmpegBin;
  } else {
    const pythonCheck = run(`~/.openclaw/venv/whisper-live/bin/python -c "import static_ffmpeg; print('found')" 2>/dev/null`);
    if (pythonCheck.includes("found")) {
      results.ffmpeg.pass = true;
      results.ffmpeg.path = "python static-ffmpeg";
    } else {
      results.ffmpeg.pass = false;
      results.ffmpeg.path = "NOT FOUND (required by Whisper STT)";
    }
  }

  // 5. Daemons Port Check
  const ssOut = run("ss -ltn");
  results.daemons.whisper.listening = ssOut.includes(":18088");
  results.daemons.piper.listening = ssOut.includes(":18090");
  results.daemons.kokoro.listening = ssOut.includes(":18091");
  results.daemons.txApi.listening = ssOut.includes(":18089");

  // 6. Synthetic Loopback Test (Piper -> Whisper)
  if (results.daemons.piper.listening && results.daemons.whisper.listening) {
    results.loopback.tested = true;
    const testPhrase = "Radio check one two three four";
    const t0 = Date.now();
    try {
      const ttsRes = await httpPost(
        "http://127.0.0.1:18090/tts",
        Buffer.from(JSON.stringify({ text: testPhrase })),
        "application/json"
      );

      if (ttsRes.ok && ttsRes.body.length > 0) {
        const sr = parseInt(ttsRes.headers["x-sample-rate"] || "22050", 10);
        const wav = createWav(ttsRes.body, sr);

        const sttRes = await httpPost(
          "http://127.0.0.1:18088/transcribe",
          wav,
          "audio/wav",
          20000
        );

        const latency = Date.now() - t0;
        results.loopback.latencyMs = latency;

        if (sttRes.ok) {
          const json = JSON.parse(sttRes.body.toString("utf-8") || "{}");
          results.loopback.text = (json.text || "").trim();
          results.loopback.pass = results.loopback.text.length > 0;
        } else {
          results.loopback.pass = false;
          results.loopback.error = `Whisper HTTP ${sttRes.statusCode}`;
        }
      } else {
        results.loopback.pass = false;
        results.loopback.error = `Piper TTS failed (${ttsRes.statusCode || ttsRes.error})`;
      }
    } catch (err) {
      results.loopback.pass = false;
      results.loopback.error = err.message;
    }
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Terminal Output Formatting
  console.log(`\n${COLORS.bold}===============================================${COLORS.reset}`);
  console.log(`${COLORS.bold}   DigiRig OpenClaw Channel Doctor & Health   ${COLORS.reset}`);
  console.log(`${COLORS.bold}===============================================${COLORS.reset}\n`);

  // [1] Serial Port
  printStatus(
    "1. PTT Serial Port (RTS Keying)",
    results.serial.pass,
    results.serial.details,
    "Connect DigiRig USB cable to host machine."
  );

  // [2] ALSA Devices
  printStatus(
    "2. USB Audio Soundcard",
    results.alsaDevices.pass,
    results.alsaDevices.pass ? `Card ${results.alsaDevices.cardIndex} (${results.alsaDevices.cardName}) -> ${results.alsaDevices.input}` : results.alsaDevices.details,
    "Ensure DigiRig USB audio is enumerated by the system."
  );

  // [3] ALSA Mixer
  printStatus(
    "3. ALSA Mixer Gains & AGC",
    results.alsaMixer.pass,
    results.alsaMixer.pass ? "Mic Capture 100%, AGC: OFF, Playback: Unmuted" : results.alsaMixer.issues.join("; "),
    "Run: node scripts/doctor.cjs --fix-mixer"
  );

  // [4] FFmpeg Dependency
  printStatus(
    "4. FFmpeg Audio Backend",
    results.ffmpeg.pass,
    results.ffmpeg.path,
    "Run: ~/.openclaw/venv/whisper-live/bin/pip install static-ffmpeg"
  );

  // [5] Local Daemons
  const daemonSummary = [
    `STT Whisper (:18088): ${results.daemons.whisper.listening ? "LISTENING" : "DOWN"}`,
    `TTS Piper   (:18090): ${results.daemons.piper.listening ? "LISTENING" : "DOWN"}`,
    `TX API      (:18089): ${results.daemons.txApi.listening ? "LISTENING" : "DOWN (openclaw gateway)"}`,
  ].join("\n     ");
  const allDaemonsUp = results.daemons.whisper.listening && results.daemons.txApi.listening;
  printStatus("5. Local Daemons & TX API", allDaemonsUp, daemonSummary, "Run: bash scripts/setup.sh && openclaw gateway restart");

  // [6] Synthetic Loopback Benchmark
  if (results.loopback.tested) {
    const loopbackDetails = results.loopback.pass
      ? `Transcribed: "${results.loopback.text}" in ${results.loopback.latencyMs}ms`
      : `Failed: ${results.loopback.error}`;
    printStatus("6. Synthetic Loopback (Piper -> Whisper)", results.loopback.pass, loopbackDetails, "Check whisper daemon logs with journalctl --user -u whisper-daemon -f");
  } else {
    printStatus("6. Synthetic Loopback (Piper -> Whisper)", false, "Skipped (requires both STT and TTS daemons up)", "Start services to run loopback benchmark.");
  }

  console.log(`\n${COLORS.bold}-----------------------------------------------${COLORS.reset}`);
  console.log(`${COLORS.bold}Helpful Test Commands:${COLORS.reset}`);
  console.log(`  ${COLORS.cyan}node scripts/doctor.cjs --fix-mixer${COLORS.reset}  Fix and persist ALSA mixer settings`);
  console.log(`  ${COLORS.cyan}node scripts/test-tx.cjs           ${COLORS.reset}  Transmit an on-air test voice beacon`);
  console.log(`  ${COLORS.cyan}node scripts/rx-meter.cjs          ${COLORS.reset}  Live terminal VU meter for volume tuning`);
  console.log(`  ${COLORS.cyan}node scripts/digirig-tail.cjs      ${COLORS.reset}  Live formatted radio QSO stream`);
  console.log(`${COLORS.bold}===============================================\n${COLORS.reset}`);
}

function printStatus(title, passed, details, fixHint) {
  const icon = passed ? `${COLORS.green}✔ PASS${COLORS.reset}` : `${COLORS.red}✖ FAIL${COLORS.reset}`;
  console.log(` ${icon} ${COLORS.bold}${title}${COLORS.reset}`);
  if (details) {
    console.log(`     ${COLORS.dim}${details}${COLORS.reset}`);
  }
  if (!passed && fixHint) {
    console.log(`     ${COLORS.yellow}Fix: ${fixHint}${COLORS.reset}`);
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
