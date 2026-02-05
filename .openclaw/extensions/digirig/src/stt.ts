import { spawn } from "node:child_process";

export type SttConfig = {
  command: string;
  args: string[];
  timeoutMs: number;
};

export function expandSttArgs(args: string[], inputPath: string, sampleRate: number): string[] {
  return args.map((arg) =>
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

  const exitCode = await new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => resolve(code));
  });
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `STT command failed (${exitCode})`);
  }

  return stdout.trim();
}
