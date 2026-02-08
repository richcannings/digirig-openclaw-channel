import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplyPrefixOptions, type ChannelGatewayStartContext } from "openclaw/plugin-sdk";
import { getDigirigRuntime } from "./state.js";
import type { DigirigConfig } from "./config.js";
import { AudioMonitor } from "./audio-monitor.js";
import { PttController } from "./ptt.js";
import { runStt } from "./stt.js";
import { pcmToWav } from "./wav.js";
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

  let stopped = false;
  let outboundQueue: Promise<void> = Promise.resolve();

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
    audioMonitor.on("recording-end", (evt) =>
      ctx.log?.info?.(`[digirig] RX end (durationMs=${evt?.durationMs ?? "?"})`),
    );
    audioMonitor.on("utterance", async (utterance) => {
      try {
        const wav = pcmToWav(utterance.pcm, utterance.sampleRate, utterance.channels);
        const filePath = join(tmpdir(), `digirig-${Date.now()}.wav`);
        await fs.writeFile(filePath, wav);
        let text = "";
        try {
          text = await runStt({
            config: config.stt,
            inputPath: filePath,
            sampleRate: utterance.sampleRate,
          });
        } finally {
          await fs.unlink(filePath).catch(() => undefined);
        }
        ctx.log?.info?.(`[digirig] STT: ${text || "(empty)"}`);
        if (!text.trim()) {
          return;
        }

        const cfg = runtime.config.loadConfig();
        const route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "digirig",
          accountId: "default",
          peer: {
            kind: "direct",
            id: "radio",
          },
        });

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
              await speak(txText);
              audioMonitor.muteFor(800);
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
        const counts = dispatchResult?.counts ?? {};
        ctx.log?.info?.(
          `[digirig] dispatch reply complete (counts=${JSON.stringify(counts)})`,
        );
      } catch (err) {
        ctx.log?.error?.(`[digirig] inbound error: ${String(err)}`);
      }
    });

    audioMonitor.start();

    return {
      stop: () => {
        stopped = true;
        audioMonitor.stop();
      },
    };
  };

  const stop = async () => {
    stopped = true;
    audioMonitor.stop();
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
