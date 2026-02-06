import { spawn } from "node:child_process";

export type SttMode = "command" | "stream";

export type SttConfig = {
  mode: SttMode;
  command: string;
  args: string;
  timeoutMs: number;
  streamUrl?: string;
  streamAuth?: string;
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

  type WebSocketLike = {
    readyState: number;
    send: (data: any) => void;
    close: () => void;
    addEventListener: (type: string, listener: (evt: any) => void) => void;
  };

  const WebSocketCtor: any = (globalThis as any).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available in this runtime");
  }

  let ws: WebSocketLike | null = null;
  let connecting: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (text: string) => void; reject: (err: Error) => void; timeout?: NodeJS.Timeout }
  >();

  const ensureWs = async () => {
    if (ws && ws.readyState === 1) {
      return;
    }
    if (connecting) {
      await connecting;
      return;
    }
    connecting = new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (config.streamAuth) {
        headers.Authorization = `Bearer ${config.streamAuth}`;
      }
      const socket = new WebSocketCtor(config.streamUrl!, { headers });
      ws = socket;

      const cleanup = () => {
        connecting = null;
      };

      socket.addEventListener("open", () => {
        cleanup();
        resolve();
      });
      socket.addEventListener("error", (evt) => {
        cleanup();
        reject(new Error(`stt websocket error: ${String((evt as ErrorEvent).message ?? evt)}`));
      });
      socket.addEventListener("close", () => {
        cleanup();
        const err = new Error("stt websocket closed");
        for (const [, entry] of pending) {
          entry.reject(err);
        }
        pending.clear();
      });
      socket.addEventListener("message", (evt) => {
        if (typeof evt.data !== "string") {
          return;
        }
        let msg: any;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        const id = Number(msg?.id ?? 0);
        if (!id || !pending.has(id)) {
          return;
        }
        if (msg.type === "final") {
          const entry = pending.get(id)!;
          if (entry.timeout) {
            clearTimeout(entry.timeout);
          }
          pending.delete(id);
          entry.resolve(String(msg.text ?? ""));
        } else if (msg.type === "error") {
          const entry = pending.get(id)!;
          if (entry.timeout) {
            clearTimeout(entry.timeout);
          }
          pending.delete(id);
          entry.reject(new Error(String(msg.error ?? "stt stream error")));
        }
      });
    });
    await connecting;
  };

  return {
    startSession: async ({ sampleRate, channels }) => {
      await ensureWs();
      if (!ws || ws.readyState !== 1) {
        throw new Error("stt websocket not connected");
      }
      const id = nextId++;
      ws.send(
        JSON.stringify({
          type: "start",
          id,
          format: "pcm_s16le",
          sampleRate,
          channels,
        }),
      );

      return {
        push: (frame) => {
          if (!ws || ws.readyState !== 1) {
            return;
          }
          ws.send(frame);
        },
        finalize: () =>
          new Promise<string>((resolve, reject) => {
            if (!ws || ws.readyState !== 1) {
              reject(new Error("stt websocket not connected"));
              return;
            }
            const timeout = setTimeout(() => {
              pending.delete(id);
              reject(new Error("stt stream timeout"));
            }, config.timeoutMs);
            pending.set(id, { resolve, reject, timeout });
            ws.send(JSON.stringify({ type: "end", id }));
          }),
        cancel: () => {
          if (!ws || ws.readyState !== 1) {
            return;
          }
          ws.send(JSON.stringify({ type: "cancel", id }));
          pending.delete(id);
        },
      };
    },
    close: () => {
      if (ws && ws.readyState === 1) {
        ws.close();
      }
      ws = null;
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
