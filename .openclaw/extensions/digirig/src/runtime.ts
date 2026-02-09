import { promises as fs } from "node:fs";
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

  const appendTranscript = async (line: string) => {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logPath, `${line}\n`);
  };

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
    outboundQueue = outboundQueue.then(async () => {
      await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 2000);
      await ptt.withTx(async () => {
        const tts = await synthesizeTts(runtime, text);
        await playPcm({
          device: config.audio.outputDevice,
          sampleRate: tts.sampleRate,
          channels: 1,
          pcm: tts.audioBuffer,
        });
      });
    });
    await outboundQueue;
  };

  const start = async (ctx: ChannelGatewayStartContext<DigirigConfig>) => {
    if (stopped) {
      return { stop: () => {} };
    }

    audioMonitor.on("log", (msg) => ctx.log?.debug?.(`[digirig] ${msg}`));
    audioMonitor.on("error", (err) => ctx.log?.error?.(`[digirig] ${String(err)}`));
    audioMonitor.on("recording-start", (evt) =>
      ctx.log?.info?.(`[digirig] RX start (energy=${evt?.energy?.toFixed?.(4) ?? "?"})`),
    );
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
        const sttEndAt = Date.now();
        ctx.log?.info?.(`[digirig] STT: ${text || "(empty)"}`);
        await logTranscript("RX", text);
        if (!text.trim()) {
          return;
        }

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
              audioMonitor.muteFor(800);
              if (!firstTxAt) {
                firstTxAt = Date.now();
              }
              const speakStartAt = Date.now();
              await speak(txText);
              speakMs = Date.now() - speakStartAt;
              audioMonitor.muteFor(800);
              await logTranscript("TX", txText);
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
      ctx.log?.error?.(`[digirig] whisper-server ensure failed: ${String(err)}`);
    }
    audioMonitor.start();

    return {
      stop: () => {
        stopped = true;
        audioMonitor.stop();
        void whisperServer?.stop();
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
