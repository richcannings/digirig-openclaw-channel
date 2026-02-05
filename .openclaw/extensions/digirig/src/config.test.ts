import { describe, expect, it } from "vitest";
import { DigirigConfigSchema } from "./config.js";

describe("DigirigConfigSchema", () => {
  it("requires stt.command", () => {
    const result = DigirigConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("applies defaults", () => {
    const result = DigirigConfigSchema.parse({ stt: { command: "whisper" } });
    expect(result.audio.device).toBe("hw:2,0");
    expect(result.ptt.device).toBe("/dev/ttyUSB0");
    expect(result.rx.frameMs).toBe(20);
  });
});
