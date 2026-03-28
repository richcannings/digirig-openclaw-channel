type WhisperLiveOptions = {
  url: string;
  language?: string | null;
  task?: "transcribe" | "translate";
  model?: string;
  useVad?: boolean;
  sendLastNSegments?: number;
};

type WhisperLiveLog = {
  info?: (msg: string) => void;
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

export class WhisperLiveClient {
  private ws: any;
  private open = false;
  private pending: Buffer[] = [];
  private lastSegmentAt = 0;
  private latestText = "";

  constructor(private opts: WhisperLiveOptions, private log?: WhisperLiveLog) {}

  async connect(): Promise<void> {
    if (this.open || this.ws) return;
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket is not available in this runtime");
    }
    this.ws = new WebSocketCtor(this.opts.url);
    this.ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => {
        this.open = true;
        const payload = {
          uid: `digirig-${Date.now()}`,
          language: this.opts.language ?? null,
          task: this.opts.task ?? "transcribe",
          model: this.opts.model ?? "Systran/faster-whisper-medium.en",
          use_vad: this.opts.useVad ?? false,
          send_last_n_segments: this.opts.sendLastNSegments ?? 10,
          no_speech_thresh: 0.5,
          clip_audio: false,
          same_output_threshold: 3,
          enable_translation: false,
          target_language: null,
        };
        this.ws.send(JSON.stringify(payload));
        this.flushPending();
        resolve();
      });
      this.ws.addEventListener("error", (err: any) => {
        this.log?.error?.(`[digirig] WhisperLive WS error: ${String(err?.message ?? err)}`);
        reject(err);
      });
      this.ws.addEventListener("message", (evt: any) => this.handleMessage(evt));
      this.ws.addEventListener("close", () => {
        this.open = false;
        this.ws = null;
      });
    });
  }

  sendAudio(pcm16: Buffer): void {
    if (!pcm16.length) return;
    const floatBuf = WhisperLiveClient.int16ToFloat32Buffer(pcm16);
    if (!this.open || !this.ws) {
      this.pending.push(floatBuf);
      if (this.pending.length > 50) this.pending.shift();
      return;
    }
    this.ws.send(floatBuf);
  }

  end(): void {
    if (this.open && this.ws) {
      this.ws.send(Buffer.from("END_OF_AUDIO"));
    }
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
      this.open = false;
    }
  }

  async waitForIdle(idleMs: number): Promise<void> {
    const start = Date.now();
    const timeout = 30000; // 30s hard timeout
    while (Date.now() - start < timeout) {
      const now = Date.now();
      if (this.lastSegmentAt && now - this.lastSegmentAt >= idleMs) {
        return;
      }
      if (!this.lastSegmentAt && now - start >= idleMs) {
        // Waited for idleMs without any segments arriving at all
        return;
      }
      await WhisperLiveClient.delay(50);
    }
  }

  getText(): string {
    return this.latestText;
  }

  reset(): void {
    this.latestText = "";
    this.lastSegmentAt = 0;
  }

  private flushPending() {
    if (!this.open || !this.ws) return;
    for (const buf of this.pending) {
      this.ws.send(buf);
    }
    this.pending = [];
  }

  private handleMessage(evt: any) {
    const data = evt?.data;
    if (!data) return;
    if (typeof data !== "string") {
      return;
    }
    try {
      const payload = JSON.parse(data);
      if (payload?.status) {
        if (payload.status === "ERROR") {
          this.log?.warn?.(`[digirig] WhisperLive status: ${payload.message}`);
        }
        return;
      }
      const segments = payload?.segments;
      if (Array.isArray(segments)) {
        let fullText = "";
        for (const seg of segments) {
          const text = String(seg?.text ?? "").trim();
          if (text) {
            fullText += (fullText ? " " : "") + text;
          }
        }
        if (fullText && fullText !== this.latestText) {
          this.latestText = fullText;
          this.lastSegmentAt = Date.now();
        }
      }
    } catch (err) {
      this.log?.debug?.(`[digirig] WhisperLive parse error: ${String(err)}`);
    }
  }

  private static int16ToFloat32Buffer(buf: Buffer): Buffer {
    const sampleCount = Math.floor(buf.length / 2);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      float32[i] = buf.readInt16LE(i * 2) / 32768;
    }
    return Buffer.from(float32.buffer);
  }

  private static delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
