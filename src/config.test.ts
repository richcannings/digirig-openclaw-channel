import { describe, expect, it } from "vitest";
import { DigirigConfigSchema } from "./config.js";

describe("DigirigConfigSchema", () => {
  it("uses default stt.wsUrl", () => {
    const result = DigirigConfigSchema.parse({ stt: {} });
    expect(result.stt.wsUrl).toBe("ws://127.0.0.1:28080");
  });

  it("applies defaults", () => {
    const result = DigirigConfigSchema.parse({ stt: {} });
    expect(result.audio.inputDevice).toBe("plughw:0,0");
    expect(result.audio.outputDevice).toBe("plughw:0,0");
    expect(result.ptt.device).toBe("/dev/ttyUSB0");
    expect(result.rx.frameMs).toBe(20);
    expect(result.stt.wsUrl).toBe("ws://127.0.0.1:28080");
  });
});
