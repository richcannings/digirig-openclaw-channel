import { SerialPort } from "serialport";

export type PttConfig = {
  device: string;
  rts: boolean;
  leadMs: number;
  tailMs: number;
};

export class PttController {
  private port: SerialPort | null = null;
  private config: PttConfig;

  constructor(config: PttConfig) {
    this.config = config;
  }

  async open(): Promise<void> {
    if (this.port) {
      return;
    }
    this.port = new SerialPort({
      path: this.config.device,
      baudRate: 9600,
      autoOpen: true,
    });
    await new Promise<void>((resolve, reject) => {
      this.port?.once("open", () => resolve());
      this.port?.once("error", (err) => reject(err));
    });
  }

  async close(): Promise<void> {
    if (!this.port) {
      return;
    }
    const port = this.port;
    this.port = null;
    await new Promise<void>((resolve) => {
      port.close(() => resolve());
    });
  }

  async setTx(active: boolean): Promise<void> {
    if (!this.port) {
      throw new Error("PTT serial port not open");
    }
    await new Promise<void>((resolve, reject) => {
      this.port?.set({ rts: active && this.config.rts }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async withTx<T>(fn: () => Promise<T>): Promise<T> {
    await this.open();
    await this.setTx(true);
    if (this.config.leadMs > 0) {
      await delay(this.config.leadMs);
    }
    const result = await fn();
    if (this.config.tailMs > 0) {
      await delay(this.config.tailMs);
    }
    await this.setTx(false);
    return result;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
