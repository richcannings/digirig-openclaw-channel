import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type WhisperServerConfig = {
  autoStart: boolean;
  command: string;
  args: string;
  modelPath: string;
  host: string;
  port: number;
  restartMs: number;
  streamUrl: string;
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

function expandArgs(args: string, cfg: WhisperServerConfig): string[] {
  return parseArgs(args).map((arg) =>
    arg
      .replaceAll("{model}", cfg.modelPath)
      .replaceAll("{host}", cfg.host)
      .replaceAll("{port}", String(cfg.port)),
  );
}

export class WhisperServerManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private cfg: WhisperServerConfig, private log: (msg: string) => void) {}

  async ensureRunning(): Promise<void> {
    if (!this.cfg.autoStart) return;
    if (!this.cfg.modelPath) {
      this.log("[digirig] whisper-server autoStart enabled but stt.server.modelPath is empty");
      return;
    }

    const running = await this.checkRunning();
    if (running) return;

    this.startProcess();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  private startProcess(): void {
    const args = expandArgs(this.cfg.args, this.cfg);
    this.log(`[digirig] starting whisper-server: ${this.cfg.command} ${args.join(" ")}`);

    const logDir = path.join(process.env.HOME ?? "/home", ".openclaw", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "whisper-server.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    const proc = spawn(this.cfg.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;

    const writeLog = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      logStream.write(text.endsWith("\n") ? text : `${text}\n`);
    };

    proc.on("error", (err) => {
      if (this.stopping) return;
      this.log(`[digirig] whisper-server failed to start: ${String(err)}`);
      writeLog(`[error] ${String(err)}`);
      if (this.cfg.autoStart) {
        this.restartTimer = setTimeout(() => this.startProcess(), this.cfg.restartMs);
      }
    });

    proc.stdout?.on("data", (chunk) => writeLog(chunk));
    proc.stderr?.on("data", (chunk) => {
      writeLog(chunk);
      this.log(`[digirig] whisper-server error: ${chunk}`.trim());
    });

    proc.on("exit", (code, signal) => {
      logStream.end();
      if (this.stopping) return;
      this.log(`[digirig] whisper-server exited (${code ?? "?"}/${signal ?? "?"})`);
      if (this.cfg.autoStart) {
        this.restartTimer = setTimeout(() => this.startProcess(), this.cfg.restartMs);
      }
    });
  }

  private async checkRunning(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      const res = await fetch(this.cfg.streamUrl, { method: "GET", signal: controller.signal });
      return res.ok || res.status >= 400;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
