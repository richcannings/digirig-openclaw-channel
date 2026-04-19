import { promises as fs } from "node:fs";
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
import { HAM_RADIO_PROMPT } from "./prompt.js";
import { AsyncQueue } from "./pipeline/queue.js";
import { AudioAssets } from "./pipeline/audio-assets.js";

export function appendCallsign(text: string, callsign?: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (!callsign || !callsign.trim()) {
    return trimmed;
  }
  
  // Clean punctuation from both strings for comparison
  const cleanText = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cleanCallsign = callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
  
  // Don't append if the clean text ends with the clean callsign
  if (cleanText.endsWith(cleanCallsign)) {
    return trimmed;
  }
  
  // Also check if the AI spelled out the callsign phonetically near the end
  if (trimmed.toUpperCase().includes("W6RGC") || trimmed.toLowerCase().includes("whiskey 6 romeo golf charlie") || trimmed.toLowerCase().includes("whiskey six romeo golf charlie")) {
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

export type DigirigRuntime = {
  start: (ctx: ChannelGatewayStartContext<DigirigConfig>) => Promise<void>;
  stop: () => Promise<void>;
  speak: (text: string) => Promise<void>;
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
  if (!/[a-z0-9]/i.test(trimmed)) return "";

  // Filter out common OpenAI Whisper static hallucinations
  const strippedLower = lower.replace(/[^a-z0-9\s]/g, "").trim();
  if (
    ["you", "thank you", "thanks for watching", "thank you for watching"].includes(strippedLower)
  ) {
    return "";
  }

  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length >= 10) {
    const unique = new Set(tokens).size;
    const diversity = unique / tokens.length;
    if (diversity < 0.3) {
      return "";
    }
  }

  const rawTokens = trimmed.split(/\s+/);
  if (rawTokens.length > 1 && rawTokens[0].length <= 3) {
    const remainder = rawTokens.slice(1).join(" ");
    if (remainder.length >= 12) {
      return remainder.trim();
    }
  }
  return trimmed;
}

// ── Callsign fuzzy matching ────────────────────────────────────────
// Loads known callsigns from SCCARC roster + recently heard callsigns.
// Corrects STT-garbled callsigns in transcribed text.

function loadKnownCallsigns(): string[] {
  try {
    const rosterPath = join(homedir(), ".openclaw", "workspace", "references", "sccarc-roster.csv");
    const csv = require("node:fs").readFileSync(rosterPath, "utf8");
    const lines = csv.split("\n").slice(1); // skip header
    const calls: string[] = [];
    for (const line of lines) {
      const call = line.split(",")[0]?.trim().toUpperCase();
      if (call && /^[A-Z]{1,2}\d{1,4}[A-Z]{1,4}$/.test(call)) {
        calls.push(call);
      }
    }
    return calls;
  } catch {
    return [];
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function fuzzyMatchCallsign(garbled: string, knownCallsigns: string[], maxDistance = 2): string | null {
  const upper = garbled.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!upper || upper.length < 3) return null;

  // Exact match — no correction needed
  if (knownCallsigns.includes(upper)) return null;

  let bestMatch: string | null = null;
  let bestDist = maxDistance + 1;

  for (const known of knownCallsigns) {
    const dist = levenshtein(upper, known);
    if (dist > 0 && dist < bestDist) {
      bestDist = dist;
      bestMatch = known;
    }
  }

  return bestMatch;
}

// Regex to find callsign-like patterns in text (may be garbled)
const CALLSIGN_PATTERN = /\b[A-Z]{1,2}\d{1,4}[A-Z]{0,4}\b/gi;

function correctCallsignsInText(text: string, knownCallsigns: string[], log?: any): string {
  if (!knownCallsigns.length) return text;

  return text.replace(CALLSIGN_PATTERN, (match) => {
    const correction = fuzzyMatchCallsign(match, knownCallsigns);
    if (correction && correction !== match.toUpperCase()) {
      log?.info?.(`[digirig] callsign corrected: "${match}" → "${correction}"`);
      return correction;
    }
    return match;
  });
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
    const tts = await synthesizeTts(runtime, text);
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

    const MAX_TX_ATTEMPTS = 3;
    const BACKOFF_MS = 1200;
    try {
      let transmitted = false;
      for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt++) {
        const waitResult = await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 60000);
        if (waitResult === "timeout") {
          logger?.warn?.(`[digirig] TX abandoned: channel busy for 60s (attempt ${attempt}/${MAX_TX_ATTEMPTS})`);
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
              await delay(BACKOFF_MS);
              continue;
            }
          }
        }

        await delay(50);
        if (audioMonitor.isCarrierPresent()) {
          logger?.info?.(`[digirig] TX deferred: carrier detected at final 50ms check (attempt ${attempt}/${MAX_TX_ATTEMPTS}, energy=${audioMonitor.getLastEnergy().toFixed(6)})`);
          await delay(BACKOFF_MS);
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
          audioMonitor.muteFor(1500);
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
        logger?.warn?.(`[digirig] TX dropped after ${MAX_TX_ATTEMPTS} attempts: "${text.slice(0, 80)}..."`);
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

    const waitResult = await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 60000);
    if (waitResult === "timeout") throw new Error("Channel busy for 60s");
    if (audioMonitor.isCarrierPresent()) throw new Error("Carrier detected");

    await ptt.open();
    await ptt.setTx(true);
    if (config.ptt.leadMs > 0) {
      const listenMs = Math.max(30, config.ptt.leadMs - 30);
      await delay(listenMs);
      if (audioMonitor.isCarrierPresent() || audioMonitor.getBusy()) {
        await ptt.setTx(false);
        throw new Error("Carrier detected during lead delay");
      }
      const remaining = config.ptt.leadMs - listenMs;
      if (remaining > 0) await delay(remaining);
    }

    audioMonitor.muteFor(muteMs);
    try {
      await playPcm({ device: config.audio.outputDevice, sampleRate, channels: 1, pcm, signal: abortSignal });
    } finally {
      if (config.ptt.tailMs > 0) await delay(config.ptt.tailMs);
      await ptt.setTx(false);
      audioMonitor.muteFor(1500);
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
      if (lastTxAt > lastIdTxAt && Date.now() - lastIdTxAt >= 10 * 60 * 1000) {
        ctx.log?.info?.("[digirig] 10-minute FCC ID timer triggered.");
        await speak(`This is ${config.tx.callsign} standing by.`);
      }
    }, 60000);

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
          const localCfg = (config.stt as any)?.localWhisper ?? {};
          const rawText = await transcribeWithLocalWhisper({
            pcm16: job.utterance.pcm,
            sampleRate: job.utterance.sampleRate ?? config.audio.sampleRate,
            log: ctx.log,
            command: typeof localCfg.command === "string" ? localCfg.command : "whisper",
            model: typeof localCfg.model === "string" ? localCfg.model : "base",
            language: typeof (config.stt as any)?.language === "string" ? (config.stt as any).language : "en",
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

          const signalReport = job.rmsDb
            ? `\n[System Data: incoming audio signal strength was RMS ${job.rmsDb.toFixed(1)} dBFS, Peak ${job.peakDb?.toFixed(1)} dBFS. A signal around -20 is loud, -40 is soft, and below -50 is very weak/noisy.]`
            : "";
          const radioPrompt = `${HAM_RADIO_PROMPT}\n\n${signalReport}`;
          const ctxPayload = createRadioContextPayload(runtime, cfg, route, job.text, radioPrompt);

          await recordInboundSession(runtime, cfg, route, ctxPayload, ctx.log);

          const dispatchStartAt = Date.now();
          let firstPttAt = 0;
          let speakMs = 0;
          let didSpeak = false;
          let detectedSender: string | null = null;

          ctx.log?.info?.(`[digirig] dispatch reply start session=${job.sessionId}`);
          
          let tonesTimer: NodeJS.Timeout | null = null;
          if (config.tones?.enabled) {
            tonesTimer = setTimeout(() => {
              tonesTimer = null;
              if (didSpeak) return; // Voice beat the timer
              
              // Timer popped, inject acknowledgment beep
              const standbyPcm = AudioAssets.get("standby") || AudioAssets.get("beep");
              if (standbyPcm) {
                ctx.log?.info?.(`[digirig] Latency timeout hit, injecting standby tone...`);
                // Use unshift to jump the queue!
                txQueue.unshift({
                  kind: "raw",
                  pcm: standbyPcm,
                  sampleRate: config.audio.sampleRate,
                  label: "standby"
                });
              }
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
                if (baseSender && /^[A-Z]{1,2}\d{1,4}[A-Z]{1,4}$/.test(baseSender)) heardCallsigns.add(baseSender);
              }

              const shortReply = formatRadioReply(replyText);
              if (!shortReply || !isSpeakableStreamingReply(shortReply)) return;

              let txText = shortReply;
              if (Date.now() - lastIdTxAt > 9 * 60 * 1000) txText = appendCallsign(shortReply, config.tx.callsign);
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
          
          // Check for LLM dispatch failures to play error tone
          if (config.tones?.enabled && (!dispatchResult || dispatchResult.finalText === undefined)) {
            const errorPcm = AudioAssets.get("error");
            if (errorPcm) {
              ctx.log?.info?.(`[digirig] Dispatch failed, playing error tone...`);
              txQueue.unshift({
                kind: "raw",
                pcm: errorPcm,
                sampleRate: config.audio.sampleRate,
                label: "error"
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
        try {
          if (job.kind === "text") {
            logger?.info?.(`[digirig] Audio input: ${job.text}`);
            await executeTextTx(job.text, job.hooks);
          } else {
            await executeRawTx(job.pcm, job.sampleRate, job.label);
          }
          job.done?.resolve();
        } catch (err) {
          logger?.error?.(`[digirig] TX sequence failed: ${String(err)}`);
          try { await ptt.setTx(false); } catch {}
          audioMonitor.muteFor(1500);
          job.done?.reject(err);
        } finally {
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

    const TX_API_PORT = 18089;
    try {
      txApiServer = http.createServer((req, res) => {
        if (req.method === "GET" && req.url?.startsWith("/tx/status")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, txInProgress }));
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
              await enqueueTxJob({ kind: "raw", pcm, sampleRate });
              const bytesPerMs = sampleRate * 2 / 1000;
              const audioMs = bytesPerMs > 0 ? Math.ceil(pcm.length / bytesPerMs) : 0;
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

  return { start, stop, speak };
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

  // 1) Attempt to use the hot-loaded STT daemon (Ultra-fast, ~0.5s latency)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s inference timeout
    const res = await fetch("http://127.0.0.1:18088/transcribe", {
      method: "POST",
      body: wavBuffer,
      headers: { "Content-Type": "audio/wav" },
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (res.ok) {
      const json = await res.json() as { text?: string };
      log?.info?.(`[digirig] STT source: hot-loaded daemon (ultra-fast)`);
      return (json.text || "").trim();
    }
  } catch (err: any) {
    // If ECONNREFUSED or aborted, the daemon isn't running. Fall back silently.
    if (err.name !== "TypeError" && err.code !== "ECONNREFUSED") {
      log?.warn?.(`[digirig] STT daemon failed, falling back to cold-start CLI: ${String(err)}`);
    }
  }

  // 2) Fallback to the cold-start CLI execution (Slower, ~3s latency)
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
