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

export type DigirigRuntime = {
  start: (ctx: ChannelGatewayStartContext<DigirigConfig>) => Promise<{ stop: () => void }>;
  stop: () => Promise<void>;
  speak: (text: string) => Promise<void>;
};

export async function createDigirigRuntime(config: DigirigConfig): Promise<DigirigRuntime> {
  const runtime = getDigirigRuntime();
  const audioMonitor = new AudioMonitor({
    device: config.audio.device,
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
    outboundQueue = outboundQueue.then(async () => {
      await waitForClearChannel(audioMonitor, config.rx.busyHoldMs, 2000);
      await ptt.withTx(async () => {
        const tts = await synthesizeTts(runtime, text);
        await playPcm({
          device: config.audio.device,
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
        if (!text.trim()) {
          return;
        }

        await runtime.channel.reply.handleInboundMessage({
          channel: "digirig",
          accountId: "default",
          senderId: "radio",
          chatType: "direct",
          chatId: "radio",
          text,
          reply: async (responseText: string) => {
            await speak(responseText);
          },
        });
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
