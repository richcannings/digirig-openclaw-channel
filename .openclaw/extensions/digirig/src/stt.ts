import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SttConfig = {
  command: string;
  args: string;
  timeoutMs: number;
  mode?: "command" | "stream";
  streamUrl?: string;
  streamIntervalMs?: number;
  streamWindowMs?: number;
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

async function runSttCommand(params: {
  config: SttConfig;
  inputPath: string;
  sampleRate: number;
}): Promise<string> {
  const { config, inputPath, sampleRate } = params;
  const outputPath = join(tmpdir(), `digirig-stt-${Date.now()}.txt`);
  const args = expandSttArgs(config.args, inputPath, sampleRate).map((arg) =>
    arg.replaceAll("{output}", outputPath),
  );

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

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.on("error", (err) => reject(err));
      proc.on("exit", (code) => resolve(code));
    });

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `STT command failed (${exitCode})`);
    }

    const fileText = await fs.readFile(outputPath, "utf8").catch(() => "");
    return (fileText || stdout).trim();
  } finally {
    clearTimeout(timeout);
    await fs.unlink(outputPath).catch(() => undefined);
  }
}

export async function runSttStream(params: {
  config: SttConfig;
  wavBuffer: Buffer;
}): Promise<string> {
  const { config, wavBuffer } = params;
  const url = config.streamUrl;
  if (!url) {
    throw new Error("stt.streamUrl is required for stream mode");
  }

  const form = new FormData();
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  form.append("file", blob, "audio.wav");
  form.append("audio_file", blob, "audio.wav");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(bodyText || `STT stream failed (${res.status})`);
    }
    try {
      const parsed = JSON.parse(bodyText);
      const text = parsed?.text ?? parsed?.result ?? "";
      return String(text).trim();
    } catch {
      return bodyText.trim();
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function runStt(params: {
  config: SttConfig;
  inputPath: string;
  sampleRate: number;
}): Promise<string> {
  return runSttCommand(params);
}
