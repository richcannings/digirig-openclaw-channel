import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelGatewayStartContext } from "openclaw/plugin-sdk";
import { createRadioContextPayload, dispatchRadioReply, recordInboundSession } from "./channel-core.js";
import { getDigirigRuntime } from "./state.js";
import type { DigirigConfig } from "./config.js";
import { AudioMonitor } from "./audio-monitor.js";
import { PttController } from "./ptt.js";
import { WhisperLiveTranscriber } from "./whisperlive-transcriber.js";
import type { Transcriber } from "./transcriber.js";
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
  start: (ctx: ChannelGatewayStartContext<DigirigConfig>) => Promise<void>;
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

  let transcriber: Transcriber | null = null;
  let sttServerProc: ReturnType<typeof spawn> | null = null;
  let sttEnsureTimer: NodeJS.Timeout | null = null;
  let runLoopAbort: AbortController | null = null;
  let whisperAutoStartWarned = false;

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

  const ensureConfiguredSttServer = async (log?: { info?: (m: string)=>void; warn?: (m: string)=>void; error?: (m: string)=>void }) => {
    const server = (config.stt as any)?.server;
    if (!server || typeof server !== "object") return;
    const command = typeof server.command === "string" ? server.command.trim() : "";
    if (!command) return;

    const streamUrl = typeof (config.stt as any)?.streamUrl === "string"
      ? (config.stt as any).streamUrl
      : "http://127.0.0.1:18080/inference";

    // If STT HTTP endpoint is already alive, no need to spawn another process.
    if (await isHttpAlive(streamUrl, 1200)) return;
    if (sttServerProc && !sttServerProc.killed) return;

    let host = "127.0.0.1";
    let port = "18080";
    try {
      const u = new URL(streamUrl);
      host = u.hostname || host;
      port = u.port || port;
    } catch {}

    const modelPath = typeof server.modelPath === "string" ? server.modelPath : "";
    const argTemplate = typeof server.args === "string" ? server.args : "";
    const args = argTemplate
      .replaceAll("{model}", modelPath)
      .replaceAll("{host}", host)
      .replaceAll("{port}", port)
      .split(/\s+/)
      .filter(Boolean);

    try {
      sttServerProc = spawn(command, args, { stdio: "ignore", detached: false });
      sttServerProc.once("error", (err) => {
        log?.error?.(`[digirig] failed to start STT server: ${String(err)}`);
        sttServerProc = null;
      });
      sttServerProc.on("exit", (code) => {
        log?.warn?.(`[digirig] STT server exited (${code ?? "?"})`);
        sttServerProc = null;
      });
      log?.info?.(`[digirig] ensured STT server process: ${command} ${args.join(" ")}`);
    } catch (err) {
      log?.error?.(`[digirig] failed to start STT server: ${String(err)}`);
    }
  };

  const ensureWhisperLiveWs = async (log?: { info?: (m: string)=>void; warn?: (m: string)=>void; error?: (m: string)=>void }) => {
    const wsUrl = (config.stt?.wsUrl ?? "").trim();
    if (!wsUrl) return;

    let url: URL;
    try {
      url = new URL(wsUrl);
    } catch {
      return;
    }

    const host = url.hostname;
    const isLocalHost = host === "127.0.0.1" || host === "localhost";
    if (!isLocalHost) return;

    const port = Number(url.port || "28080");
    if (!Number.isFinite(port) || port <= 0) return;

    if (await isTcpAlive(host, port, 1200)) return;

    const shouldAutoStart = (config.stt as any)?.whisperLiveAutoStart !== false;
    if (!shouldAutoStart) return;

    const serviceName = typeof (config.stt as any)?.whisperLiveService === "string"
      ? (config.stt as any).whisperLiveService
      : "whisperlive.service";

    try {
      await runCommand("systemctl", ["--user", "start", serviceName]);
      const alive = await isTcpAlive(host, port, 1500);
      if (alive) {
        whisperAutoStartWarned = false;
        log?.info?.(`[digirig] WhisperLive auto-started via systemd user service: ${serviceName}`);
      } else if (!whisperAutoStartWarned) {
        whisperAutoStartWarned = true;
        log?.warn?.(`[digirig] WhisperLive start requested but WS is still unreachable at ${wsUrl}. Run: systemctl --user status ${serviceName}`);
      }
    } catch (err) {
      if (!whisperAutoStartWarned) {
        whisperAutoStartWarned = true;
        log?.warn?.(`[digirig] WhisperLive auto-start failed (${serviceName}): ${String(err)}`);
        log?.warn?.("[digirig] First-run fix: run ./scripts/setup-whisperlive-systemd.sh (from plugin repo), then openclaw gateway restart");
      }
    }
  };

  const start = async (ctx: ChannelGatewayStartContext<DigirigConfig>) => {
    if (hardStopped || started) {
      return;
    }
    started = true;
    logger = ctx.log ?? null;
    await ensureConfiguredSttServer(ctx.log);
    await ensureWhisperLiveWs(ctx.log);
    if (sttEnsureTimer) clearInterval(sttEnsureTimer);
    sttEnsureTimer = setInterval(() => {
      void ensureConfiguredSttServer(ctx.log);
      void ensureWhisperLiveWs(ctx.log);
    }, 15000);
    runLoopAbort = new AbortController();

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
      }, 80);
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

      const radioPrompt = "Radio mode: respond briefly for on-air voice, keep phrasing clear for speech playback, and preserve callsigns when heard. Do not mention policy, tools, or refusal; just answer or acknowledge.";
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
      if (transcriber) {
        transcriber.endTurn();
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
      if (transcriber) {
        transcriber.pushFrame(frame);
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
      if (!transcriber) {
        transcriber = new WhisperLiveTranscriber({ wsUrl, log: ctx.log });
      }
      void transcriber.connect().catch((err) =>
        ctx.log?.error?.(`[digirig] WhisperLive connect failed: ${String(err)}`),
      );
      transcriber.startTurn();
    });

    audioMonitor.on("utterance", async (utterance) => {
      if (rxFinalized) {
        return;
      }
      sttInFlight = true;
      try {
        const rxEndAt = lastRxEndAt || Date.now();
        const sttStartAt = Date.now();
        ctx.log?.info?.(
          `[digirig] STT start (rxToSttStartMs=${sttStartAt - rxEndAt})`,
        );

        let text = "";
        if (transcriber) {
          await transcriber.waitForResult(350);
          text = normalizeSttText(transcriber.getText() || "");
          if (!text.trim()) {
            await transcriber.waitForResult(850);
            text = normalizeSttText(transcriber.getText() || "");
          }
        }

        if (!text.trim()) {
          const localCfg = (config.stt as any)?.localWhisper ?? {};
          text = normalizeSttText(
            await transcribeWithLocalWhisper({
              pcm16: utterance as Buffer,
              sampleRate: config.audio.sampleRate,
              log: ctx.log,
              command: typeof localCfg.command === "string" ? localCfg.command : "whisper",
              model: typeof localCfg.model === "string" ? localCfg.model : "base",
              language: typeof (config.stt as any)?.language === "string" ? (config.stt as any).language : "en",
            }),
          );
          if (text) {
            ctx.log?.info?.("[digirig] STT source: local whisper fallback");
          }
        }

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
    const abortRunLoop = () => {
      runLoopAbort?.abort();
    };
    ctx.abortSignal.addEventListener("abort", abortRunLoop, { once: true });
    try {
      await waitForAbort(runLoopAbort.signal);
    } finally {
      ctx.abortSignal.removeEventListener("abort", abortRunLoop);
      started = false;
      audioMonitor.stop();
      transcriber?.close();
      transcriber = null;
      if (sttEnsureTimer) {
        clearInterval(sttEnsureTimer);
        sttEnsureTimer = null;
      }
      if (sttServerProc && !sttServerProc.killed) {
        sttServerProc.kill("SIGTERM");
        sttServerProc = null;
      }
      runLoopAbort = null;
      updateStatus({
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    }
  };

  const stop = async () => {
    hardStopped = true;
    runLoopAbort?.abort();
    started = false;
    audioMonitor.stop();
    transcriber?.close();
    transcriber = null;
    if (sttEnsureTimer) {
      clearInterval(sttEnsureTimer);
      sttEnsureTimer = null;
    }
    if (sttServerProc && !sttServerProc.killed) {
      sttServerProc.kill("SIGTERM");
      sttServerProc = null;
    }
    await ptt.close();
  };

  const getCalibrationStatus = () => calibration?.status ?? "idle";
  const getCalibrationResult = () => calibration?.result ?? null;

  return { start, stop, speak, startCalibration, getCalibrationStatus, getCalibrationResult };
}

async function isHttpAlive(url: string, timeoutMs = 1200): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    return !!res;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isTcpAlive(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  try {
    const net = await import("node:net");
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(timeoutMs, () => finish(false));
    });
  } catch {
    return false;
  }
}

async function transcribeWithLocalWhisper(params: {
  pcm16: Buffer;
  sampleRate: number;
  log?: { warn?: (m: string) => void; error?: (m: string) => void };
  command?: string;
  model?: string;
  language?: string;
}): Promise<string> {
  const { pcm16, sampleRate, log } = params;
  if (!pcm16?.length) return "";
  const cmd = (params.command || "whisper").trim();
  const model = (params.model || "base").trim();
  const language = (params.language || "en").trim();

  const dir = await fs.mkdtemp(join(tmpdir(), "digirig-whisper-"));
  const wavPath = join(dir, "rx.wav");
  const outDir = join(dir, "out");
  await fs.mkdir(outDir, { recursive: true });

  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm16.length, 40);
  await fs.writeFile(wavPath, Buffer.concat([header, pcm16]));

  const args = [
    wavPath,
    "--model", model,
    "--language", language,
    "--fp16", "False",
    "--output_format", "txt",
    "--output_dir", outDir,
  ];

  try {
    await runCommand(cmd, args);
    const txtPath = join(outDir, "rx.txt");
    const txt = await fs.readFile(txtPath, "utf8");
    return txt.trim();
  } catch (err) {
    log?.warn?.(`[digirig] local whisper fallback failed: ${String(err)}`);
    return "";
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
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
