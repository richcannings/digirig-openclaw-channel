import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelGatewayContext as ChannelGatewayStartContext } from "openclaw/plugin-sdk/channel-runtime";
import { createRadioContextPayload, dispatchRadioReply, recordInboundSession } from "./channel-core.js";
import { getDigirigRuntime } from "./state.js";
import type { DigirigConfig } from "./config.js";
import { AudioMonitor } from "./audio-monitor.js";
import { PttController } from "./ptt.js";
import { playPcm, synthesizeTts } from "./tts.js";

const normalizeEchoText = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(w6rgc|w6r|rgc|ai|over|clear|seven|7|overlord)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

const levenshtein = (a: string, b: string): number => {
  const alen = a.length;
  const blen = b.length;
  if (!alen) return blen;
  if (!blen) return alen;
  const dp = Array.from({ length: alen + 1 }, () => new Array(blen + 1).fill(0));
  for (let i = 0; i <= alen; i += 1) dp[i][0] = i;
  for (let j = 0; j <= blen; j += 1) dp[0][j] = j;
  for (let i = 1; i <= alen; i += 1) {
    for (let j = 1; j <= blen; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[alen][blen];
};

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

    // Handle ham radio suffixes (e.g., W6RGC/AI should match W6RGC)
    if (call.includes("/")) {
      const parts = call.split("/");
      for (const part of parts) {
        if (part.length >= 3 && upper.includes(part)) return true;
      }
    }

    const callBare = call.replace(/[^A-Z0-9]/g, "");
    return callBare.length > 0 && textBare.includes(callBare);
  });
}

function isLikelyWakeWordOnly(text: string, callsign?: string, aliases: string[] = []): boolean {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s/]/g, " ").trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 8) return false;

  const wakeWords = new Set(
    [callsign, ...aliases]
      .filter(Boolean)
      .flatMap((s) => String(s).toLowerCase().split(/[^a-z0-9/]+/).filter(Boolean)),
  );
  if (!wakeWords.size) return false;

  const nonWake = words.filter((w) => !wakeWords.has(w));
  return nonWake.length === 0;
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

function formatRadioReply(text: string, maxWords = 300): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "";
  }
  const words = trimmed.split(" ");
  if (words.length <= maxWords) {
    return trimmed;
  }
  return words.slice(0, maxWords).join(" ").trim();
}

function isSpeakableStreamingReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 8) return true;
  return /[.!?]\s*$/.test(t);
}

function normalizeSttText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "[blank_audio]" || lower === "(blank audio)") return "";
  if (/\bbeep\b/i.test(trimmed)) return "";
  if (/^\s*[\[(].*[\])]\s*$/.test(trimmed)) return "";
  // Drop punctuation-only / symbol-only garbage (e.g. ".\n.\n.").
  if (!/[a-z0-9]/i.test(trimmed)) return "";

  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Suppress classic WhisperLive loop hallucinations (very low lexical variety).
  if (tokens.length >= 10) {
    const unique = new Set(tokens).size;
    const diversity = unique / tokens.length;
    if (diversity < 0.3) {
      return "";
    }
  }

  // Drop stray 1–3 character prefix fragments (e.g., "GC.") when followed by a sentence.
  const rawTokens = trimmed.split(/\s+/);
  if (rawTokens.length > 1 && rawTokens[0].length <= 3) {
    const remainder = rawTokens.slice(1).join(" ");
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
  const logDate = getLocalDateStamp();
  const logPath = join(logDir, `digirig-${logDate}.log`);
  let logger: ChannelGatewayStartContext<DigirigConfig>["log"] | null = null;

  let txInProgress = false;
  let runLoopAbort: AbortController | null = null;

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
  let lastRxSilenceMs = 0;
  let lastRxDurationMs = 0;
  let lastRxText = "";
  let lastTxText = "";
  let lastRxAt = 0;
  let lastTxAt = 0;
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

  const speak = async (
    text: string,
    hooks?: { onPttKeyed?: (atMs: number) => void; onAudioStart?: (atMs: number) => void },
  ) => {
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
      try {
        const trimmed = text.trim();
        lastTxText = trimmed;
        lastTxAt = Date.now();
        await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 60000);
        await ptt.withTx(async () => {
          hooks?.onPttKeyed?.(Date.now());
          txInProgress = true;
          // Immediately suppress RX capture while TX is active to avoid self-transcription.
          audioMonitor.muteFor(120000);
          await safeSetCaptureMute(true);
          try {
            logger?.info?.(`[digirig] TTS input: ${trimmed}`);
            const tts = await synthesizeTts(runtime, text);
            const bytesPerMs = tts.sampleRate * 2 / 1000;
            const audioMs = bytesPerMs > 0 ? Math.ceil(tts.audioBuffer.length / bytesPerMs) : 0;
            const muteMs = Math.max(0, config.ptt.leadMs + config.ptt.tailMs + audioMs + 500);
            audioMonitor.clearMute();
            audioMonitor.muteFor(muteMs);
            hooks?.onAudioStart?.(Date.now());
            await playPcm({
              device: config.audio.outputDevice,
              sampleRate: tts.sampleRate,
              channels: 1,
              pcm: tts.audioBuffer,
            });
          } finally {
            await safeSetCaptureMute(false);
            txInProgress = false;
            audioMonitor.clearMute();
          }
        });
        await logTranscript("TX", trimmed);
      } catch (err) {
        logger?.error?.(`[digirig] TX sequence failed (caught to prevent queue poison): ${String(err)}`);
        audioMonitor.clearMute();
        txInProgress = false;
      }
    });
    await outboundQueue;
  };

  const start = async (ctx: ChannelGatewayStartContext<DigirigConfig>) => {
    if (hardStopped || started) {
      return;
    }
    started = true;
    logger = ctx.log ?? null;

    const captureMute = getCaptureMuteConfig(config.audio.inputDevice);
    if (captureMute) {
      try {
        await setCaptureMute(captureMute, false);
        ctx.log?.info?.(`[digirig] ensured capture device is unmuted (control: ${captureMute.control})`);
      } catch (err) {
        ctx.log?.warn?.(`[digirig] failed to unmute capture device: ${String(err)}`);
      }
    }

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
    let lastSttStartAt = 0;
    let lastSttEndAt = 0;
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
      rxFinalized = true;

      try {
        if (sttInFlight) {
          rxFinalized = false;
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

        const text = normalizeSttText([...rxChunks, chunkText].join(" "));
        rxChunks = [];

        // Deduplication: Drop duplicate RX lines within a short window.
        if (
          lastRxText &&
          normalizeEchoText(text) === normalizeEchoText(lastRxText) &&
          Date.now() - lastRxAt < 5000
        ) {
          ctx.log?.info?.("[digirig] RX dropped (duplicate)");
          rxBuffer = [];
          rxStartAt = 0;
          return;
        }

        // Echo Suppression: Drop RX that matches our last TX within 15s.
        if (lastTxText && Date.now() - lastTxAt < 15000) {
          const a = normalizeEchoText(text);
          const b = normalizeEchoText(lastTxText);
          if (a && b) {
            const dist = levenshtein(a, b);
            const maxLen = Math.max(a.length, b.length) || 1;
            const similarity = 1 - dist / maxLen;
            if (similarity >= 0.85) {
              ctx.log?.info?.(`[digirig] RX dropped (echo similarity=${similarity.toFixed(2)})`);
              rxBuffer = [];
              rxStartAt = 0;
              return;
            }
          }
        }

        lastRxText = text;
        lastRxAt = Date.now();

        await logTranscript("RX", text);
        if (!text.trim()) {
          rxBuffer = [];
          rxStartAt = 0;
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
          return;
        }

        const radioPrompt = "Radio mode: respond with 300 words or less for on-air voices, keep phrasing clear for speech playback, and preserve callsigns when heard. Do not explain your plans or ask for permission; just execute the command or provide the answer immediately. Do not mention policy, tools, or refusal; just answer or acknowledge.";
        const ctxPayload = createRadioContextPayload(runtime, cfg, route, text, radioPrompt);

        await recordInboundSession(runtime, cfg, route, ctxPayload, ctx.log);

        const dispatchStartAt = Date.now();
        const rxEndAtSnapshot = lastRxEndAt;
        let firstPttAt = 0;
        let firstAudioAt = 0;
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
            if (didSpeak) {
              ctx.log?.info?.("[digirig] duplicate deliver suppressed");
              return;
            }
            const shortReply = formatRadioReply(payload.text);
            if (!shortReply) {
              return;
            }
            if (!isSpeakableStreamingReply(shortReply)) {
              ctx.log?.debug?.("[digirig] streaming chunk buffered; waiting for a speakable sentence");
              return;
            }
            const txText = appendCallsign(shortReply, config.tx.callsign);
            ctx.log?.info?.(`[digirig] reply deliver: ${txText}`);
            didSpeak = true;
            const speakStartAt = Date.now();
            await speak(txText, {
              onPttKeyed: (atMs) => {
                if (!firstPttAt) firstPttAt = atMs;
              },
              onAudioStart: (atMs) => {
                if (!firstAudioAt) firstAudioAt = atMs;
              },
            });
            speakMs = Date.now() - speakStartAt;
          },
        });
        const dispatchEndAt = Date.now();
        const counts = dispatchResult?.counts ?? {};
        const lastReplyLen = dispatchResult?.finalText?.length ?? 0;
        ctx.log?.info?.(`[digirig] dispatch result counts=${JSON.stringify(counts)} finalLen=${lastReplyLen}`);
        const rxEndAt = rxEndAtSnapshot || null;
        const responseTimeMs = firstPttAt && rxEndAt ? Math.max(0, firstPttAt - rxEndAt) : null;
        const rxToSttStartMs = rxEndAt && lastSttStartAt ? Math.max(0, lastSttStartAt - rxEndAt) : null;
        const sttMs = lastSttStartAt && lastSttEndAt ? Math.max(0, lastSttEndAt - lastSttStartAt) : null;
        const estimatedReleaseToFirstTxMs =
          firstPttAt && rxEndAt ? Math.max(0, firstPttAt - (rxEndAt - Math.max(0, lastRxSilenceMs || 0))) : null;
        const estimatedReleaseToFirstAudioMs =
          firstAudioAt && rxEndAt ? Math.max(0, firstAudioAt - (rxEndAt - Math.max(0, lastRxSilenceMs || 0))) : null;
        const timing = {
          rxDurationMs: lastRxDurationMs || null,
          rxSilenceMs: lastRxSilenceMs || null,
          rxToSttStartMs,
          sttMs,
          routeMs: routeEndAt - routeStartAt,
          dispatchMs: dispatchEndAt - dispatchStartAt,
          rxToFirstTxMs: firstPttAt && rxEndAt ? Math.max(0, firstPttAt - rxEndAt) : null,
          rxPttToFirstAudioMs: firstPttAt && firstAudioAt ? Math.max(0, firstAudioAt - firstPttAt) : null,
          estimatedReleaseToFirstTxMs,
          estimatedReleaseToFirstAudioMs,
          responseTimeMs,
          speakMs: speakMs || null,
          totalRxToDoneMs: rxEndAt ? dispatchEndAt - rxEndAt : null,
          totalUtteranceToDoneMs: rxStartAt ? dispatchEndAt - rxStartAt : null,
        };
        ctx.log?.info?.(
          `[digirig] dispatch reply complete (counts=${JSON.stringify(counts)} timing=${JSON.stringify(timing)})`,
        );
        if (responseTimeMs !== null) {
          const est = timing.estimatedReleaseToFirstTxMs;
          ctx.log?.info?.(`[digirig] responseTimeMs=${responseTimeMs}${est !== null ? ` estimatedReleaseToFirstTxMs=${est}` : ""}`);
          const ts = new Date().toISOString();
          await appendTranscript(
            `[${ts}] METRIC: responseTimeMs=${responseTimeMs}${est !== null ? ` estimatedReleaseToFirstTxMs=${est}` : ""} (rxEndToFirstTx / approxPttReleaseToFirstTx)`,
          );
        }
        rxBuffer = [];
        rxStartAt = 0;
      } catch (err) {
        ctx.log?.error?.(`[digirig] finalizeRx error: ${String(err)}`);
      } finally {
        rxFinalized = false;
      }
    };

    audioMonitor.on("recording-end", (evt) => {
      lastRxEndAt = Date.now();
      const reason = evt?.reason ?? "?";
      lastRxEndReason = reason;
      const silenceMs = Number(evt?.silenceMs ?? 0);
      const durationMs = Number(evt?.durationMs ?? 0);
      lastRxSilenceMs = Number.isFinite(silenceMs) ? silenceMs : 0;
      lastRxDurationMs = Number.isFinite(durationMs) ? durationMs : 0;
      ctx.log?.info?.(`[digirig] RX end (session=${rxSessionId}, durationMs=${evt?.durationMs ?? '?'}, silenceMs=${silenceMs}, reason=${reason})`);
      
      if (reason === "maxRecord") {
        void finalizeRx();
        return;
      }
      scheduleFinalizeRx();
    });

    audioMonitor.on("recording-frame", (frame: Buffer) => {
      if (txInProgress) return;
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
    });

    audioMonitor.on("recording-start", () => {
      if (txInProgress) {
        ctx.log?.info?.("[digirig] RX start ignored during TX");
        return;
      }
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
    });

    audioMonitor.on("utterance", async (utterance) => {
      if (txInProgress) {
        ctx.log?.info?.("[digirig] utterance ignored during TX");
        return;
      }
      if (rxFinalized) {
        return;
      }
      sttInFlight = true;
      try {
        const rxEndAt = lastRxEndAt || Date.now();
        const sttStartAt = Date.now();
        lastSttStartAt = sttStartAt;
        ctx.log?.info?.(
          `[digirig] STT start (rxToSttStartMs=${sttStartAt - rxEndAt})`,
        );

        const localCfg = (config.stt as any)?.localWhisper ?? {};
        const text = normalizeSttText(
          await transcribeWithLocalWhisper({
            pcm16: utterance.pcm,
            sampleRate: utterance.sampleRate ?? config.audio.sampleRate,
            log: ctx.log,
            command: typeof localCfg.command === "string" ? localCfg.command : "whisper",
            model: typeof localCfg.model === "string" ? localCfg.model : "base",
            language: typeof (config.stt as any)?.language === "string" ? (config.stt as any).language : "en",
          }),
        );
        ctx.log?.info?.("[digirig] STT source: local whisper batch");

        ctx.log?.info?.(`[digirig] STT: ${text || "(empty)"}`);
        if (!text.trim()) {
          return;
        }
        const normalizedRx = normalizeSttText(text);
        if (!normalizedRx) {
          return;
        }

        // WhisperLive text is cumulative; overwrite rxBuffer to avoid duplication.
        rxBuffer = [normalizedRx];
      } catch (err) {
        ctx.log?.error?.(`[digirig] inbound error: ${String(err)}`);
      } finally {
        lastSttEndAt = Date.now();
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

function getLocalDateStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
