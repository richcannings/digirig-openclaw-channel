#!/usr/bin/env node
// dtmf-send — Generate and transmit DTMF tones via ALSA audio device.
// No dependencies. Pure PCM synthesis piped to aplay.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// DTMF frequency matrix (ITU-T)
const DTMF = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477], "A": [697, 1633],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477], "B": [770, 1633],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477], "C": [852, 1633],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477], "D": [941, 1633],
};

const EMERGENCY_PATTERN = /911/;

function parseArgs(argv) {
  const args = {
    output: null, toneMs: 250, spacingMs: 250, leadMs: 0,
    amplitude: 0.3, voiceScale: 1.0, sampleRate: 16000,
    dryRun: false, wavOut: null, verbose: false, json: false,
    allowEmergency: false, tx: false, txUrl: "http://127.0.0.1:18089/tx/raw",
    say: null,
    help: false, sequence: null,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--help" || a === "-h") { args.help = true; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--verbose") { args.verbose = true; }
    else if (a === "--json") { args.json = true; }
    else if (a === "--allow-emergency") { args.allowEmergency = true; }
    else if (a === "--tx") { args.tx = true; }
    else if (a === "--tx-url" && rest[i + 1]) { args.txUrl = rest[++i]; }
    else if (a === "--output" && rest[i + 1]) { args.output = rest[++i]; }
    else if (a === "--tone-ms" && rest[i + 1]) { args.toneMs = Number(rest[++i]); }
    else if (a === "--spacing-ms" && rest[i + 1]) { args.spacingMs = Number(rest[++i]); }
    else if (a === "--lead-ms" && rest[i + 1]) { args.leadMs = Number(rest[++i]); }
    else if (a === "--amplitude" && rest[i + 1]) { args.amplitude = Number(rest[++i]); }
    else if (a === "--voice-scale" && rest[i + 1]) { args.voiceScale = Number(rest[++i]); }
    else if (a === "--sample-rate" && rest[i + 1]) { args.sampleRate = Number(rest[++i]); }
    else if (a === "--wav-out" && rest[i + 1]) { args.wavOut = rest[++i]; }
    else if (a === "--say" && rest[i + 1]) { args.say = rest[++i]; }
    else if (!a.startsWith("--")) { args.sequence = a; }
    else { console.error(`Unknown option: ${a}`); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`dtmf-send — Generate and transmit DTMF tones via ALSA audio device.

USAGE:
  dtmf-send --output <device> [options] <sequence>

SEQUENCE:
  One or more DTMF digits: 0-9 A-D * #
  Spaces and dashes are stripped automatically.
  Examples: 767, "831 555 1234", "123*#A"

OPTIONS:
  --output <device>      ALSA audio device (required). Example: plughw:0,0
  --tone-ms <ms>         Duration of each tone in ms (default: 250)
  --spacing-ms <ms>      Silence between tones in ms (default: 250)
  --lead-ms <ms>         Silence before first tone for PTT settling (default: 0)
  --amplitude <0.0-1.0>  Base output amplitude (default: 0.3)
  --voice-scale <float>  Scale amplitude relative to voice output level (default: 1.0)
  --sample-rate <hz>     Audio sample rate (default: 16000)
  --wav-out <path>       Write audio to WAV file instead of playing
  --dry-run              Validate sequence and show timing without audio output
  --verbose              Print detailed frequency and timing info
  --json                 Output results as JSON
  --tx                   Transmit via DigiRig runtime API (handles PTT automatically)
  --tx-url <url>         DigiRig TX API URL (default: http://127.0.0.1:18089/tx/raw)
  --say <text>           Speak text before sending tones (uses /tx/text). Requires --tx.
                         Ensures voice ack always precedes tones, atomically queued.
  --allow-emergency      Allow emergency sequences (911, 78911). Blocked by default.
  --help                 Show this help message

DTMF FREQUENCY MATRIX:
            1209Hz  1336Hz  1477Hz  1633Hz
  697Hz:     1       2       3       A
  770Hz:     4       5       6       B
  852Hz:     7       8       9       C
  941Hz:     *       0       #       D

EXAMPLES:
  dtmf-send --output plughw:0,0 767
  dtmf-send --output plughw:0,0 --lead-ms 300 --voice-scale 1.4 767
  dtmf-send --output plughw:0,0 --tone-ms 500 --spacing-ms 500 "831 555 1234"
  dtmf-send --output plughw:0,0 --wav-out /tmp/test.wav --verbose 767
  dtmf-send --output plughw:0,0 --json 767

EXIT CODES:
  0  Success
  1  Invalid arguments or sequence
  2  Audio device error
  3  Playback error`);
}

function normalizeSequence(raw) {
  return raw.replace(/[\s\-\.]/g, "").toUpperCase();
}

function validateSequence(seq) {
  if (!seq || seq.length === 0) return "Empty sequence";
  if (seq.length > 32) return "Sequence too long (max 32 digits)";
  for (const ch of seq) {
    if (!(ch in DTMF)) return `Invalid DTMF digit: '${ch}'`;
  }
  return null;
}

function generateTone(freq1, freq2, durationMs, amplitude, sampleRate) {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const val = amplitude * (Math.sin(2 * Math.PI * freq1 * t) + Math.sin(2 * Math.PI * freq2 * t)) / 2;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(val * 32767))), i * 2);
  }
  return buf;
}

function generateSilence(durationMs, sampleRate) {
  return Buffer.alloc(Math.floor(sampleRate * durationMs / 1000) * 2);
}

function generateDtmfAudio(sequence, args) {
  const amp = Math.max(0, Math.min(1, args.amplitude * args.voiceScale));
  const buffers = [];
  const details = [];

  if (args.leadMs > 0) {
    buffers.push(generateSilence(args.leadMs, args.sampleRate));
    details.push({ type: "lead", durationMs: args.leadMs });
  }

  for (let i = 0; i < sequence.length; i++) {
    const digit = sequence[i];
    const [f1, f2] = DTMF[digit];
    buffers.push(generateTone(f1, f2, args.toneMs, amp, args.sampleRate));
    details.push({ type: "tone", digit, freq1: f1, freq2: f2, durationMs: args.toneMs });

    if (i < sequence.length - 1 && args.spacingMs > 0) {
      buffers.push(generateSilence(args.spacingMs, args.sampleRate));
      details.push({ type: "spacing", durationMs: args.spacingMs });
    }
  }

  const pcm = Buffer.concat(buffers);
  const totalMs = details.reduce((sum, d) => sum + d.durationMs, 0);
  return { pcm, details, totalMs, amplitude: amp };
}

function writeWav(path, pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);   // PCM
  header.writeUInt16LE(1, 22);   // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);   // block align
  header.writeUInt16LE(16, 34);  // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

function playPcm(pcm, device, sampleRate) {
  return new Promise((resolve, reject) => {
    const proc = spawn("aplay", [
      "-D", device, "-f", "S16_LE", "-r", String(sampleRate), "-c", "1", "-t", "raw",
    ]);
    proc.on("error", (err) => reject(new Error(`Audio device error: ${err.message}`)));
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`aplay exited with code ${code}`));
    });
    proc.stdin.write(pcm);
    proc.stdin.end();
  });
}

function output(args, result) {
  if (args.json) {
    console.log(JSON.stringify(result));
  } else if (args.verbose) {
    console.log(`DTMF sequence: ${result.sequence.split("").join(" ")}`);
    for (const d of result.details) {
      if (d.type === "lead") console.log(`  Lead silence: ${d.durationMs}ms`);
      else if (d.type === "tone") console.log(`  Tone ${d.digit}: ${d.freq1}Hz + ${d.freq2}Hz, ${d.durationMs}ms`);
      else if (d.type === "spacing") console.log(`  Spacing: ${d.durationMs}ms`);
    }
    console.log(`Output: ${result.device} @ ${result.sampleRate}Hz 16-bit mono`);
    console.log(`Amplitude: ${args.amplitude} × ${args.voiceScale} voice-scale = ${result.amplitude.toFixed(3)}`);
    console.log(`Total duration: ${result.totalMs}ms`);
    console.log(result.message);
  } else {
    console.log(result.message);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.sequence) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const sequence = normalizeSequence(args.sequence);

  // Validate sequence
  const err = validateSequence(sequence);
  if (err) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: err }));
    else console.error(`ERROR: ${err}`);
    process.exit(1);
  }

  // Emergency gate
  if (EMERGENCY_PATTERN.test(sequence) && !args.allowEmergency) {
    const msg = "Sequence contains emergency code (911). Use --allow-emergency to override.";
    if (args.json) console.log(JSON.stringify({ ok: false, error: msg, blocked: true }));
    else console.error(`ERROR: ${msg}`);
    process.exit(1);
  }

  if (!args.output && !args.tx && !args.dryRun && !args.wavOut) {
    console.error("ERROR: --output or --tx is required (or use --dry-run / --wav-out)");
    process.exit(1);
  }

  // Generate audio
  const { pcm, details, totalMs, amplitude } = generateDtmfAudio(sequence, args);
  const toneCount = details.filter(d => d.type === "tone").length;

  const result = {
    ok: true,
    sequence,
    tones: toneCount,
    totalMs,
    amplitude,
    sampleRate: args.sampleRate,
    device: args.output || "(none)",
    details,
    message: `DTMF ${sequence} sent (${toneCount} tones, ${totalMs}ms total)`,
  };

  // Dry run
  if (args.dryRun) {
    result.message = `DTMF ${sequence} validated (${toneCount} tones, ${totalMs}ms total, dry run)`;
    output(args, result);
    process.exit(0);
  }

  // WAV output
  if (args.wavOut) {
    writeWav(args.wavOut, pcm, args.sampleRate);
    result.message = `DTMF ${sequence} written to ${args.wavOut} (${toneCount} tones, ${totalMs}ms total)`;
    output(args, result);
    if (!args.output) process.exit(0);
  }

  // Transmit via DigiRig runtime API (handles PTT)
  if (args.tx) {
    try {
      // If --say is provided, speak the ack first via /tx/text. This POST
      // blocks until the voice has fully played out (FIFO queue in the
      // runtime), guaranteeing voice-before-tones ordering.
      if (args.say) {
        const textUrl = args.txUrl.replace(/\/tx\/raw$/, "/tx/text");
        const sayRes = await fetch(textUrl, {
          method: "POST",
          body: args.say,
          headers: { "Content-Type": "text/plain" },
        });
        const sayBody = await sayRes.json();
        if (!sayBody.ok) {
          if (args.json) console.log(JSON.stringify({ ok: false, error: `--say failed: ${sayBody.error}` }));
          else console.error(`ERROR: --say failed: ${sayBody.error}`);
          process.exit(3);
        }
      }
      const url = `${args.txUrl}?sampleRate=${args.sampleRate}`;
      const res = await fetch(url, {
        method: "POST",
        body: pcm,
        headers: { "Content-Type": "application/octet-stream" },
      });
      const body = await res.json();
      if (!body.ok) {
        if (args.json) console.log(JSON.stringify({ ok: false, error: body.error }));
        else console.error(`ERROR: ${body.error}`);
        process.exit(3);
      }
      if (args.say) result.message = `Spoke ack + ${result.message}`;
      output(args, result);
    } catch (e) {
      if (args.json) console.log(JSON.stringify({ ok: false, error: e.message }));
      else console.error(`ERROR: TX API failed: ${e.message}`);
      process.exit(2);
    }
    process.exit(0);
  }

  // Play directly to audio device (no PTT management)
  if (!args.output) {
    console.error("ERROR: --output is required when not using --tx");
    process.exit(1);
  }
  try {
    await playPcm(pcm, args.output, args.sampleRate);
    output(args, result);
  } catch (e) {
    const isDeviceError = e.message.includes("device") || e.message.includes("aplay");
    const code = isDeviceError ? 2 : 3;
    if (args.json) console.log(JSON.stringify({ ok: false, error: e.message }));
    else console.error(`ERROR: ${e.message}`);
    process.exit(code);
  }
}

main();
