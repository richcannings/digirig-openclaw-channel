import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ChannelGatewayStartContext } from "openclaw/plugin-sdk";
import { createRadioContextPayload, dispatchRadioReply, recordInboundSession } from "./channel-core.js";
import { getDigirigRuntime } from "./state.js";
import type { DigirigConfig } from "./config.js";
import { AudioMonitor } from "./audio-monitor.js";
import { PttController } from "./ptt.js";
import { WhisperLiveClient } from "./stt-ws.js";
import { playPcm, synthesizeTts } from "./tts.js";

export function appendCallsign(text: string, callsign?: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (!callsign || !callsign.trim()) {
    return trimmed;
  }
  if (trimmed.toUpperCase().includes(callsign.toUpperCase())) {
    return trimmed;
  }
  return `${trimmed} ${callsign}`;
}

function parseAliases(input?: string): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isDirectCall(text: string, callsign?: string, aliases: string[] = []): boolean {
  const upper = text.toUpperCase();
  const needles = [callsign, ...aliases].filter(Boolean) as string[];
  if (!needles.length) return false;
  const textBare = upper.replace(/[^A-Z0-9]/g, "");
  return needles.some((needle) => {
    const call = needle.toUpperCase();
    if (upper.includes(call)) return true;
    const callBare = call.replace(/[^A-Z0-9]/g, "");
    return callBare.length > 0 && textBare.includes(callBare);
  });
}


export type DigirigCalibrationResult = {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  samples: number;
  rms: number;
  peak: number;
  rmsDb: number;
  peakDb: number;
};

export type DigirigRuntime = {
  start: (ctx: ChannelGatewayStartContext<DigirigConfig>) => Promise<{ stop: () => void }>;
  stop: () => Promise<void>;
  speak: (text: string) => Promise<void>;
  startCalibration: (durationMs?: number) => void;
  getCalibrationStatus: () => "idle" | "running" | "done";
  getCalibrationResult: () => DigirigCalibrationResult | null;
};

function formatRadioReply(text: string, maxChars = 140): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "";
  }
  const sentenceMatch = trimmed.match(/^(.+?[\.!\?])(\s|$)/);
  const base = sentenceMatch ? sentenceMatch[1] : trimmed;
  return base.slice(0, maxChars).trim();
}

function normalizeSttText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "[blank_audio]" || lower === "(blank audio)") return "";
  if (/\bbeep\b/i.test(trimmed)) return "";
  if (/^\s*[\[(].*[\])]\s*$/.test(trimmed)) return "";

  // Drop stray 1–3 character prefix fragments (e.g., "GC.") when followed by a sentence.
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 1 && tokens[0].length <= 3) {
    const remainder = tokens.slice(1).join(" ");
    if (remainder.length >= 12) {
      return remainder.trim();
    }
  }
  return trimmed;
}

export async function createDigirigRuntime(config: DigirigConfig): Promise<DigirigRuntime> {
  const runtime = getDigirigRuntime();
  const audioMonitor = new AudioMonitor({
    device: config.audio.inputDevice,
    sampleRate: config.audio.sampleRate,
    channels: 1,
    frameMs: config.rx.frameMs,
    preRollMs: config.rx.preRollMs,
    energyThreshold: config.rx.energyThreshold,
    energyLogIntervalMs: config.rx.energyLogIntervalMs,
    minSpeechMs: config.rx.minSpeechMs,
    maxSilenceMs: config.rx.maxSilenceMs,
    maxRecordMs: config.rx.maxRecordMs,
    busyHoldMs: config.rx.busyHoldMs,
    startCooldownMs: config.rx.startCooldownMs,
  });

  const ptt = new PttController({
    device: config.ptt.device,
    rts: config.ptt.rts,
    leadMs: config.ptt.leadMs,
    tailMs: config.ptt.tailMs,
  });

  let hardStopped = false;
  let started = false;
  let outboundQueue: Promise<void> = Promise.resolve();
  const logDir = join(homedir(), ".openclaw", "logs");
  const logDate = new Date().toISOString().slice(0, 10);
  const logPath = join(logDir, `digirig-${logDate}.log`);
  let logger: ChannelGatewayStartContext<DigirigConfig>["log"] | null = null;

  let wsClient: WhisperLiveClient | null = null;

  let calibration:
    | null
    | {
        status: "idle" | "running" | "done";
        startedAt: number;
        durationMs: number;
        samples: number;
        sumSquares: number;
        peak: number;
        timer: NodeJS.Timeout | null;
        result: DigirigCalibrationResult | null;
      } = {
    status: "idle",
    startedAt: 0,
    durationMs: 0,
    samples: 0,
    sumSquares: 0,
    peak: 0,
    timer: null,
    result: null,
  };

  const appendTranscript = async (line: string) => {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logPath, `${line}\n`);
  };


  let rxBuffer: string[] = [];
  let rxStartAt = 0;
  let rxFinalizeTimer: NodeJS.Timeout | null = null;
  let rxFinalized = false;
  let rxSessionId = 0;
  let lastRxEndAt = 0;
  let lastRxEndReason: string | null = null;
  let rxChunks: string[] = [];

  const logTranscript = async (speaker: "RX" | "TX", text: string) => {
    if (!text.trim()) return;
    const ts = new Date().toISOString();
    await appendTranscript(`[${ts}] ${speaker}: ${text.trim()}`);
  };

  const formatDb = (value: number) => {
    if (!Number.isFinite(value)) return "-inf";
    return `${value.toFixed(1)} dB`;
  };

  const finalizeCalibration = async () => {
    if (!calibration || calibration.status !== "running") return;
    const endedAt = Date.now();
    const { samples, sumSquares, peak, startedAt, durationMs } = calibration;
    const rms = samples ? Math.sqrt(sumSquares / samples) : 0;
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
    const result: DigirigCalibrationResult = {
      startedAt,
      endedAt,
      durationMs,
      samples,
      rms,
      peak,
      rmsDb,
      peakDb,
    };
    calibration.status = "done";
    calibration.result = result;
    calibration.timer = null;
    const ts = new Date().toISOString();
    await appendTranscript(
      `[${ts}] CALIBRATE: rms=${formatDb(rmsDb)} peak=${formatDb(peakDb)} samples=${samples}`,
    );
  };

  const startCalibration = (durationMs = 8000) => {
    if (!calibration) return;
    if (calibration.timer) {
      clearTimeout(calibration.timer);
      calibration.timer = null;
    }
    calibration.status = "running";
    calibration.startedAt = Date.now();
    calibration.durationMs = durationMs;
    calibration.samples = 0;
    calibration.sumSquares = 0;
    calibration.peak = 0;
    calibration.result = null;
    calibration.timer = setTimeout(() => {
      void finalizeCalibration();
    }, durationMs);
  };

  const speak = async (text: string) => {
    if (!text.trim()) {
      return;
    }
    if (!config.ptt.rts) {
      return;
    }
    const captureMute = getCaptureMuteConfig(config.audio.inputDevice);
    const safeSetCaptureMute = async (muted: boolean) => {
      if (!captureMute) return;
      try {
        await setCaptureMute(captureMute, muted);
      } catch (err) {
        logger?.error?.(
          `[digirig] capture mute ${muted ? "on" : "off"} failed: ${String(err)}`,
        );
      }
    };

    outboundQueue = outboundQueue.then(async () => {
      const trimmed = text.trim();
      await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 60000);
      await ptt.withTx(async () => {
        const tts = await synthesizeTts(runtime, text);
        const bytesPerMs = tts.sampleRate * 2 / 1000;
        const audioMs = bytesPerMs > 0 ? Math.ceil(tts.audioBuffer.length / bytesPerMs) : 0;
        const muteMs = Math.max(0, config.ptt.leadMs + config.ptt.tailMs + audioMs + 200);
        audioMonitor.muteFor(muteMs);
        await safeSetCaptureMute(true);
        try {
          await playPcm({
            device: config.audio.outputDevice,
            sampleRate: tts.sampleRate,
            channels: 1,
            pcm: tts.audioBuffer,
          });
        } finally {
          await safeSetCaptureMute(false);
        }
      });
      await logTranscript("TX", trimmed);
    });
    await outboundQueue;
  };

  const start = async (ctx: ChannelGatewayStartContext<DigirigConfig>) => {
    if (hardStopped || started) {
      return { stop: () => {} };
    }
    started = true;
    logger = ctx.log ?? null;

    const updateStatus = (patch: Partial<{
      running: boolean;
      connected: boolean;
      lastConnectedAt: number | null;
      lastDisconnect: { at: number; error?: string } | null;
      lastStartAt: number | null;
      lastStopAt: number | null;
      lastInboundAt: number | null;
      lastEventAt: number | null;
      lastError: string | null;
    }>) => {
      ctx.setStatus({
        ...ctx.getStatus(),
        accountId: ctx.accountId,
        ...patch,
      });
    };

    audioMonitor.on("log", (msg) => ctx.log?.debug?.(`[digirig] ${msg}`));
    audioMonitor.on("error", (err) => {
      ctx.log?.error?.(`[digirig] ${String(err)}`);
      updateStatus({ lastError: String(err) });
    });
    audioMonitor.on("recording-start", (evt) => {
      ctx.log?.info?.(`[digirig] RX start (energy=${evt?.energy?.toFixed?.(4) ?? '?'})`);
      updateStatus({ lastEventAt: Date.now() });
    });
    // lastRxEndAt is tracked at the runtime scope
    let sttInFlight = false;
    const wsUrl = (config.stt.wsUrl ?? "").trim();
    const frameBytes = Math.floor(
      (config.audio.sampleRate * 1 * 2 * config.rx.frameMs) / 1000,
    );

    const scheduleFinalizeRx = () => {
      const sessionId = rxSessionId;
      if (rxFinalizeTimer) {
        clearTimeout(rxFinalizeTimer);
      }
      rxFinalizeTimer = setTimeout(() => {
        rxFinalizeTimer = null;
        if (!rxFinalized && sessionId === rxSessionId) {
          void finalizeRx();
        }
      }, 200);
    };

    const finalizeRx = async () => {
      if (rxFinalized) return;
      if (sttInFlight) {
        ctx.log?.info?.(`[digirig] finalizeRx delayed; STT in flight session=${rxSessionId}`);
        scheduleFinalizeRx();
        return;
      }
      ctx.log?.info?.(`[digirig] finalizeRx session=${rxSessionId} reason=${lastRxEndReason ?? 'unknown'} bufferChunks=${rxBuffer.length} rxChunks=${rxChunks.length} `);
      const chunkText = normalizeSttText(rxBuffer.join(" "));
      if (!chunkText) {
        rxBuffer = [];
        if (rxChunks.length === 0) rxStartAt = 0;
        return;
      }

      if (lastRxEndReason === "maxRecord") {
        if (chunkText) {
          rxChunks.push(chunkText);
        }
        rxBuffer = [];
        rxFinalized = true;
        return;
      }

      const text = normalizeSttText([...rxChunks, chunkText].join(" "));
      rxChunks = [];
      await logTranscript("RX", text);
      if (!text.trim()) {
        rxBuffer = [];
        rxStartAt = 0;
        rxFinalized = true;
        return;
      }
      updateStatus({ lastInboundAt: Date.now() });

      const cfg = runtime.config.loadConfig();
      const routeStartAt = Date.now();
      const route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: "digirig",
        accountId: "default",
        peer: {
          kind: "direct",
          id: "radio",
        },
      });
      const routeEndAt = Date.now();

      const policy = config.tx.policy ?? "direct-only";
      const aliasList = parseAliases(config.tx.aliases);
      const direct = isDirectCall(text, config.tx.callsign, aliasList);
      ctx.log?.info?.(
        `[digirig] finalize routing: direct=${direct} policy=${policy} aliases=${aliasList.join(",")} routeSession=${route.sessionKey ?? "?"}`,
      );
      if (policy === "direct-only" && !direct) {
        rxBuffer = [];
        rxStartAt = 0;
        rxFinalized = true;
        return;
      }

      const radioPrompt = "Radio mode: respond briefly for on-air voice. Do not mention policy, tools, or refusal; just answer or acknowledge.";
      const ctxPayload = createRadioContextPayload(runtime, cfg, route, text, radioPrompt);

      await recordInboundSession(runtime, cfg, route, ctxPayload, ctx.log);

      const dispatchStartAt = Date.now();
      const rxEndAtSnapshot = lastRxEndAt;
      let firstTxAt = 0;
      let speakMs = 0;
      let didSpeak = false;
      ctx.log?.info?.(`[digirig] dispatch reply start session=${rxSessionId} direct=${direct} routeSession=${route.sessionKey ?? "?"}`);
      const dispatchResult = await dispatchRadioReply({
        runtime,
        cfg,
        route,
        ctxPayload,
        log: ctx.log,
        deliver: async (payload) => {
          if (!payload.text) {
            return;
          }
          if (ctxPayload.OriginatingChannel !== "digirig" || ctxPayload.SessionKey !== "digirig:radio") {
            ctx.log?.info?.("[digirig] deliver suppressed (non-radio session)");
            return;
          }
          const shortReply = formatRadioReply(payload.text);
          if (!shortReply) {
            return;
          }
          const txText = appendCallsign(shortReply, config.tx.callsign);
          ctx.log?.info?.(`[digirig] reply deliver: ${txText}`);
          didSpeak = true;
          if (!firstTxAt) {
            firstTxAt = Date.now();
          }
          const speakStartAt = Date.now();
          await speak(txText);
          speakMs = Date.now() - speakStartAt;
        },
      });
      const dispatchEndAt = Date.now();
      const counts = dispatchResult?.counts ?? {};
      const lastReplyLen = dispatchResult?.finalText?.length ?? 0;
      ctx.log?.info?.(`[digirig] dispatch result counts=${JSON.stringify(counts)} finalLen=${lastReplyLen}`);
      const rxEndAt = rxEndAtSnapshot || null;
      const responseTimeMs = firstTxAt && rxEndAt ? Math.max(0, firstTxAt - rxEndAt) : null;
      const timing = {
        rxToSttStartMs: null,
        sttMs: null,
        routeMs: routeEndAt - routeStartAt,
        dispatchMs: dispatchEndAt - dispatchStartAt,
        rxToFirstTxMs: firstTxAt && rxEndAt ? Math.max(0, firstTxAt - rxEndAt) : null,
        responseTimeMs,
        speakMs: speakMs || null,
        totalRxToDoneMs: rxEndAt ? dispatchEndAt - rxEndAt : null,
        totalUtteranceToDoneMs: rxStartAt ? dispatchEndAt - rxStartAt : null,
      };
      ctx.log?.info?.(
        `[digirig] dispatch reply complete (counts=${JSON.stringify(counts)} timing=${JSON.stringify(timing)})`,
      );
      if (responseTimeMs !== null) {
        ctx.log?.info?.(`[digirig] responseTimeMs=${responseTimeMs}`);
      }
      rxBuffer = [];
      rxStartAt = 0;
      rxFinalized = true;
    };

    audioMonitor.on("recording-end", (evt) => {
      lastRxEndAt = Date.now();
      const reason = evt?.reason ?? "?";
      lastRxEndReason = reason;
      const silenceMs = evt?.silenceMs ?? "?";
      ctx.log?.info?.(`[digirig] RX end (session=${rxSessionId}, durationMs=${evt?.durationMs ?? '?'}, silenceMs=${silenceMs}, reason=${reason})`);
      if (wsClient) {
        wsClient.end();
      }
      if (reason === "maxRecord") {
        void finalizeRx();
        return;
      }
      scheduleFinalizeRx();
    });

    audioMonitor.on("recording-frame", (frame: Buffer) => {
      if (!frameBytes || frame.length !== frameBytes) return;
      if (calibration && calibration.status === "running") {
        const sampleCount = Math.floor(frame.length / 2);
        for (let i = 0; i < sampleCount; i += 1) {
          const sample = frame.readInt16LE(i * 2) / 32768;
          const abs = Math.abs(sample);
          calibration.sumSquares += sample * sample;
          if (abs > calibration.peak) calibration.peak = abs;
          calibration.samples += 1;
        }
      }
      if (wsClient) {
        wsClient.sendAudio(frame);
      }
    });

    audioMonitor.on("recording-start", () => {
      rxFinalized = false;
      rxSessionId += 1;
      ctx.log?.info?.(`[digirig] RX session start id=${rxSessionId}`);
      if (rxFinalizeTimer) {
        clearTimeout(rxFinalizeTimer);
        rxFinalizeTimer = null;
      }
      if (!rxBuffer.length && rxChunks.length === 0) {
        rxStartAt = Date.now();
      }
      if (!wsUrl) {
        ctx.log?.error?.("[digirig] stt.wsUrl is required for WS-only mode");
        return;
      }
      if (!wsClient) {
        wsClient = new WhisperLiveClient(
          {
            url: wsUrl,
            model: "Systran/faster-whisper-medium.en",
            task: "transcribe",
            useVad: false,
            sendLastNSegments: 10,
          },
          ctx.log,
        );
      }
      void wsClient.connect().catch((err) =>
        ctx.log?.error?.(`[digirig] WhisperLive connect failed: ${String(err)}`),
      );
      wsClient.reset();
    });

    audioMonitor.on("utterance", async (_utterance) => {
      if (rxFinalized) {
        return;
      }
      if (!wsClient) {
        ctx.log?.warn?.("[digirig] STT skipped: WS client not ready");
        return;
      }
      sttInFlight = true;
      try {
        const rxEndAt = lastRxEndAt || Date.now();
        const sttStartAt = Date.now();
        ctx.log?.info?.(
          `[digirig] STT start (rxToSttStartMs=${sttStartAt - rxEndAt})`,
        );
        await wsClient.waitForIdle(1200);
        const text = normalizeSttText(wsClient.getText() || "");
        ctx.log?.info?.(`[digirig] STT: ${text || "(empty)"}`);
        if (!text.trim()) {
          return;
        }
        const normalizedRx = normalizeSttText(text);
        if (!normalizedRx) {
          return;
        }

        const lastFragment = rxBuffer[rxBuffer.length - 1];
        if (lastFragment) {
          const lowerLast = lastFragment.toLowerCase();
          const lowerText = normalizedRx.toLowerCase();
          if (
            lowerText === lowerLast ||
            lowerLast.endsWith(lowerText) ||
            lowerText.endsWith(lowerLast)
          ) {
            return;
          }
        }

        rxBuffer.push(normalizedRx);
        return;
      } catch (err) {
        ctx.log?.error?.(`[digirig] inbound error: ${String(err)}`);
      } finally {
        sttInFlight = false;
      }
    });

    audioMonitor.start();
    updateStatus({
      running: true,
      connected: true,
      lastConnectedAt: Date.now(),
      lastStartAt: Date.now(),
      lastError: null,
    });

    return {
      stop: () => {
        started = false;
        audioMonitor.stop();
        updateStatus({
          running: false,
          connected: false,
          lastStopAt: Date.now(),
        });
      },
    };
  };

  const stop = async () => {
    hardStopped = true;
    started = false;
    audioMonitor.stop();
    wsClient?.close();
    await ptt.close();
  };

  const getCalibrationStatus = () => calibration?.status ?? "idle";
  const getCalibrationResult = () => calibration?.result ?? null;

  return { start, stop, speak, startCalibration, getCalibrationStatus, getCalibrationResult };
}

type CaptureMuteConfig = {
  card: number;
  control: string;
};

function parseAlsaCard(device: string): number | null {
  const match = device.match(/(?:plughw|hw):(\d+),/);
  if (!match) return null;
  const card = Number(match[1]);
  return Number.isFinite(card) ? card : null;
}

function getCaptureMuteConfig(device: string): CaptureMuteConfig | null {
  const card = parseAlsaCard(device);
  if (card === null) return null;
  return { card, control: "Mic" };
}

async function setCaptureMute(cfg: CaptureMuteConfig, muted: boolean): Promise<void> {
  const args = ["-c", String(cfg.card), "set", cfg.control, muted ? "nocap" : "cap"];
  await runCommand("amixer", args);
}

async function runCommand(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const details = stderr.trim();
        reject(new Error(`${cmd} ${args.join(" ")} exited ${code ?? "?"}${details ? `: ${details}` : ""}`));
      }
    });
  });
}

async function waitForClearChannel(
  monitor: AudioMonitor,
  busyHoldMs: number,
  maxWaitMs: number,
): Promise<void> {
  const start = Date.now();
  while (monitor.getBusy()) {
    if (Date.now() - start > maxWaitMs) {
      return;
    }
    await delay(Math.max(50, busyHoldMs / 4));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
