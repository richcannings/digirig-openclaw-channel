import { spawn } from "node:child_process";

export type SttConfig = {
  command: string;
  args: string;
  timeoutMs: number;
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
