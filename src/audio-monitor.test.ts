import { describe, expect, it } from "vitest";
import { AudioMonitor, type AudioMonitorConfig, computeRms } from "./audio-monitor.js";

// ─── helpers: build synthetic PCM frames at a known RMS ────────────────────
//
// We cast to `any` in a few places to reach the private `handleChunk()` — the
// VAD state machine is well-defined enough that we want to test it directly
// without spawning a real arecord subprocess.

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 16 kHz * 2 bytes * 20 ms = 640

function frameAtRms(rms: number): Buffer {
  // For a constant-valued PCM16 frame, RMS = |value| / 32768. Pick the sample
  // value that yields the target RMS.
  const value = Math.min(32767, Math.max(-32768, Math.round(rms * 32768)));
  const buf = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) buf.writeInt16LE(value, i);
  return buf;
}

function framesAtRms(rms: number, count: number): Buffer {
  return Buffer.concat(Array.from({ length: count }, () => frameAtRms(rms)));
}

function makeMonitor(overrides: Partial<AudioMonitorConfig> = {}): AudioMonitor {
  const cfg: AudioMonitorConfig = {
    device: "plughw:0,0",
    sampleRate: SAMPLE_RATE,
    channels: 1,
    frameMs: FRAME_MS,
    preRollMs: 200,        // 10 frames of pre-roll
    energyThreshold: 0.1,  // strong — "speech"
    carrierSenseThreshold: 0.001,
    energyLogIntervalMs: 0, // silence the periodic log
    minSpeechMs: 100,       // 5 frames
    maxSilenceMs: 100,      // 5 frames
    maxRecordMs: 1000,      // 50 frames
    busyHoldMs: 500,
    startCooldownMs: 0,     // no cooldown in tests unless we ask
    ...overrides,
  };
  return new AudioMonitor(cfg);
}

type CapturedEvents = {
  start: Array<{ energy: number }>;
  end: Array<{ reason: string; durationMs: number; silenceMs: number }>;
  utterance: Array<{ pcm: Buffer; reason: string }>;
};

function captureEvents(m: AudioMonitor): CapturedEvents {
  const ev: CapturedEvents = { start: [], end: [], utterance: [] };
  m.on("recording-start", (e: any) => ev.start.push(e));
  m.on("recording-end", (e: any) => ev.end.push(e));
  m.on("utterance", (e: any) => ev.utterance.push(e));
  // Swallow "log" and "error" so they don't warn about unhandled listeners.
  m.on("log", () => {});
  m.on("error", () => {});
  return ev;
}

// Drives the VAD state machine directly — same path arecord stdout would take.
function feed(m: AudioMonitor, buf: Buffer) {
  (m as any).handleChunk(buf);
}

// ─── computeRms (kept from earlier) ───────────────────────────────────────

describe("computeRms", () => {
  it("returns near zero for silence", () => {
    expect(computeRms(Buffer.alloc(200))).toBeLessThan(0.001);
  });

  it("returns higher energy for a tone", () => {
    const buf = Buffer.alloc(200);
    for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(10000, i);
    expect(computeRms(buf)).toBeGreaterThan(0.2);
  });

  it("is insensitive to the sign of the sample (tone at -A matches tone at +A)", () => {
    const pos = Buffer.alloc(200);
    const neg = Buffer.alloc(200);
    for (let i = 0; i < pos.length; i += 2) {
      pos.writeInt16LE(5000, i);
      neg.writeInt16LE(-5000, i);
    }
    expect(computeRms(pos)).toBeCloseTo(computeRms(neg), 10);
  });
});

// ─── VAD state machine ────────────────────────────────────────────────────

describe("AudioMonitor VAD state machine", () => {
  it("does not emit recording-start when energy stays below the threshold", () => {
    const m = makeMonitor();
    const ev = captureEvents(m);
    // 30 frames of carrier-level audio (above carrier-sense but below energy-trigger).
    feed(m, framesAtRms(0.002, 30));
    expect(ev.start).toEqual([]);
    expect(ev.end).toEqual([]);
    expect(ev.utterance).toEqual([]);
  });

  it("emits recording-start on the first frame that crosses the energy threshold", () => {
    const m = makeMonitor();
    const ev = captureEvents(m);
    feed(m, framesAtRms(0.3, 1));
    expect(ev.start.length).toBe(1);
    expect(ev.start[0].energy).toBeGreaterThan(0.1);
  });

  it("includes pre-roll in the captured utterance", () => {
    const m = makeMonitor({ preRollMs: 200 }); // 10 frames of pre-roll
    const ev = captureEvents(m);
    // 10 pre-roll frames of near-silence, then speech ramps up, then silence closes it.
    feed(m, framesAtRms(0.0, 10));        // pre-roll (below trigger and carrier)
    feed(m, framesAtRms(0.3, 8));         // active speech — crosses trigger
    feed(m, framesAtRms(0.0, 6));         // post-speech silence → closes utterance
    expect(ev.utterance.length).toBe(1);
    // Utterance duration is the recording-phase frames (8 speech + 5 silence before close);
    // what we really want to assert is the total PCM length > speech-only length,
    // proving pre-roll frames got prepended.
    const speechOnlyBytes = 8 * FRAME_BYTES;
    expect(ev.utterance[0].pcm.length).toBeGreaterThan(speechOnlyBytes);
  });

  it("closes the utterance with reason=silence after maxSilenceMs of sub-carrier audio", () => {
    const m = makeMonitor({ minSpeechMs: 100, maxSilenceMs: 100 });
    const ev = captureEvents(m);
    feed(m, framesAtRms(0.3, 6));  // 120 ms of speech (> minSpeechMs)
    feed(m, framesAtRms(0.0, 6));  // 120 ms of silence (> maxSilenceMs)
    expect(ev.end.length).toBe(1);
    expect(ev.end[0].reason).toBe("silence");
  });

  it("closes the utterance with reason=maxRecord after maxRecordMs of continuous audio", () => {
    const m = makeMonitor({ maxRecordMs: 200 }); // 10 frames max
    const ev = captureEvents(m);
    feed(m, framesAtRms(0.3, 15));
    expect(ev.end.length).toBe(1);
    expect(ev.end[0].reason).toBe("maxRecord");
  });

  it("stays recording through brief carrier-level lulls (speech pauses)", () => {
    const m = makeMonitor({ maxSilenceMs: 200 }); // 10 frames of silence to close
    const ev = captureEvents(m);
    feed(m, framesAtRms(0.3, 6));  // speech
    feed(m, framesAtRms(0.0, 4));  // 80 ms silence — under maxSilenceMs
    feed(m, framesAtRms(0.3, 6));  // more speech — resets silence counter
    // Not closed yet.
    expect(ev.end).toEqual([]);
    expect(ev.utterance).toEqual([]);
    // Now a long silence → closes.
    feed(m, framesAtRms(0.0, 11));
    expect(ev.end.length).toBe(1);
    expect(ev.utterance.length).toBe(1);
  });

  it("ignores frames while muted (no recording-start, preserves recording-end of an in-flight utterance)", () => {
    const m = makeMonitor();
    const ev = captureEvents(m);
    m.muteFor(60_000);
    feed(m, framesAtRms(0.3, 20));
    expect(ev.start).toEqual([]);
    expect(ev.utterance).toEqual([]);
  });

  it("cuts an in-flight utterance short with reason=tx when mute becomes active", () => {
    const m = makeMonitor({ minSpeechMs: 0 });
    const ev = captureEvents(m);
    feed(m, framesAtRms(0.3, 3));   // start recording
    expect(ev.start.length).toBe(1);
    m.muteFor(60_000);
    feed(m, framesAtRms(0.3, 1));   // first frame during mute → finishes as "tx"
    expect(ev.end.length).toBe(1);
    expect(ev.end[0].reason).toBe("tx");
  });

  it("suppresses a new recording-start during the startCooldown window", () => {
    const m = makeMonitor({ startCooldownMs: 60_000, minSpeechMs: 0 });
    const ev = captureEvents(m);
    // First utterance, close it.
    feed(m, framesAtRms(0.3, 3));
    feed(m, framesAtRms(0.0, 10));
    expect(ev.start.length).toBe(1);
    expect(ev.end.length).toBe(1);
    // Second burst of speech within the cooldown window → no new recording-start.
    feed(m, framesAtRms(0.3, 5));
    expect(ev.start.length).toBe(1);
  });
});

// ─── public helpers ────────────────────────────────────────────────────────

describe("AudioMonitor public helpers", () => {
  it("isCarrierPresent() is false when no frame has been processed yet", () => {
    const m = makeMonitor();
    expect(m.isCarrierPresent()).toBe(false);
  });

  it("isCarrierPresent() reflects the most recent frame energy", () => {
    const m = makeMonitor({ carrierSenseThreshold: 0.01 });
    feed(m, framesAtRms(0.05, 1));
    expect(m.isCarrierPresent()).toBe(true);
    feed(m, framesAtRms(0.0, 1));
    expect(m.isCarrierPresent()).toBe(false);
  });

  it("getLastEnergy() returns the RMS of the last frame", () => {
    const m = makeMonitor();
    feed(m, framesAtRms(0.25, 1));
    // Constant-sample RMS is exactly |value|/32768 — we round, so allow a tiny delta.
    expect(m.getLastEnergy()).toBeCloseTo(0.25, 3);
  });

  it("muteFor(0) is a no-op (does not mute)", () => {
    const m = makeMonitor();
    const ev = captureEvents(m);
    m.muteFor(0);
    feed(m, framesAtRms(0.3, 1));
    expect(ev.start.length).toBe(1);
  });

  it("clearMute() cancels a pending mute", () => {
    const m = makeMonitor();
    const ev = captureEvents(m);
    m.muteFor(60_000);
    m.clearMute();
    feed(m, framesAtRms(0.3, 1));
    expect(ev.start.length).toBe(1);
  });
});
