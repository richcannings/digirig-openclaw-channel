import { spawn } from "node:child_process";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { DigirigConfig } from "./config.js";

const DEFAULT_PIPER_URL = "http://127.0.0.1:18090";
const DEFAULT_KOKORO_URL = "http://127.0.0.1:18091";
const LOCAL_TTS_TIMEOUT_MS = 15_000;

export type TtsResult = { audioBuffer: Buffer; sampleRate: number };

/**
 * Synthesize TTS for the given text. Routes to the local daemon configured in
 * `channels.digirig.localTts.engine`, or falls back to OpenClaw's cloud TTS
 * chain (`runtime.tts.textToSpeechTelephony`) when `engine === "off"`.
 */
export async function synthesizeTts(
  runtime: PluginRuntime,
  text: string,
  config: DigirigConfig,
): Promise<TtsResult> {
  const local = config.localTts;
  if (local?.engine && local.engine !== "off") {
    return synthesizeLocalTts(local, text);
  }
  return synthesizeCloudTts(runtime, text);
}

async function synthesizeCloudTts(runtime: PluginRuntime, text: string): Promise<TtsResult> {
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

function defaultUrlForEngine(engine: "piper" | "kokoro"): string {
  return engine === "kokoro" ? DEFAULT_KOKORO_URL : DEFAULT_PIPER_URL;
}

async function synthesizeLocalTts(
  local: DigirigConfig["localTts"],
  text: string,
): Promise<TtsResult> {
  const engine = local.engine as "piper" | "kokoro";
  const baseUrl = local.url?.trim() || defaultUrlForEngine(engine);
  const body: Record<string, unknown> = { text };
  if (local.voice) body.voice = local.voice;
  if (local.speed) body.speed = local.speed;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_TTS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    const hint =
      err?.code === "ECONNREFUSED" || err?.cause?.code === "ECONNREFUSED"
        ? ` — is the ${engine}-daemon.service running?`
        : "";
    throw new Error(`local TTS (${engine}) request failed${hint}: ${String(err)}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = "";
    try {
      const json = (await res.json()) as { error?: string };
      detail = json.error ? `: ${json.error}` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`local TTS (${engine}) returned ${res.status}${detail}`);
  }

  const sampleRate = Number(res.headers.get("x-sample-rate") ?? "0") || 22050;
  const audioBuffer = Buffer.from(await res.arrayBuffer());
  if (audioBuffer.length === 0) {
    throw new Error(`local TTS (${engine}) returned empty audio`);
  }
  return { audioBuffer, sampleRate };
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
