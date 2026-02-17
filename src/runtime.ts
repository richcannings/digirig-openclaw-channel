import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createReplyPrefixOptions, type ChannelGatewayStartContext } from "openclaw/plugin-sdk";
import { getDigirigRuntime } from "./state.js";
import type { DigirigConfig } from "./config.js";
import { AudioMonitor } from "./audio-monitor.js";
import { PttController } from "./ptt.js";
import { runSttStream } from "./stt.js";
import { pcmToWav } from "./wav.js";
import { playPcm, synthesizeTts } from "./tts.js";
import { WhisperServerManager } from "./whisper-server.js";

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


export type DigirigRuntime = {
  start: (ctx: ChannelGatewayStartContext<DigirigConfig>) => Promise<{ stop: () => void }>;
  stop: () => Promise<void>;
  speak: (text: string) => Promise<void>;
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

  let whisperServer: WhisperServerManager | null = null;

  let stopped = false;
  let outboundQueue: Promise<void> = Promise.resolve();
  const logDir = join(homedir(), ".openclaw", "logs");
  const logDate = new Date().toISOString().slice(0, 10);
  const logPath = join(logDir, `digirig-${logDate}.log`);
  let logger: ChannelGatewayStartContext<DigirigConfig>["log"] | null = null;

  const appendTranscript = async (line: string) => {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logPath, `${line}\n`);
  };

  const logDupe = async (line: string) => {
    await fs.mkdir(logDir, { recursive: true });
    const dupePath = join(logDir, `digirig-dupe-${logDate}.log`);
    await fs.appendFile(dupePath, `${line}\n`);
  };
  const loadIdentityAliases = async (): Promise<string[]> => {
    try {
      const identityPath = join(homedir(), ".openclaw", "workspace", "IDENTITY.md");
      const content = await fs.readFile(identityPath, "utf8");
      const aliases = new Set<string>();
      for (const line of content.split(/\r?\n/)) {
        const nameMatch = line.match(/^-\s*\*\*Name:\*\*\s*(.+)\s*$/i);
        if (nameMatch?.[1]) aliases.add(nameMatch[1].trim());
        const akaMatch = line.match(/aka\s+([^\)]+)\)?/i);
        if (akaMatch?.[1]) {
          for (const part of akaMatch[1].split(/[\/,|]/)) {
            const alias = part.trim();
            if (alias) aliases.add(alias);
          }
        }
      }
      return Array.from(aliases);
    } catch {
      return [];
    }
  };

  let rxBuffer: string[] = [];
  let rxStartAt = 0;
  let rxFinalizeTimer: NodeJS.Timeout | null = null;
  let rxFinalized = false;
  let rxSessionId = 0;
  let lastRxEndAt = 0;
  let lastRxEndReason: string | null = null;
  let rxChunks: string[] = [];
  let inferredAliases: string[] = [];

  const logTranscript = async (speaker: "RX" | "TX", text: string) => {
    if (!text.trim()) return;
    const ts = new Date().toISOString();
    await appendTranscript(`[${ts}] ${speaker}: ${text.trim()}`);
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
    if (stopped) {
      return { stop: () => {} };
    }
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

    if (!config.tx.aliases || !config.tx.aliases.trim()) {
      inferredAliases = await loadIdentityAliases();
      if (inferredAliases.length) {
        ctx.log?.info?.(`[digirig] tx.aliases inferred: ${inferredAliases.join(", ")}`);
      }
    }

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
    let recordingFrames: Buffer[] = [];
    let streamTimer: NodeJS.Timeout | null = null;
    let streamInFlight = false;
    let sttInFlight = false;
    let latestStreamText = "";
    const streamEnabled = true;
    const frameBytes = Math.floor(
      (config.audio.sampleRate * 1 * 2 * config.rx.frameMs) / 1000,
    );
    const streamWindowFrames = Math.max(
      1,
      Math.ceil(config.stt.streamWindowMs / config.rx.frameMs),
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
      ctx.log?.info?.(`[digirig] finalizeRx session=${rxSessionId} reason=${lastRxEndReason ?? 'unknown'} bufferChunks=${rxBuffer.length} rxChunks=${rxChunks.length} latestStreamLen=${latestStreamText?.length ?? 0}`);
      const chunkText = normalizeSttText(rxBuffer.join(" "));
      if (!chunkText) {
        rxBuffer = [];
        if (rxChunks.length === 0) rxStartAt = 0;
        return;
      }

      if (lastRxEndReason === "maxRecord") {
        const bufLen = rxBuffer.length;
        const chunkSource = normalizeSttText(latestStreamText) || chunkText;
        if (chunkSource) {
          rxChunks.push(chunkSource);
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
      const parsedAliases = parseAliases(config.tx.aliases);
      const aliasList = parsedAliases.length ? parsedAliases : inferredAliases;
      const direct = isDirectCall(text, config.tx.callsign, aliasList);
      ctx.log?.info?.(
        `[digirig] finalize routing: direct=${direct} policy=${policy} aliases=${aliasList.join(",")} routeSession=${route.sessionKey ?? "?"}`,
      );
      const closingRegex = /\b(thanks|thank you|that's it|that\s+is\s+it|73|seven\s+three|clear|goodbye|bye|signing\s+off)\b/i;
      const isClosing = closingRegex.test(text);
      if (policy === "direct-only" && !direct) {
        rxBuffer = [];
        rxStartAt = 0;
        rxFinalized = true;
        return;
      }
      if (policy === "value-and-wait") {
        if (!direct) {
          rxBuffer = [];
          rxStartAt = 0;
          rxFinalized = true;
          return;
        }
        await delay(4000);
      }

      const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const body = runtime.channel.reply.formatAgentEnvelope({
        channel: "DigiRig",
        from: "radio",
        timestamp: Date.now(),
        envelope: envelopeOptions,
        body: text,
      });

      const radioSessionKey = "digirig:radio";
      const radioPrompt = "Radio mode: respond briefly for on-air voice. Do not mention policy, tools, or refusal; just answer or acknowledge.";
      const ctxPayload = runtime.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: text,
        CommandBody: text,
        BodyForAgent: `${radioPrompt}\n\n${text}`,
        BodyForCommands: text,
        CommandSource: "channel",
        CommandTargetSessionKey: radioSessionKey,
        From: "digirig:radio",
        To: "digirig:radio",
        SessionKey: radioSessionKey,
        AccountId: route.accountId,
        ChatType: "direct",
        ConversationLabel: "radio",
        SenderName: "radio",
        SenderId: "radio",
        Provider: "digirig",
        Surface: "digirig",
        MessageSid: `digirig-${Date.now()}`,
        OriginatingChannel: "digirig",
        OriginatingTo: "digirig:radio",
        CommandAuthorized: true,
      });

      const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });
      await runtime.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err) =>
          ctx.log?.error?.(`[digirig] session record error: ${String(err)}`),
      });

      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId: route.agentId,
        channel: "digirig",
        accountId: route.accountId,
      });

      const dispatchStartAt = Date.now();
      const rxEndAtSnapshot = lastRxEndAt;
      let firstTxAt = 0;
      let speakMs = 0;
      let didSpeak = false;
      ctx.log?.info?.(`[digirig] dispatch reply start session=${rxSessionId} direct=${direct} routeSession=${route.sessionKey ?? "?"}`);
      const dispatchResult = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...prefixOptions,
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
            if (/can.?t transmit|policy not proactive|tx policy/i.test(shortReply)) {
              ctx.log?.info?.("[digirig] deliver suppressed (policy refusal)");
              const fallbackText = appendCallsign("Received.", config.tx.callsign);
              didSpeak = true;
              if (!firstTxAt) {
                firstTxAt = Date.now();
              }
              const fallbackStartAt = Date.now();
              await speak(fallbackText);
              speakMs = Date.now() - fallbackStartAt;
              return;
            }
            const txText = appendCallsign(shortReply, config.tx.callsign);
            ctx.log?.info?.(`[digirig] reply deliver: ${txText}`);
            didSpeak = true;
            if (!firstTxAt) {
              firstTxAt = Date.now();
            }
            if (isClosing && /\bcopy\b/i.test(shortReply)) {
              ctx.log?.info?.("[digirig] TX replaced (closing)");
              const closingText = appendCallsign("Thanks, seven three.", config.tx.callsign);
              await speak(closingText);
              return;
            }
            const speakStartAt = Date.now();
            await speak(txText);
            speakMs = Date.now() - speakStartAt;
          },
          onError: (err, info) =>
            ctx.log?.error?.(`[digirig] ${info.kind} reply failed: ${String(err)}`),
        },
        replyOptions: {
          onModelSelected,
          onAgentRunStart: (runId) => ctx.log?.info?.(`[digirig] agent run start: ${runId}`),
          disableBlockStreaming: true,
        },
      });
      const dispatchEndAt = Date.now();
      const counts = dispatchResult?.counts ?? {};
      const lastReplyLen = dispatchResult?.finalText?.length ?? 0;
      ctx.log?.info?.(`[digirig] dispatch result counts=${JSON.stringify(counts)} finalLen=${lastReplyLen}`);
      if (direct && !firstTxAt && !didSpeak) {
        ctx.log?.warn?.(`[digirig] no final reply delivered; fallback ack (counts=${JSON.stringify(counts)} finalLen=${lastReplyLen})`);
        const fallbackText = appendCallsign("Received.", config.tx.callsign);
        const fallbackStartAt = Date.now();
        await speak(fallbackText);
        if (!firstTxAt) {
          firstTxAt = Date.now();
        }
        speakMs = Date.now() - fallbackStartAt;
      }
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
        const metricTs = new Date().toISOString();
        ctx.log?.info?.(`[digirig] responseTimeMs=${responseTimeMs}`);
        await appendTranscript(`[${metricTs}] METRIC: responseTimeMs=${responseTimeMs}`);
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
      if (streamTimer) {
        clearInterval(streamTimer);
        streamTimer = null;
      }
      if (reason === "maxRecord") {
        void finalizeRx();
        return;
      }
      scheduleFinalizeRx();
    });

    audioMonitor.on("recording-frame", (frame: Buffer) => {
      if (!frameBytes || frame.length !== frameBytes) return;
      recordingFrames.push(frame);
      if (recordingFrames.length > streamWindowFrames * 4) {
        recordingFrames = recordingFrames.slice(-streamWindowFrames * 2);
      }
    });

    audioMonitor.on("recording-start", () => {
      recordingFrames = [];
      latestStreamText = "";
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
      if (streamEnabled) {
        ctx.log?.info?.("[digirig] STT stream start");
        if (streamTimer) clearInterval(streamTimer);
        streamTimer = setInterval(async () => {
          if (streamInFlight) return;
          streamInFlight = true;
          try {
            const frames = recordingFrames.slice(-streamWindowFrames);
            if (!frames.length) return;
            const pcm = Buffer.concat(frames);
            const wav = pcmToWav(pcm, config.audio.sampleRate, 1);
            const rawText = await runSttStream({ config: config.stt, wavBuffer: wav });
            const text = normalizeSttText(rawText);
            if (text) {
              latestStreamText = text;
              ctx.log?.info?.(`[digirig] STT stream text len=${text.length} session=${rxSessionId}`);
            }
          } catch (err) {
            ctx.log?.debug?.(`[digirig] STT stream error: ${String(err)}`);
          } finally {
            streamInFlight = false;
          }
        }, config.stt.streamIntervalMs);
      } else {
        if (streamTimer) {
          clearInterval(streamTimer);
          streamTimer = null;
        }
      }
    });

    audioMonitor.on("utterance", async (utterance) => {
      if (rxFinalized) {
        return;
      }
      sttInFlight = true;
      try {
        const rxEndAt = lastRxEndAt || Date.now();
        const utteranceStartAt = Date.now();
        const wav = pcmToWav(utterance.pcm, utterance.sampleRate, utterance.channels);
        const sttStartAt = Date.now();
        ctx.log?.info?.(
          `[digirig] STT start (rxToSttStartMs=${sttStartAt - rxEndAt})`,
        );
        let text = latestStreamText;
        const needsFullStt = !text.trim() || text.trim().length < 24;
        ctx.log?.info?.(`[digirig] STT decision session=${rxSessionId} latestLen=${text?.length ?? 0} needsFullStt=${needsFullStt}`);
        if (needsFullStt) {
          try {
            const rawText = await runSttStream({
              config: { ...config.stt, timeoutMs: Math.min(config.stt.timeoutMs, 5000) },
              wavBuffer: wav,
            });
            text = normalizeSttText(rawText);
          } catch (err) {
            ctx.log?.error?.(`[digirig] STT stream failed: ${String(err)}`);
          }
        } else {
          runSttStream({
            config: { ...config.stt, timeoutMs: Math.min(config.stt.timeoutMs, 5000) },
            wavBuffer: wav,
          })
            .then((fresh) => {
              const normalized = normalizeSttText(fresh);
              if (normalized) latestStreamText = normalized;
            })
            .catch((err) =>
              ctx.log?.debug?.(`[digirig] STT stream refresh failed: ${String(err)}`),
            );
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
          if (lowerLast.endsWith(" usb") && (lowerText.startsWith("c ") || lowerText.startsWith("c-"))) {
            rxBuffer[rxBuffer.length - 1] = `${lastFragment} ${normalizedRx}`;
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

    ctx.log?.info?.(
      `[digirig] STT server config: command=${config.stt.server.command} args=${config.stt.server.args} modelPath=${config.stt.server.modelPath} host=${config.stt.server.host} port=${config.stt.server.port} streamUrl=${config.stt.streamUrl}`,
    );
    whisperServer = new WhisperServerManager(
      {
        ...config.stt.server,
        streamUrl: config.stt.streamUrl,
      },
      (msg) => ctx.log?.info?.(msg),
    );
    try {
      await whisperServer.ensureRunning();
    } catch (err) {
      const errText = String(err);
      ctx.log?.error?.(`[digirig] whisper-server ensure failed: ${errText}`);
      updateStatus({ lastError: errText });
    }
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
        stopped = true;
        audioMonitor.stop();
        void whisperServer?.stop();
        updateStatus({
          running: false,
          connected: false,
          lastStopAt: Date.now(),
        });
      },
    };
  };

  const stop = async () => {
    stopped = true;
    audioMonitor.stop();
    await whisperServer?.stop();
    await ptt.close();
  };

  return { start, stop, speak };
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
