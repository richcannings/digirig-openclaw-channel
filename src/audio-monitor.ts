import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export type AudioMonitorConfig = {
  device: string;
  sampleRate: number;
  channels: number;
  frameMs: number;
  preRollMs: number;
  energyThreshold: number;
  energyLogIntervalMs: number;
  minSpeechMs: number;
  maxSilenceMs: number;
  maxRecordMs: number;
  busyHoldMs: number;
  startCooldownMs: number;
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
  private mutedUntil = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelayMs = 500;
  private utteranceBuffers: Buffer[] = [];
  private utteranceMs = 0;
  private silenceMs = 0;
  private lastActiveAt = 0;
  private lastFrameAt = 0;
  private lastEndAt = 0;
  private stallTimer: NodeJS.Timeout | null = null;
  private preRollFrames: Buffer[] = [];
  private preRollMaxFrames: number;
  private energyLogTimer: NodeJS.Timeout | null = null;
  private energyLogSamples = 0;
  private energyLogSum = 0;

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

    this.lastFrameAt = Date.now();
    this.startStallTimer();
    this.startEnergyLogTimer();

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

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.lastFrameAt = Date.now();
      this.handleChunk(chunk);
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.emit("log", chunk.toString());
    });
    this.proc.on("exit", (code) => {
      if (!this.stopped) {
        this.emit("error", new Error(`arecord exited with ${code ?? "unknown"}`));
        this.scheduleRestart();
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.clearRestartTimer();
    this.clearStallTimer();
    this.clearEnergyLogTimer();
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  getBusy(): boolean {
    return Date.now() - this.lastActiveAt < this.config.busyHoldMs;
  }

  muteFor(ms: number): void {
    this.mutedUntil = Math.max(this.mutedUntil, Date.now() + Math.max(0, ms));
  }

  private handleChunk(chunk: Buffer): void {
    const frameBytes = Math.floor(
      (this.config.sampleRate * this.config.channels * 2 * this.config.frameMs) / 1000,
    );

    for (let offset = 0; offset + frameBytes <= chunk.length; offset += frameBytes) {
      const frame = chunk.subarray(offset, offset + frameBytes);
      const energy = computeRms(frame);
      this.emit("energy", energy);
      if (this.config.energyLogIntervalMs > 0) {
        this.energyLogSamples += 1;
        this.energyLogSum += energy;
      }

      if (energy >= this.config.energyThreshold) {
        this.lastActiveAt = Date.now();
      }

      if (Date.now() < this.mutedUntil) {
        continue;
      }

      if (!this.recording) {
        this.storePreRoll(frame);
        if (energy >= this.config.energyThreshold) {
          if (Date.now() - this.lastEndAt < this.config.startCooldownMs) {
            continue;
          }
          this.recording = true;
          this.emit("recording-start", { energy, at: Date.now() });
          if (this.preRollFrames.length) {
            for (const preRoll of this.preRollFrames) {
              this.emit("recording-frame", preRoll);
            }
          }
          this.utteranceBuffers = this.preRollFrames.slice();
          this.preRollFrames = [];
          this.utteranceMs = 0;
          this.silenceMs = 0;
        }
      }

      if (this.recording) {
        this.emit("recording-frame", frame);
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
          const reason = recordExceeded ? "maxRecord" : "silence";
          this.finishUtterance(reason);
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

  private finishUtterance(reason: "silence" | "maxRecord"): void {
    const pcm = Buffer.concat(this.utteranceBuffers);
    this.recording = false;
    this.lastEndAt = Date.now();
    this.emit("recording-end", {
      durationMs: this.utteranceMs,
      silenceMs: this.silenceMs,
      reason,
      at: Date.now(),
    });
    this.utteranceBuffers = [];
    this.utteranceMs = 0;
    this.silenceMs = 0;

    if (pcm.length === 0) {
      return;
    }

    const rms = computeRms(pcm.subarray(0, Math.min(pcm.length, 32000)));
    if (rms < this.config.energyThreshold * 0.5) {
      this.emit("log", `discarded low-energy clip (rms=${rms.toFixed(4)})`);
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

  private startStallTimer(): void {
    if (this.stallTimer) {
      return;
    }
    const checkIntervalMs = Math.max(500, this.config.frameMs * 4);
    const stallThresholdMs = Math.max(2000, this.config.frameMs * 50);
    this.stallTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
      if (!this.proc) {
        return;
      }
      if (Date.now() - this.lastFrameAt > stallThresholdMs) {
        this.emit("error", new Error("arecord stalled"));
        this.scheduleRestart();
      }
    }, checkIntervalMs);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private startEnergyLogTimer(): void {
    if (this.energyLogTimer) {
      return;
    }
    if (!this.config.energyLogIntervalMs || this.config.energyLogIntervalMs <= 0) {
      return;
    }
    this.energyLogTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
      if (this.energyLogSamples === 0) {
        return;
      }
      const avg = this.energyLogSum / this.energyLogSamples;
      this.emit(
        "log",
        `energy avg=${avg.toFixed(4)} over ${this.energyLogSamples} frames (thr=${this.config.energyThreshold})`,
      );
      this.energyLogSamples = 0;
      this.energyLogSum = 0;
    }, this.config.energyLogIntervalMs);
  }

  private clearEnergyLogTimer(): void {
    if (this.energyLogTimer) {
      clearInterval(this.energyLogTimer);
      this.energyLogTimer = null;
    }
    this.energyLogSamples = 0;
    this.energyLogSum = 0;
  }

  private scheduleRestart(): void {
    if (this.stopped) {
      return;
    }
    if (this.restartTimer) {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restart();
    }, this.restartDelayMs);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private restart(): void {
    if (this.stopped) {
      return;
    }
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.clearStallTimer();
    this.clearEnergyLogTimer();
    this.start();
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
