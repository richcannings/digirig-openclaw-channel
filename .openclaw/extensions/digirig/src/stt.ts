import { spawn } from "node:child_process";
import { pcmToWav } from "./wav.js";

export type SttMode = "command" | "stream";

export type SttConfig = {
  mode: SttMode;
  command: string;
  args: string;
  timeoutMs: number;
  streamUrl?: string;
  streamAuth?: string;
  streamIntervalMs?: number;
  streamWindowMs?: number;
};

export type StreamingSttSession = {
  push: (frame: Buffer) => void;
  finalize: () => Promise<string>;
  cancel: () => void;
};

export type StreamingSttClient = {
  startSession: (params: { sampleRate: number; channels: number }) => Promise<StreamingSttSession>;
  close: () => void;
};

function parseArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "" | '"' | "'" = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else if (ch === "\\" && i + 1 < raw.length) {
        i += 1;
        current += raw[i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch.trim() === "") {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    args.push(current);
  }
  return args;
}

export function expandSttArgs(args: string, inputPath: string, sampleRate: number): string[] {
  return parseArgs(args).map((arg) =>
    arg.replaceAll("{input}", inputPath).replaceAll("{sr}", String(sampleRate)),
  );
}

export function createStreamingSttClient(config: SttConfig): StreamingSttClient {
  if (!config.streamUrl) {
    throw new Error("stt.streamUrl is required for streaming mode");
  }

  const headers: Record<string, string> = {};
  if (config.streamAuth) {
    headers.Authorization = `Bearer ${config.streamAuth}`;
  }

  const streamIntervalMs = Math.max(0, config.streamIntervalMs ?? 0);
  const streamWindowMs = Math.max(0, config.streamWindowMs ?? 0);

  const submitInference = async (pcm: Buffer, sampleRate: number, channels: number) => {
    const wav = pcmToWav(pcm, sampleRate, channels);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");

    const response = await fetch(config.streamUrl!, {
      method: "POST",
      headers,
      body: form,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`stt stream http ${response.status}: ${text}`);
    }

    const json = (await response.json()) as { text?: string };
    return String(json?.text ?? "");
  };

  return {
    startSession: async ({ sampleRate, channels }) => {
      let buffers: Buffer[] = [];
      let totalBytes = 0;
      let lastPartialAt = 0;
      let partialInFlight = false;
      let cancelled = false;

      const maybeRunPartial = () => {
        if (streamIntervalMs <= 0 || partialInFlight || cancelled) {
          return;
        }
        const now = Date.now();
        if (now - lastPartialAt < streamIntervalMs) {
          return;
        }
        lastPartialAt = now;
        partialInFlight = true;

        const pcm = Buffer.concat(buffers, totalBytes);
        let windowed = pcm;
        if (streamWindowMs > 0) {
          const bytesPerMs = Math.floor((sampleRate * channels * 2) / 1000);
          const windowBytes = streamWindowMs * bytesPerMs;
          if (windowBytes > 0 && pcm.length > windowBytes) {
            windowed = pcm.subarray(pcm.length - windowBytes);
          }
        }

        submitInference(windowed, sampleRate, channels)
          .catch(() => undefined)
          .finally(() => {
            partialInFlight = false;
          });
      };

      return {
        push: (frame) => {
          if (cancelled) {
            return;
          }
          buffers.push(frame);
          totalBytes += frame.length;
          maybeRunPartial();
        },
        finalize: async () => {
          if (cancelled) {
            return "";
          }
          const pcm = Buffer.concat(buffers, totalBytes);
          return submitInference(pcm, sampleRate, channels);
        },
        cancel: () => {
          cancelled = true;
          buffers = [];
          totalBytes = 0;
        },
      };
    },
    close: () => {
      // no persistent connection to close
    },
  };
}

export async function runStt(params: {
  config: SttConfig;
  inputPath: string;
  sampleRate: number;
}): Promise<string> {
  const { config, inputPath, sampleRate } = params;
  const args = expandSttArgs(config.args, inputPath, sampleRate);

  const proc = spawn(config.command, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  proc.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
  proc.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

  const timeout = setTimeout(() => {
    proc.kill("SIGKILL");
  }, config.timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    proc.on("error", (err) => reject(err));
    proc.on("exit", (code) => resolve(code));
  });
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `STT command failed (${exitCode})`);
  }

  return stdout.trim();
}
