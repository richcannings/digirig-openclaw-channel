export interface Transcriber {
  connect(): Promise<void>;
  startTurn(): void;
  pushFrame(frame: Buffer): void;
  endTurn(): void;
  waitForResult(timeoutMs?: number): Promise<void>;
  getText(): string;
  close(): void;
}
