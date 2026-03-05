import { WhisperLiveClient } from "./stt-ws.js";
import type { Transcriber } from "./transcriber.js";

export class WhisperLiveTranscriber implements Transcriber {
  private client: WhisperLiveClient;

  constructor(params: { wsUrl: string; log?: any }) {
    this.client = new WhisperLiveClient(
      {
        url: params.wsUrl,
        model: "Systran/faster-whisper-medium.en",
        task: "transcribe",
        useVad: false,
        sendLastNSegments: 10,
      },
      params.log,
    );
  }

  connect(): Promise<void> {
    return this.client.connect();
  }

  startTurn(): void {
    this.client.reset();
  }

  pushFrame(frame: Buffer): void {
    this.client.sendAudio(frame);
  }

  endTurn(): void {
    this.client.end();
  }

  waitForResult(timeoutMs = 1200): Promise<void> {
    return this.client.waitForIdle(timeoutMs);
  }

  getText(): string {
    return this.client.getText() || "";
  }

  close(): void {
    this.client.close();
  }
}
