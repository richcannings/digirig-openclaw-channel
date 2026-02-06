import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelGatewayStartContext } from "openclaw/plugin-sdk";
import { getDigirigRuntime } from "./state.js";
import type { DigirigConfig } from "./config.js";
import { AudioMonitor } from "./audio-monitor.js";
import { PttController } from "./ptt.js";
import { runStt } from "./stt.js";
import { pcmToWav } from "./wav.js";
import { playPcm, synthesizeTts } from "./tts.js";

const CALLSIGN_TEXT = "W6RGC/AI, Whiskey Six Romeo Golf Charlie stroke Alpha India";

export function appendCallsign(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.toUpperCase().includes("W6RGC/AI")) {
    return trimmed;
  }
  return `${trimmed} ${CALLSIGN_TEXT}`;
}

export type DigirigRuntime = {
  start: (ctx: ChannelGatewayStartContext<DigirigConfig>) => Promise<{ stop: () => void }>;
  stop: () => Promise<void>;
  speak: (text: string) => Promise<void>;
};

export async function createDigirigRuntime(config: DigirigConfig): Promise<DigirigRuntime> {
  const runtime = getDigirigRuntime();
  const audioMonitor = new AudioMonitor({
    device: config.audio.inputDevice,
    sampleRate: config.audio.sampleRate,
    channels: config.audio.channels,
    frameMs: config.rx.frameMs,
    preRollMs: config.rx.preRollMs,
    energyThreshold: config.rx.energyThreshold,
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
          channels: config.audio.channels,
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
        const text = await runStt({
          config: config.stt,
          inputPath: filePath,
          sampleRate: utterance.sampleRate,
        });
        await fs.unlink(filePath).catch(() => undefined);
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

        const { dispatcher, replyOptions, markDispatchIdle } =
          runtime.channel.reply.createReplyDispatcherWithTyping({
            deliver: async (payload, info) => {
              if (!payload.text) {
                return;
              }
              const isFinal = info?.kind === "final";
              const txText = isFinal ? appendCallsign(payload.text) : payload.text;
              audioMonitor.muteFor(800);
              await speak(txText);
              audioMonitor.muteFor(800);
            },
            onError: (err, info) =>
              ctx.log?.error?.(`[digirig] ${info.kind} reply failed: ${String(err)}`),
          });

        await runtime.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        });
        markDispatchIdle();
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
