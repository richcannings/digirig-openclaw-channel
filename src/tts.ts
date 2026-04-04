import { spawn } from "node:child_process";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

export async function synthesizeTts(runtime: PluginRuntime, text: string): Promise<{
  audioBuffer: Buffer;
  sampleRate: number;
}> {
  if (!runtime.tts?.textToSpeechTelephony) {
    throw new Error("TTS runtime not available (textToSpeechTelephony missing)");
  }

  const result = await runtime.tts.textToSpeechTelephony({
    text,
    cfg: runtime.config,
  });

  if (!result.success || !result.audioBuffer || !result.sampleRate) {
    throw new Error(result.error ?? "TTS failed");
  }

  return { audioBuffer: result.audioBuffer, sampleRate: result.sampleRate };
}

export async function playPcm(params: {
  device: string;
  sampleRate: number;
  channels: number;
  pcm: Buffer;
  signal?: AbortSignal;
}): Promise<void> {
  const { device, sampleRate, channels, pcm, signal } = params;

  if (signal?.aborted) {
    throw new Error("playPcm aborted before start");
  }

  const proc = spawn("aplay", [
    "-D",
    device,
    "-f",
    "S16_LE",
    "-r",
    String(sampleRate),
    "-c",
    String(channels),
    "-t",
    "raw",
  ]);

  const onAbort = () => {
    if (proc.pid) {
      proc.kill("SIGKILL");
    }
  };

  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  proc.stdin?.write(pcm);
  proc.stdin?.end();

  await new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal?.aborted) {
        reject(new Error("aplay forcefully aborted by timeout signal"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`aplay exited with ${code ?? "unknown"}`));
      }
    });
  });
}
