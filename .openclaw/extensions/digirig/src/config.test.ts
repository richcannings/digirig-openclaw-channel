import { describe, expect, it } from "vitest";
import { DigirigConfigSchema } from "./config.js";

describe("DigirigConfigSchema", () => {
  it("uses default stt.streamUrl", () => {
    const result = DigirigConfigSchema.parse({ stt: {} });
    expect(result.stt.streamUrl).toBe("http://127.0.0.1:18080/inference");
  });

  it("applies defaults", () => {
    const result = DigirigConfigSchema.parse({ stt: {} });
    expect(result.audio.inputDevice).toBe("hw:2,0");
    expect(result.audio.outputDevice).toBe("hw:2,0");
    expect(result.ptt.device).toBe("/dev/ttyUSB0");
    expect(result.rx.frameMs).toBe(20);
    expect(result.stt.streamIntervalMs).toBe(800);
  });
});
