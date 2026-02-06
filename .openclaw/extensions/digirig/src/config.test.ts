import { describe, expect, it } from "vitest";
import { DigirigConfigSchema } from "./config.js";

describe("DigirigConfigSchema", () => {
  it("uses default stt.command", () => {
    const result = DigirigConfigSchema.parse({ stt: {} });
    expect(result.stt.command).toBe("faster-whisper");
    expect(result.stt.mode).toBe("command");
  });

  it("applies defaults", () => {
    const result = DigirigConfigSchema.parse({ stt: { command: "whisper" } });
    expect(result.audio.inputDevice).toBe("hw:2,0");
    expect(result.audio.outputDevice).toBe("hw:2,0");
    expect(result.ptt.device).toBe("/dev/ttyUSB0");
    expect(result.rx.frameMs).toBe(20);
    expect(result.stt.command).toBe("whisper");
    expect(result.stt.streamUrl).toBe("");
  });
});
