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

function isDirectCall(text: string, callsign?: string): boolean {
  const upper = text.toUpperCase();
  if (upper.includes("OVERLORD")) return true;
  if (!callsign) return false;
  const call = callsign.toUpperCase();
  if (upper.includes(call)) return true;
  const callBare = call.replace(/[^A-Z0-9]/g, "");
  const textBare = upper.replace(/[^A-Z0-9]/g, "");
  return callBare.length > 0 && textBare.includes(callBare);
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

  let lastRxText = "";
  let lastRxAt = 0;

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
      await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 2000);
      await ptt.withTx(async () => {
        const tts = await synthesizeTts(runtime, text);
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
      await logTranscript("TX", text.trim());
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

    audioMonitor.on("log", (msg) => ctx.log?.debug?.(`[digirig] ${msg}`));
    audioMonitor.on("error", (err) => {
      ctx.log?.error?.(`[digirig] ${String(err)}`);
      updateStatus({ lastError: String(err) });
    });
    audioMonitor.on("recording-start", (evt) => {
      ctx.log?.info?.(`[digirig] RX start (energy=${evt?.energy?.toFixed?.(4) ?? "?"})`);
      updateStatus({ lastEventAt: Date.now() });
    });
    let lastRxEndAt = 0;
    let recordingFrames: Buffer[] = [];
    let streamTimer: NodeJS.Timeout | null = null;
    let streamInFlight = false;
    let latestStreamText = "";
    const frameBytes = Math.floor(
      (config.audio.sampleRate * 1 * 2 * config.rx.frameMs) / 1000,
    );
    const streamWindowFrames = Math.max(
      1,
      Math.ceil(config.stt.streamWindowMs / config.rx.frameMs),
    );

    audioMonitor.on("recording-end", (evt) => {
      lastRxEndAt = Date.now();
      const reason = evt?.reason ?? "?";
      const silenceMs = evt?.silenceMs ?? "?";
      ctx.log?.info?.(
        `[digirig] RX end (durationMs=${evt?.durationMs ?? "?"}, silenceMs=${silenceMs}, reason=${reason})`,
      );
      if (streamTimer) {
        clearInterval(streamTimer);
        streamTimer = null;
      }
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
          const text = normalizeSttText(
            await runSttStream({ config: config.stt, wavBuffer: wav }),
          );
          if (text) latestStreamText = text;
        } catch (err) {
          ctx.log?.debug?.(`[digirig] STT stream error: ${String(err)}`);
        } finally {
          streamInFlight = false;
        }
      }, config.stt.streamIntervalMs);
    });

    audioMonitor.on("utterance", async (utterance) => {
      try {
        const rxEndAt = lastRxEndAt || Date.now();
        const utteranceStartAt = Date.now();
        const wav = pcmToWav(utterance.pcm, utterance.sampleRate, utterance.channels);
        const sttStartAt = Date.now();
        ctx.log?.info?.(
          `[digirig] STT start (rxToSttStartMs=${sttStartAt - rxEndAt})`,
        );
        let text = latestStreamText;
        if (!text.trim()) {
          try {
            text = normalizeSttText(
              await runSttStream({
                config: { ...config.stt, timeoutMs: Math.min(config.stt.timeoutMs, 5000) },
                wavBuffer: wav,
              }),
            );
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

        // Join short suffix fragments like "C connector" when the previous RX ended in "USB".
        if (text && Date.now() - lastRxAt < 12000) {
          const last = lastRxText.trim();
          const lowerLast = last.toLowerCase();
          const lowerText = text.toLowerCase();
          if (lowerLast.endsWith(" usb") && (lowerText.startsWith("c ") || lowerText.startsWith("c-"))) {
            text = `${last} ${text}`;
          }
        }
        const sttEndAt = Date.now();
        ctx.log?.info?.(`[digirig] STT: ${text || "(empty)"}`);
        if (!text.trim()) {
          return;
        }

        const normalizedRx = normalizeSttText(text);
        if (!normalizedRx) {
          return;
        }
        lastRxText = normalizedRx;
        lastRxAt = Date.now();
        await logTranscript("RX", normalizedRx);
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
        const direct = isDirectCall(text, config.tx.callsign);
        if (policy === "direct-only" && !direct) {
          ctx.log?.info?.("[digirig] TX blocked by policy (direct-only)");
          return;
        }
        if (policy === "value-and-wait") {
          if (!direct) {
            ctx.log?.info?.("[digirig] TX blocked by policy (value-and-wait)");
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

        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: text,
          CommandBody: text,
          BodyForAgent: text,
          BodyForCommands: text,
          CommandSource: "channel",
          CommandTargetSessionKey: route.sessionKey,
          From: "digirig:radio",
          To: "digirig:radio",
          SessionKey: route.sessionKey,
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
        let firstTxAt = 0;
        let speakMs = 0;
        ctx.log?.info?.("[digirig] dispatch reply start");
        const dispatchResult = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            ...prefixOptions,
            deliver: async (payload) => {
              if (!payload.text) {
                return;
              }
              const shortReply = formatRadioReply(payload.text);
              if (!shortReply) {
                return;
              }
              const txText = appendCallsign(shortReply, config.tx.callsign);
              ctx.log?.info?.(`[digirig] reply deliver: ${txText}`);
              if (!firstTxAt) {
                firstTxAt = Date.now();
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
        const timing = {
          rxToSttStartMs: sttStartAt - rxEndAt,
          sttMs: sttEndAt - sttStartAt,
          routeMs: routeEndAt - routeStartAt,
          dispatchMs: dispatchEndAt - dispatchStartAt,
          rxToFirstTxMs: firstTxAt ? firstTxAt - rxEndAt : null,
          speakMs: speakMs || null,
          totalRxToDoneMs: dispatchEndAt - rxEndAt,
          totalUtteranceToDoneMs: dispatchEndAt - utteranceStartAt,
        };
        ctx.log?.info?.(
          `[digirig] dispatch reply complete (counts=${JSON.stringify(counts)} timing=${JSON.stringify(timing)})`,
        );
      } catch (err) {
        ctx.log?.error?.(`[digirig] inbound error: ${String(err)}`);
      }
    });

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
