import { promises as fs, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelGatewayContext as ChannelGatewayStartContext } from "openclaw/plugin-sdk/channel-runtime";
import { createRadioContextPayload, dispatchRadioReply, recordInboundSession } from "./channel-core.js";
import { getDigirigRuntime } from "./state.js";
import type { DigirigConfig } from "./config.js";
import { AudioMonitor } from "./audio-monitor.js";
import { PttController } from "./ptt.js";
import { playPcm, synthesizeTts } from "./tts.js";
import { buildHamRadioPrompt, formatSignalReport } from "./prompt/index.js";
import { AsyncQueue } from "./pipeline/queue.js";
import { AudioAssets } from "./pipeline/audio-assets.js";
import {
  CALLSIGN_REGEX,
  appendCallsign,
  correctCallsignsInText,
  formatRadioReply,
  isDirectCall,
  isSpeakableStreamingReply,
  normalizeSttText,
  parseAliases,
} from "./runtime/text-utils.js";

export { appendCallsign };

const LOCAL_WHISPER_URL = "http://127.0.0.1:18088/transcribe";
const LOCAL_WHISPER_TIMEOUT_MS = 30_000;
const TX_API_PORT = 18089;
const TX_MAX_ATTEMPTS = 3;
const TX_BACKOFF_MS = 1200;
const POST_TX_MUTE_MS = 1500;
const FCC_ID_INTERVAL_MS = 10 * 60 * 1000;
const FCC_ID_POLL_MS = 60_000;

export type DigirigRuntime = {
  start: (ctx: ChannelGatewayStartContext<DigirigConfig>) => Promise<void>;
  stop: () => Promise<void>;
  speak: (text: string) => Promise<void>;
  /** Operator safety: drop PTT now, abort any in-flight TX, and drop any queued TX jobs. */
  emergencyUnkey: () => Promise<{ cancelledJobs: number }>;
};

type RxAudioJob = { sessionId: number; utterance: any };
type SttJob = { sessionId: number; utterance: any };
type AgentJob = {
  sessionId: number;
  text: string;
  rmsDb?: number;
  peakDb?: number;
  sttMs: number;
};
type TxJob =
  | {
      kind: "text";
      text: string;
      hooks?: { onPttKeyed?: (atMs: number) => void; onAudioStart?: (atMs: number) => void };
      done?: { resolve: () => void; reject: (err: unknown) => void };
      abortSignal?: AbortSignal;
    }
  | {
      kind: "raw";
      pcm: Buffer;
      sampleRate: number;
      label?: string;
      done?: { resolve: () => void; reject: (err: unknown) => void };
      abortSignal?: AbortSignal;
    };

// Loads known callsigns from SCCARC roster + recently heard callsigns.
// Corrects STT-garbled callsigns in transcribed text via the helpers in
// `runtime/text-utils.ts`. This one stays here because it touches disk.
function loadKnownCallsigns(): string[] {
  try {
    const rosterPath = join(homedir(), ".openclaw", "workspace", "references", "sccarc-roster.csv");
    const csv = readFileSync(rosterPath, "utf8");
    const calls: string[] = [];
    for (const line of csv.split("\n").slice(1)) {
      const call = line.split(",")[0]?.trim().toUpperCase();
      if (call && CALLSIGN_REGEX.test(call)) calls.push(call);
    }
    return calls;
  } catch {
    return [];
  }
}

export async function createDigirigRuntime(config: DigirigConfig): Promise<DigirigRuntime> {
  const runtime = getDigirigRuntime();
  const knownCallsigns = loadKnownCallsigns();
  const heardCallsigns = new Set<string>();
  const audioMonitor = new AudioMonitor({
    device: config.audio.inputDevice,
    sampleRate: config.audio.sampleRate,
    channels: 1,
    frameMs: config.rx.frameMs,
    preRollMs: config.rx.preRollMs,
    energyThreshold: config.rx.energyThreshold,
    carrierSenseThreshold: config.rx.carrierSenseThreshold,
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

  // Assembled once per channel lifetime. The channel is registered with
  // `reload: { configPrefixes: ["channels.digirig"] }` so config changes to
  // persona.* or tx.* tear this down and rebuild it — no need to re-render
  // per message.
  const hamRadioPrompt = buildHamRadioPrompt(config);

  const rxAudioQueue = new AsyncQueue<RxAudioJob | null>();
  const sttQueue = new AsyncQueue<SttJob | null>();
  const agentQueue = new AsyncQueue<AgentJob | null>();
  const txQueue = new AsyncQueue<TxJob | null>();

  let hardStopped = false;
  let started = false;
  let runLoopAbort: AbortController | null = null;
  let idTimer: NodeJS.Timeout | null = null;
  let txApiServer: http.Server | null = null;
  let logger: ChannelGatewayStartContext<DigirigConfig>["log"] | null = null;
  let txInProgress = false;
  // Abort handle for the TX job currently being executed (set by the TX worker,
  // triggered by `emergencyUnkey()`). Null when the worker is idle.
  let currentTxAbort: AbortController | null = null;

  const logDir = join(homedir(), ".openclaw", "logs");
  const logDate = getLocalDateStamp();
  const logPath = join(logDir, `digirig-${logDate}.log`);

  let rxSessionId = 0;
  let lastRxEndAt = 0;
  let lastRxEndReason: string | null = null;
  let lastRxSilenceMs = 0;
  let lastRxDurationMs = 0;
  let lastIdTxAt = Date.now();
  let lastTxAt = 0;

  const logEvent = async (data: { type: string; [key: string]: any }) => {
    const ts = new Date().toISOString();
    let summary = data.summary || "";
    if (!summary) {
      if (data.type === "RX" || data.type === "TX") {
        summary = `${data.type}: ${data.text ?? ""}`;
      } else if (data.type === "METRIC") {
        const metrics = Object.entries(data)
          .filter(([k]) => k !== "type" && k !== "summary" && k !== "sessionId")
          .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(0) : JSON.stringify(v)}`)
          .join(" ");
        summary = `METRIC: ${metrics}`;
      }
    }
    const entry = { summary, ts, ...data };
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logPath, JSON.stringify(entry) + "\n");
  };

  const logTranscript = async (speaker: "RX" | "TX", text: string, sessionId?: number, extraProps?: Record<string, any>) => {
    if (!text.trim()) return;
    await logEvent({ type: speaker, text: text.trim(), sessionId, ...(extraProps || {}) });
  };

  const enqueueTxJob = async (job: Omit<TxJob, "done">): Promise<void> => {
    if (!config.ptt.rts) return;
    await new Promise<void>((resolve, reject) => {
      txQueue.push({ ...job, done: { resolve, reject } } as TxJob);
    });
  };

  const speak = async (
    text: string,
    hooks?: { onPttKeyed?: (atMs: number) => void; onAudioStart?: (atMs: number) => void },
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await enqueueTxJob({ kind: "text", text: trimmed, hooks });
  };

  const executeTextTx = async (
    text: string,
    hooks?: { onPttKeyed?: (atMs: number) => void; onAudioStart?: (atMs: number) => void },
    abortSignal?: AbortSignal,
  ) => {
    const tts = await synthesizeTts(runtime, text, config);
    const bytesPerMs = tts.sampleRate * 2 / 1000;
    const audioMs = bytesPerMs > 0 ? Math.ceil(tts.audioBuffer.length / bytesPerMs) : 0;
    const muteMs = Math.max(0, config.ptt.leadMs + config.ptt.tailMs + audioMs + 500);
    const txAbortController = new AbortController();
    
    // Wire up parent abort signal to the inner one
    const parentAbortHandler = () => txAbortController.abort();
    if (abortSignal) {
      abortSignal.addEventListener("abort", parentAbortHandler);
      if (abortSignal.aborted) txAbortController.abort();
    }

    const maxTxTimer = setTimeout(() => {
      logger?.error?.(`[digirig] CRITICAL: Max TX duration (${config.tx.maxTxMs}ms) exceeded. Forcefully aborting transmission to protect hardware.`);
      txAbortController.abort();
    }, config.tx.maxTxMs);

    try {
      let transmitted = false;
      for (let attempt = 1; attempt <= TX_MAX_ATTEMPTS; attempt++) {
        const waitResult = await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 60000);
        if (waitResult === "timeout") {
          logger?.warn?.(`[digirig] TX abandoned: channel busy for 60s (attempt ${attempt}/${TX_MAX_ATTEMPTS})`);
          break;
        }
        if (lastRxEndAt > 0) {
          const msSinceRx = Date.now() - lastRxEndAt;
          const remainingCourtesyMs = config.tx.courtesyDelayMs - msSinceRx;
          if (remainingCourtesyMs > 0) {
            logger?.info?.(`[digirig] TX courtesy delay: waiting ${remainingCourtesyMs}ms`);
            await delay(remainingCourtesyMs);
            if (audioMonitor.isCarrierPresent()) {
              logger?.info?.("[digirig] TX deferred: carrier detected after courtesy wait");
              await delay(TX_BACKOFF_MS);
              continue;
            }
          }
        }

        await delay(50);
        if (audioMonitor.isCarrierPresent()) {
          logger?.info?.(`[digirig] TX deferred: carrier detected at final 50ms check (attempt ${attempt}/${TX_MAX_ATTEMPTS}, energy=${audioMonitor.getLastEnergy().toFixed(6)})`);
          await delay(TX_BACKOFF_MS);
          continue;
        }

        audioMonitor.muteFor(muteMs);
        await ptt.open();
        await ptt.setTx(true);
        hooks?.onPttKeyed?.(Date.now());
        if (config.ptt.leadMs > 0) await delay(config.ptt.leadMs);

        try {
          hooks?.onAudioStart?.(Date.now());
          await playPcm({
            device: config.audio.outputDevice,
            sampleRate: tts.sampleRate,
            channels: 1,
            pcm: tts.audioBuffer,
            signal: txAbortController.signal,
          });
        } finally {
          if (config.ptt.tailMs > 0) await delay(config.ptt.tailMs);
          await ptt.setTx(false);
          audioMonitor.muteFor(POST_TX_MUTE_MS);
        }

        await logTranscript("TX", text);
        lastTxAt = Date.now();
        const cleanText = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const cleanCall = config.tx.callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (cleanText.includes(cleanCall)) lastIdTxAt = Date.now();
        transmitted = true;
        break;
      }

      if (!transmitted) {
        logger?.warn?.(`[digirig] TX dropped after ${TX_MAX_ATTEMPTS} attempts: "${text.slice(0, 80)}..."`);
      }
    } finally {
      clearTimeout(maxTxTimer);
      if (abortSignal) {
        abortSignal.removeEventListener("abort", parentAbortHandler);
      }
    }
  };

  const executeRawTx = async (pcm: Buffer, sampleRate: number, label?: string, abortSignal?: AbortSignal) => {
    const bytesPerMs = sampleRate * 2 / 1000;
    const audioMs = bytesPerMs > 0 ? Math.ceil(pcm.length / bytesPerMs) : 0;
    const muteMs = Math.max(0, config.ptt.leadMs + config.ptt.tailMs + audioMs + 500);

    logger?.info?.(`[digirig] RAW TX starting: audioMs=${audioMs}, sampleRate=${sampleRate}, label=${label ?? "-"}`);

    const waitResult = await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 60000);
    if (waitResult === "timeout") throw new Error("Channel busy for 60s");
    if (audioMonitor.isCarrierPresent()) {
      const energy = audioMonitor.getLastEnergy();
      const busy = audioMonitor.getBusy();
      logger?.info?.(`[digirig] RAW TX aborted at pre-check: isCarrierPresent=true, energy=${energy.toFixed(6)}, threshold=${config.rx.carrierSenseThreshold}, getBusy=${busy}`);
      await logEvent({
        type: "TX_RAW_ABORT",
        stage: "pre-check",
        energy,
        threshold: config.rx.carrierSenseThreshold,
        isCarrierPresent: true,
        getBusy: busy,
        label,
        audioMs,
        summary: `TX_RAW_ABORT: pre-check (energy=${energy.toFixed(6)}, busy=${busy})`,
      });
      throw new Error("Carrier detected");
    }

    // Mute the audio monitor BEFORE keying the PTT.
    // A half-duplex radio cannot hear anything while keyed up, and the
    // electrical pop of keying the PTT will trigger a false positive carrier.
    audioMonitor.muteFor(muteMs);

    await ptt.open();
    await ptt.setTx(true);
    if (config.ptt.leadMs > 0) {
      await delay(config.ptt.leadMs);
    }

    try {
      await playPcm({ device: config.audio.outputDevice, sampleRate, channels: 1, pcm, signal: abortSignal });
    } finally {
      if (config.ptt.tailMs > 0) await delay(config.ptt.tailMs);
      await ptt.setTx(false);
      audioMonitor.muteFor(POST_TX_MUTE_MS);
    }

    await logEvent({ type: "TX_RAW", audioMs, sampleRate, label, summary: label ? `TX_RAW: ${label} tone (${audioMs}ms)` : undefined });
    if (label) {
      logger?.info?.(`[digirig] Transmitted raw audio tone: ${label} (${audioMs}ms)`);
    }
  };

  const start = async (ctx: ChannelGatewayStartContext<DigirigConfig>) => {
    if (hardStopped || started) return;
    started = true;
    logger = ctx.log ?? null;
    runLoopAbort = new AbortController();

    if (config.tones?.enabled) {
      const sr = config.audio.sampleRate;
      const { standby, error, beep } = config.tones.assets || {};
      if (standby) await AudioAssets.eagerLoad("standby", standby, sr);
      if (error) await AudioAssets.eagerLoad("error", error, sr);
      if (beep) await AudioAssets.eagerLoad("beep", beep, sr);
    }

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
      ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, ...patch });
    };

    if (idTimer) clearInterval(idTimer);
    idTimer = setInterval(async () => {
      if (lastTxAt > lastIdTxAt && Date.now() - lastIdTxAt >= FCC_ID_INTERVAL_MS) {
        ctx.log?.info?.("[digirig] 10-minute FCC ID timer triggered.");
        await speak(`This is ${config.tx.callsign} standing by.`);
      }
    }, FCC_ID_POLL_MS);

    const rxWorker = async () => {
      for (;;) {
        const job = await rxAudioQueue.pop();
        if (!job || runLoopAbort?.signal.aborted) break;
        if (txInProgress || job.utterance?.reason === "tx" || lastRxEndReason === "tx") {
          ctx.log?.info?.("[digirig] utterance ignored (aborted by TX mute)");
          continue;
        }
        sttQueue.push({ sessionId: job.sessionId, utterance: job.utterance });
      }
    };

    const sttWorker = async () => {
      for (;;) {
        const job = await sttQueue.pop();
        if (!job || runLoopAbort?.signal.aborted) break;
        const sttStartAt = Date.now();
        try {
          const rawText = await transcribeWithLocalWhisper({
            pcm16: job.utterance.pcm,
            sampleRate: job.utterance.sampleRate ?? config.audio.sampleRate,
            log: ctx.log,
            command: config.stt.cliFallback.command,
            model: config.stt.cliFallback.model,
            language: config.stt.language,
          });
          const normalizedText = normalizeSttText(rawText);
          const allKnown = [...knownCallsigns, ...heardCallsigns];
          const text = correctCallsignsInText(normalizedText, allKnown, ctx.log);

          ctx.log?.info?.(`[digirig] STT: ${text || "(empty)"}`);
          if (!text.trim()) continue;

          await logTranscript("RX", text, job.sessionId, {
            rmsDb: Number(job.utterance.rmsDb?.toFixed(1)),
            peakDb: Number(job.utterance.peakDb?.toFixed(1)),
          });
          updateStatus({ lastInboundAt: Date.now() });

          agentQueue.push({
            sessionId: job.sessionId,
            text,
            rmsDb: job.utterance.rmsDb,
            peakDb: job.utterance.peakDb,
            sttMs: Date.now() - sttStartAt,
          });
        } catch (err) {
          ctx.log?.error?.(`[digirig] STT worker error: ${String(err)}`);
        }
      }
    };

    const agentWorker = async () => {
      for (;;) {
        const job = await agentQueue.pop();
        if (!job || runLoopAbort?.signal.aborted) break;

        try {
          const cfg = runtime.config.loadConfig();
          const routeStartAt = Date.now();
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "digirig",
            accountId: "default",
            peer: { kind: "direct", id: "radio" },
          });
          const routeEndAt = Date.now();

          const policy = config.tx.policy ?? "direct-only";
          const aliasList = parseAliases(config.tx.aliases);
          const direct = isDirectCall(job.text, config.tx.callsign, aliasList);
          ctx.log?.info?.(
            `[digirig] routing: direct=${direct} policy=${policy} aliases=${aliasList.join(",")} routeSession=${route.sessionKey ?? "?"}`
          );
          if (policy === "direct-only" && !direct) continue;

          const radioPrompt = `${hamRadioPrompt}\n${formatSignalReport(job.rmsDb, job.peakDb)}`;
          const ctxPayload = createRadioContextPayload(runtime, cfg, route, job.text, radioPrompt);

          await recordInboundSession(runtime, cfg, route, ctxPayload, ctx.log);

          const dispatchStartAt = Date.now();
          let firstPttAt = 0;
          let speakMs = 0;
          let didSpeak = false;
          let detectedSender: string | null = null;

          ctx.log?.info?.(`[digirig] dispatch reply start session=${job.sessionId}`);
          
          // Latency ack: if the LLM doesn't deliver text within tones.timeoutMs, inject a
          // short "standby" tone at the front of the TX queue so operators hear an ack
          // instead of dead air. The timer is cancelled as soon as `didSpeak` flips true.
          let tonesTimer: NodeJS.Timeout | null = null;
          if (config.tones?.enabled) {
            tonesTimer = setTimeout(() => {
              tonesTimer = null;
              if (didSpeak) return;
              const standbyPcm = AudioAssets.get("standby") || AudioAssets.get("beep");
              if (!standbyPcm) return;
              ctx.log?.info?.(`[digirig] Latency timeout hit, injecting standby tone...`);
              txQueue.unshift({
                kind: "raw",
                pcm: standbyPcm,
                sampleRate: config.audio.sampleRate,
                label: "standby",
              });
            }, config.tones.timeoutMs);
          }

          const dispatchResult = await dispatchRadioReply({
            runtime,
            cfg,
            route,
            ctxPayload,
            log: ctx.log,
            deliver: async (payload) => {
              if (!payload.text) return;
              if (ctxPayload.OriginatingChannel !== "digirig" || ctxPayload.SessionKey !== "digirig:radio") return;
              if (didSpeak) return;

              let replyText = payload.text;
              const senderMatch = replyText.match(/^\s*\[SENDER:([A-Z0-9\/-]+)\]\s*/i);
              if (senderMatch) {
                detectedSender = senderMatch[1].toUpperCase();
                replyText = replyText.slice(senderMatch[0].length);
                ctx.log?.info?.(`[digirig] sender identified by LLM: ${detectedSender}`);
                const baseSender = detectedSender.split("-")[0];
                if (baseSender && CALLSIGN_REGEX.test(baseSender)) heardCallsigns.add(baseSender);
              }

              const shortReply = formatRadioReply(replyText);
              if (!shortReply || !isSpeakableStreamingReply(shortReply)) return;

              let txText = shortReply;
              // Append callsign if we're approaching the FCC 10-min ID deadline.
              if (Date.now() - lastIdTxAt > FCC_ID_INTERVAL_MS - 60_000) {
                txText = appendCallsign(shortReply, config.tx.callsign);
              }
              ctx.log?.info?.(`[digirig] reply deliver: ${txText}`);
              didSpeak = true;
              if (tonesTimer) {
                clearTimeout(tonesTimer);
                tonesTimer = null;
              }

              const speakStartAt = Date.now();
              await speak(txText, { onPttKeyed: (atMs) => { if (!firstPttAt) firstPttAt = atMs; } });
              speakMs = Date.now() - speakStartAt;
            },
          });
          const dispatchEndAt = Date.now();
          if (tonesTimer) clearTimeout(tonesTimer);

          if (config.tones?.enabled && (!dispatchResult || dispatchResult.finalText === undefined)) {
            const errorPcm = AudioAssets.get("error");
            if (errorPcm) {
              ctx.log?.info?.(`[digirig] Dispatch failed, playing error tone...`);
              txQueue.unshift({
                kind: "raw",
                pcm: errorPcm,
                sampleRate: config.audio.sampleRate,
                label: "error",
              });
            }
          }

          const counts = dispatchResult?.counts ?? {};

          ctx.log?.info?.(`[digirig] dispatch result counts=${JSON.stringify(counts)} finalLen=${dispatchResult?.finalText?.length ?? 0}`);
          const rxEndAt = lastRxEndAt;
          const responseTimeMs = firstPttAt && rxEndAt ? Math.max(0, firstPttAt - rxEndAt) : null;
          const timing = {
            rxDurationMs: lastRxDurationMs || null,
            rxSilenceMs: lastRxSilenceMs || null,
            sttMs: job.sttMs,
            routeMs: routeEndAt - routeStartAt,
            dispatchMs: dispatchEndAt - dispatchStartAt,
            responseTimeMs,
            speakMs: speakMs || null,
            totalRxToDoneMs: rxEndAt ? dispatchEndAt - rxEndAt : null,
          };
          ctx.log?.info?.(`[digirig] dispatch reply complete (counts=${JSON.stringify(counts)} timing=${JSON.stringify(timing)})`);
          await logEvent({ type: "METRIC", sessionId: job.sessionId, sender: detectedSender || undefined, ...timing });
          if (detectedSender) {
            await logEvent({ type: "RX_SENDER", sessionId: job.sessionId, sender: detectedSender, text: job.text.trim() });
          }
        } catch (err) {
          ctx.log?.error?.(`[digirig] agent worker error: ${String(err)}`);
        }
      }
    };

    const txWorker = async () => {
      for (;;) {
        const job = await txQueue.pop();
        if (!job || runLoopAbort?.signal.aborted) break;
        txInProgress = true;
        const jobAbort = new AbortController();
        currentTxAbort = jobAbort;
        // If the job brought its own abort signal, fold it into the per-job controller.
        const parentAbort = job.abortSignal;
        const parentHandler = () => jobAbort.abort();
        if (parentAbort) {
          parentAbort.addEventListener("abort", parentHandler, { once: true });
          if (parentAbort.aborted) jobAbort.abort();
        }
        try {
          if (job.kind === "text") {
            logger?.info?.(`[digirig] Audio input: ${job.text}`);
            await executeTextTx(job.text, job.hooks, jobAbort.signal);
          } else {
            await executeRawTx(job.pcm, job.sampleRate, job.label, jobAbort.signal);
          }
          job.done?.resolve();
        } catch (err) {
          logger?.error?.(`[digirig] TX sequence failed: ${String(err)}`);
          try { await ptt.setTx(false); } catch {}
          audioMonitor.muteFor(POST_TX_MUTE_MS);
          job.done?.reject(err);
        } finally {
          if (parentAbort) parentAbort.removeEventListener("abort", parentHandler);
          currentTxAbort = null;
          txInProgress = false;
        }
      }
    };

    const workers = [rxWorker(), sttWorker(), agentWorker(), txWorker()];

    audioMonitor.on("log", (msg) => ctx.log?.info?.(`[digirig] ${msg}`));
    audioMonitor.on("error", (err) => {
      ctx.log?.error?.(`[digirig] ${String(err)}`);
      updateStatus({ lastError: String(err) });
    });
    audioMonitor.on("recording-start", (evt) => {
      if (txInProgress) {
        ctx.log?.info?.("[digirig] RX start ignored during TX");
        return;
      }
      rxSessionId += 1;
      ctx.log?.info?.(`[digirig] RX session start id=${rxSessionId} (energy=${evt.energy?.toFixed(4) ?? "?"})`);
      updateStatus({ lastEventAt: Date.now() });
    });
    audioMonitor.on("recording-end", (evt) => {
      lastRxEndAt = Date.now();
      lastRxEndReason = evt?.reason ?? "?";
      const silenceMs = Number(evt?.silenceMs ?? 0);
      const durationMs = Number(evt?.durationMs ?? 0);
      lastRxSilenceMs = Number.isFinite(silenceMs) ? silenceMs : 0;
      lastRxDurationMs = Number.isFinite(durationMs) ? durationMs : 0;
      ctx.log?.info?.(`[digirig] RX end (session=${rxSessionId}, durationMs=${durationMs}, silenceMs=${silenceMs}, reason=${lastRxEndReason})`);
    });
    audioMonitor.on("utterance", (utterance: any) => {
      rxAudioQueue.push({ sessionId: rxSessionId, utterance });
    });

    audioMonitor.start();

    try {
      txApiServer = http.createServer((req, res) => {
        if (req.method === "GET" && req.url?.startsWith("/tx/status")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, txInProgress }));
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/tx/text")) {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", async () => {
            try {
              const text = Buffer.concat(chunks).toString("utf8").trim();
              if (!text) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Empty body" }));
                return;
              }
              ctx.log?.info?.(`[digirig] TEXT TX enqueued: chars=${text.length}, queueDepth=${txQueue.length}`);
              await enqueueTxJob({ kind: "text", text });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, chars: text.length }));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.log?.error?.(`[digirig] TX API text error: ${msg}`);
              if (!res.writableEnded) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: msg }));
              }
            }
          });
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/tx/raw")) {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", async () => {
            try {
              const pcm = Buffer.concat(chunks);
              if (pcm.length === 0) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Empty body" }));
                return;
              }
              const url = new URL(req.url!, `http://127.0.0.1:${TX_API_PORT}`);
              const sampleRate = Number(url.searchParams.get("sampleRate")) || config.audio.sampleRate;
              const bytesPerMs = sampleRate * 2 / 1000;
              const audioMs = bytesPerMs > 0 ? Math.ceil(pcm.length / bytesPerMs) : 0;
              ctx.log?.info?.(`[digirig] RAW TX enqueued: audioMs=${audioMs}, sampleRate=${sampleRate}, queueDepth=${txQueue.length}`);
              await enqueueTxJob({ kind: "raw", pcm, sampleRate });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, audioMs, sampleRate }));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.log?.error?.(`[digirig] TX API raw error: ${msg}`);
              if (!res.writableEnded) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: msg }));
              }
            }
          });
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Not found" }));
      });
      txApiServer.listen(TX_API_PORT, "127.0.0.1", () => {
        ctx.log?.info?.(`[digirig] TX API listening on http://127.0.0.1:${TX_API_PORT}`);
      });
      txApiServer.on("error", (err) => {
        ctx.log?.error?.(`[digirig] TX API server error: ${String(err)}`);
        txApiServer = null;
      });
    } catch (err) {
      ctx.log?.error?.(`[digirig] TX API failed to start: ${String(err)}`);
    }

    updateStatus({ running: true, connected: true, lastConnectedAt: Date.now(), lastStartAt: Date.now(), lastError: null });

    const abortRunLoop = () => runLoopAbort?.abort();
    ctx.abortSignal.addEventListener("abort", abortRunLoop, { once: true });
    try {
      await waitForAbort(runLoopAbort.signal);
    } finally {
      ctx.abortSignal.removeEventListener("abort", abortRunLoop);
      try { txApiServer?.close(); } catch {}
      txApiServer = null;
      if (idTimer) clearInterval(idTimer);
      idTimer = null;
      audioMonitor.stop();
      rxAudioQueue.push(null);
      sttQueue.push(null);
      agentQueue.push(null);
      txQueue.push(null);
      await Promise.allSettled(workers);
      started = false;
      runLoopAbort = null;
      updateStatus({ running: false, connected: false, lastStopAt: Date.now() });
    }
  };

  const stop = async () => {
    hardStopped = true;
    if (idTimer) clearInterval(idTimer);
    idTimer = null;
    runLoopAbort?.abort();
    rxAudioQueue.push(null);
    sttQueue.push(null);
    agentQueue.push(null);
    txQueue.push(null);
    started = false;
    audioMonitor.stop();
    await ptt.close();
  };

  // Operator safety hatch: invoked from `/digirig unkey`. Drops PTT the moment
  // the command is received, aborts the in-flight TX (if any), and rejects every
  // queued TX job so the gateway doesn't pick back up where it left off.
  const emergencyUnkey = async () => {
    logger?.warn?.("[digirig] EMERGENCY UNKEY — dropping PTT, cancelling queued TX");

    // 1. PTT down immediately, independent of whatever the TX worker is doing.
    try { await ptt.setTx(false); } catch (err) {
      logger?.error?.(`[digirig] emergencyUnkey: ptt.setTx(false) failed: ${String(err)}`);
    }

    // 2. Abort the currently-executing TX job. The TX worker will fall through
    //    its catch block, which also calls ptt.setTx(false) defensively.
    currentTxAbort?.abort();

    // 3. Drain any queued TX jobs and reject their awaiters so callers of
    //    `speak()` / `enqueueTxJob()` see a clean failure instead of a hang.
    const dropped = txQueue.drainSync().filter((j): j is TxJob => j !== null);
    for (const job of dropped) {
      job.done?.reject(new Error("TX cancelled by /digirig unkey"));
    }

    // 4. Mute the audio monitor for a moment so we don't self-trigger on our
    //    own tail. Same window as a normal end-of-TX.
    audioMonitor.muteFor(POST_TX_MUTE_MS);

    await logEvent({
      type: "TX_UNKEY",
      summary: `TX_UNKEY: dropped ${dropped.length} queued job(s)`,
      droppedJobs: dropped.length,
    });
    return { cancelledJobs: dropped.length };
  };

  return { start, stop, speak, emergencyUnkey };
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
  const wavBuffer = Buffer.concat([header, pcm16]);

  // Fast path: the hot-loaded daemon on 127.0.0.1:18088 keeps the Whisper model in VRAM.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_WHISPER_TIMEOUT_MS);
    const res = await fetch(LOCAL_WHISPER_URL, {
      method: "POST",
      body: wavBuffer,
      headers: { "Content-Type": "audio/wav" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const json = (await res.json()) as { text?: string };
      log?.info?.(`[digirig] STT source: hot-loaded daemon (ultra-fast)`);
      return (json.text || "").trim();
    }
  } catch (err: any) {
    // ECONNREFUSED / fetch TypeError = daemon absent, fall through quietly.
    if (err.name !== "TypeError" && err.code !== "ECONNREFUSED") {
      log?.warn?.(`[digirig] STT daemon failed, falling back to cold-start CLI: ${String(err)}`);
    }
  }

  // Cold-start fallback: invoke the `whisper` CLI. Works without the daemon but adds 2-4 s.
  log?.info?.(`[digirig] STT source: local whisper CLI (cold start)`);
  const dir = await fs.mkdtemp(join(tmpdir(), "digirig-whisper-"));
  const wavPath = join(dir, "rx.wav");
  const outDir = join(dir, "out");
  await fs.mkdir(outDir, { recursive: true });

  await fs.writeFile(wavPath, wavBuffer);

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
    log?.warn?.(`[digirig] local whisper batch failed: ${String(err)}`);
    return "";
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
): Promise<"clear" | "timeout"> {
  const start = Date.now();
  while (monitor.getBusy()) {
    if (Date.now() - start > maxWaitMs) {
      return "timeout";
    }
    await delay(Math.max(50, busyHoldMs / 4));
  }
  return "clear";
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
