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
import { HAM_RADIO_PROMPT } from "./prompt.js";

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

export async function createDigirigRuntime(config: DigirigConfig): Promise<DigirigRuntime> {
  const runtime = getDigirigRuntime();
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

  let hardStopped = false;
  let started = false;
  let outboundQueue: Promise<void> = Promise.resolve();
  const logDir = join(homedir(), ".openclaw", "logs");
  const logDate = getLocalDateStamp();
  const logPath = join(logDir, `digirig-${logDate}.log`);
  let logger: ChannelGatewayStartContext<DigirigConfig>["log"] | null = null;

  let txInProgress = false;
  let runLoopAbort: AbortController | null = null;

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

  let rxSessionId = 0;
  let lastRxEndAt = 0;
  let lastRxEndReason: string | null = null;
  let lastRxSilenceMs = 0;
  let lastRxDurationMs = 0;

  const logTranscript = async (speaker: "RX" | "TX", text: string, sessionId?: number, extraProps?: Record<string, any>) => {
    if (!text.trim()) return;
    await logEvent({ type: speaker, text: text.trim(), sessionId, ...(extraProps || {}) });
  };

  const speak = async (
    text: string,
    hooks?: { onPttKeyed?: (atMs: number) => void; onAudioStart?: (atMs: number) => void },
  ) => {
    if (!text.trim()) return;
    if (!config.ptt.rts) return;

    outboundQueue = outboundQueue.then(async () => {
      txInProgress = true;
      try {
        const trimmed = text.trim();
        logger?.info?.(`[digirig] Audio input: ${trimmed}`);
        
        // Generate the audio BEFORE keying the radio to prevent dead air.
        const tts = await synthesizeTts(runtime, trimmed);
        const bytesPerMs = tts.sampleRate * 2 / 1000;
        const audioMs = bytesPerMs > 0 ? Math.ceil(tts.audioBuffer.length / bytesPerMs) : 0;
        const muteMs = Math.max(0, config.ptt.leadMs + config.ptt.tailMs + audioMs + 500);

        const txAbortController = new AbortController();
        const maxTxTimer = setTimeout(() => {
          logger?.error?.(`[digirig] CRITICAL: Max TX duration (${config.tx.maxTxMs}ms) exceeded. Forcefully aborting transmission to protect hardware.`);
          txAbortController.abort();
        }, config.tx.maxTxMs);

        const MAX_TX_ATTEMPTS = 3;
        const BACKOFF_MS = 1200; // wait between retry attempts

        try {
          let transmitted = false;

          for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt++) {
            // Check 1: Wait for channel to be clear (holdoff-based)
            const waitResult = await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 60000);
            if (waitResult === "timeout") {
              logger?.warn?.(`[digirig] TX abandoned: channel busy for 60s (attempt ${attempt}/${MAX_TX_ATTEMPTS})`);
              break;
            }

            // Check 2: Final carrier check right before PTT key-up.
            // Sample a short window to confirm no one started transmitting
            // in the gap between waitForClearChannel returning and now.
            if (audioMonitor.isCarrierPresent()) {
              logger?.info?.(`[digirig] TX deferred: carrier detected at final check (attempt ${attempt}/${MAX_TX_ATTEMPTS}, energy=${audioMonitor.getLastEnergy().toFixed(6)})`);
              await delay(BACKOFF_MS);
              continue;
            }

            // PTT key-up — but we split the lead delay to insert Check 3
            await ptt.open();
            await ptt.setTx(true);
            hooks?.onPttKeyed?.(Date.now());

            // Check 3: Listen during lead delay. Key is up but audio hasn't
            // started yet — if we detect carrier now, someone beat us. Abort.
            if (config.ptt.leadMs > 0) {
              // Wait most of the lead time, then sample
              const listenMs = Math.max(30, config.ptt.leadMs - 30);
              await delay(listenMs);

              // Clear the mute briefly to let the monitor hear the channel
              // (it's not muted yet — muteFor hasn't been called)
              if (audioMonitor.isCarrierPresent() || audioMonitor.getBusy()) {
                logger?.info?.(`[digirig] TX aborted mid-key: carrier detected during lead delay (attempt ${attempt}/${MAX_TX_ATTEMPTS}, energy=${audioMonitor.getLastEnergy().toFixed(6)})`);
                await ptt.setTx(false);
                await delay(BACKOFF_MS);
                continue;
              }

              // Remaining lead delay
              const remaining = config.ptt.leadMs - listenMs;
              if (remaining > 0) await delay(remaining);
            }

            // All clear — commit to transmission
            audioMonitor.muteFor(muteMs);
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
              // Mute the microphone for an additional 1500ms after the audio finishes playing
              // to completely ignore the hardware PTT unkey "pop" and the radio's own squelch tail.
              audioMonitor.muteFor(1500);
            }

            await logTranscript("TX", trimmed);
            transmitted = true;
            break;
          }

          if (!transmitted) {
            logger?.warn?.(`[digirig] TX dropped after ${MAX_TX_ATTEMPTS} attempts: "${trimmed.slice(0, 80)}..."`);
          }
        } finally {
          clearTimeout(maxTxTimer);
        }
      } catch (err) {
        logger?.error?.(`[digirig] TX sequence failed: ${String(err)}`);
        // Safety: ensure PTT is unkeyed on any unexpected error
        try { await ptt.setTx(false); } catch { /* ignore */ }
        audioMonitor.muteFor(1500);
      } finally {
        txInProgress = false;
      }
    });
    await outboundQueue;
  };

  const start = async (ctx: ChannelGatewayStartContext<DigirigConfig>) => {
    if (hardStopped || started) return;
    started = true;
    logger = ctx.log ?? null;
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

    audioMonitor.on("utterance", async (utterance: any) => {
      if (txInProgress || utterance.reason === "tx" || lastRxEndReason === "tx") {
        ctx.log?.info?.("[digirig] utterance ignored (aborted by TX mute)");
        return;
      }
      
      const sttStartAt = Date.now();
      const currentSessionId = rxSessionId;
      
      try {
        const localCfg = (config.stt as any)?.localWhisper ?? {};
        const rawText = await transcribeWithLocalWhisper({
          pcm16: utterance.pcm,
          sampleRate: utterance.sampleRate ?? config.audio.sampleRate,
          log: ctx.log,
          command: typeof localCfg.command === "string" ? localCfg.command : "whisper",
          // For powerful hardware (e.g. RTX 3060+), consider "medium.en" or "large-v3" for high accuracy over RF noise.
          model: typeof localCfg.model === "string" ? localCfg.model : "base",
          language: typeof (config.stt as any)?.language === "string" ? (config.stt as any).language : "en",
        });
        const text = normalizeSttText(rawText);
        const sttEndAt = Date.now();

        ctx.log?.info?.(`[digirig] STT: ${text || "(empty)"}`);
        if (!text.trim()) return;

        await logTranscript("RX", text, currentSessionId, {
          rmsDb: Number(utterance.rmsDb?.toFixed(1)),
          peakDb: Number(utterance.peakDb?.toFixed(1)),
        });
        updateStatus({ lastInboundAt: Date.now() });

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
        const direct = isDirectCall(text, config.tx.callsign, aliasList);
        ctx.log?.info?.(
          `[digirig] routing: direct=${direct} policy=${policy} aliases=${aliasList.join(",")} routeSession=${route.sessionKey ?? "?"}`
        );
        
        if (policy === "direct-only" && !direct) {
          return;
        }

        const signalReport = utterance.rmsDb ? `\n[System Data: incoming audio signal strength was RMS ${utterance.rmsDb.toFixed(1)} dBFS, Peak ${utterance.peakDb.toFixed(1)} dBFS. A signal around -20 is loud, -40 is soft, and below -50 is very weak/noisy.]` : "";
        const radioPrompt = `${HAM_RADIO_PROMPT}\n\n${signalReport}`;
        const ctxPayload = createRadioContextPayload(runtime, cfg, route, text, radioPrompt);

        await recordInboundSession(runtime, cfg, route, ctxPayload, ctx.log);

        const dispatchStartAt = Date.now();
        let firstPttAt = 0;
        let firstAudioAt = 0;
        let speakMs = 0;
        let didSpeak = false;
        
        ctx.log?.info?.(`[digirig] dispatch reply start session=${currentSessionId}`);
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
            
            const shortReply = formatRadioReply(payload.text);
            if (!shortReply) return;
            if (!isSpeakableStreamingReply(shortReply)) return;
            
            const txText = appendCallsign(shortReply, config.tx.callsign);
            ctx.log?.info?.(`[digirig] reply deliver: ${txText}`);
            didSpeak = true;
            
            const speakStartAt = Date.now();
            await speak(txText, {
              onPttKeyed: (atMs) => { if (!firstPttAt) firstPttAt = atMs; },
              onAudioStart: (atMs) => { if (!firstAudioAt) firstAudioAt = atMs; },
            });
            speakMs = Date.now() - speakStartAt;
          },
        });
        const dispatchEndAt = Date.now();
        const counts = dispatchResult?.counts ?? {};
        
        ctx.log?.info?.(`[digirig] dispatch result counts=${JSON.stringify(counts)} finalLen=${dispatchResult?.finalText?.length ?? 0}`);
        
        const rxEndAt = lastRxEndAt;
        const responseTimeMs = firstPttAt && rxEndAt ? Math.max(0, firstPttAt - rxEndAt) : null;
        
        const timing = {
          rxDurationMs: lastRxDurationMs || null,
          rxSilenceMs: lastRxSilenceMs || null,
          sttMs: sttEndAt - sttStartAt,
          routeMs: routeEndAt - routeStartAt,
          dispatchMs: dispatchEndAt - dispatchStartAt,
          responseTimeMs,
          speakMs: speakMs || null,
          totalRxToDoneMs: rxEndAt ? dispatchEndAt - rxEndAt : null,
        };
        ctx.log?.info?.(`[digirig] dispatch reply complete (counts=${JSON.stringify(counts)} timing=${JSON.stringify(timing)})`);
        await logEvent({
          type: "METRIC",
          sessionId: currentSessionId,
          ...timing,
        });
      } catch (err) {
        ctx.log?.error?.(`[digirig] utterance processing error: ${String(err)}`);
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
