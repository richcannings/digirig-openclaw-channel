import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export type AudioMonitorConfig = {
  device: string;
  sampleRate: number;
  channels: number;
  frameMs: number;
  preRollMs: number;
  energyThreshold: number;
  minSpeechMs: number;
  maxSilenceMs: number;
  maxRecordMs: number;
  busyHoldMs: number;
};

export type AudioUtterance = {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  startAt: number;
  endAt: number;
};

export class AudioMonitor extends EventEmitter {
  private config: AudioMonitorConfig;
  private proc: ReturnType<typeof spawn> | null = null;
  private stopped = false;
  private recording = false;
  private utteranceBuffers: Buffer[] = [];
  private utteranceMs = 0;
  private silenceMs = 0;
  private lastActiveAt = 0;
  private preRollFrames: Buffer[] = [];
  private preRollMaxFrames: number;

  constructor(config: AudioMonitorConfig) {
    super();
    this.config = config;
    const frameMs = Math.max(5, config.frameMs);
    this.preRollMaxFrames = Math.ceil(config.preRollMs / frameMs);
  }

  start(): void {
    if (this.proc) {
      return;
    }

    const args = [
      "-D",
      this.config.device,
      "-f",
      "S16_LE",
      "-r",
      String(this.config.sampleRate),
      "-c",
      String(this.config.channels),
      "-t",
      "raw",
    ];

    this.proc = spawn("arecord", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.emit("log", chunk.toString());
    });
    this.proc.on("exit", (code) => {
      if (!this.stopped) {
        this.emit("error", new Error(`arecord exited with ${code ?? "unknown"}`));
      }
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  getBusy(): boolean {
    return Date.now() - this.lastActiveAt < this.config.busyHoldMs;
  }

  private handleChunk(chunk: Buffer): void {
    const frameBytes = Math.floor(
      (this.config.sampleRate * this.config.channels * 2 * this.config.frameMs) / 1000,
    );

    for (let offset = 0; offset + frameBytes <= chunk.length; offset += frameBytes) {
      const frame = chunk.subarray(offset, offset + frameBytes);
      const energy = computeRms(frame);
      this.emit("energy", energy);

      if (energy >= this.config.energyThreshold) {
        this.lastActiveAt = Date.now();
      }

      if (!this.recording) {
        this.storePreRoll(frame);
        if (energy >= this.config.energyThreshold) {
          this.recording = true;
          this.emit("recording-start", { energy, at: Date.now() });
          this.utteranceBuffers = this.preRollFrames.slice();
          this.preRollFrames = [];
          this.utteranceMs = 0;
          this.silenceMs = 0;
        }
      }

      if (this.recording) {
        this.utteranceBuffers.push(frame);
        this.utteranceMs += this.config.frameMs;
        if (energy < this.config.energyThreshold) {
          this.silenceMs += this.config.frameMs;
        } else {
          this.silenceMs = 0;
        }

        const minSpeechMet = this.utteranceMs >= this.config.minSpeechMs;
        const silenceExceeded = this.silenceMs >= this.config.maxSilenceMs;
        const recordExceeded = this.utteranceMs >= this.config.maxRecordMs;

        if ((minSpeechMet && silenceExceeded) || recordExceeded) {
          this.finishUtterance();
        }
      }
    }
  }

  private storePreRoll(frame: Buffer): void {
    if (this.preRollMaxFrames <= 0) {
      return;
    }
    this.preRollFrames.push(frame);
    if (this.preRollFrames.length > this.preRollMaxFrames) {
      this.preRollFrames.shift();
    }
  }

  private finishUtterance(): void {
    const pcm = Buffer.concat(this.utteranceBuffers);
    this.recording = false;
    this.emit("recording-end", { durationMs: this.utteranceMs, at: Date.now() });
    this.utteranceBuffers = [];
    this.utteranceMs = 0;
    this.silenceMs = 0;

    if (pcm.length === 0) {
      return;
    }

    this.emit("utterance", {
      pcm,
      sampleRate: this.config.sampleRate,
      channels: this.config.channels,
      startAt: Date.now(),
      endAt: Date.now(),
    } as AudioUtterance);
  }
}

export function computeRms(frame: Buffer): number {
  if (frame.length < 2) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < frame.length; i += 2) {
    const sample = frame.readInt16LE(i) / 32768;
    sum += sample * sample;
  }
  const mean = sum / (frame.length / 2);
  return Math.sqrt(mean);
}
