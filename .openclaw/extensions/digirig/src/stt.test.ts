import { describe, expect, it } from "vitest";
import { expandSttArgs } from "./stt.js";

describe("expandSttArgs", () => {
  it("replaces placeholders", () => {
    const args = expandSttArgs("-f {input} -sr {sr}", "/tmp/in.wav", 16000);
    expect(args).toEqual(["-f", "/tmp/in.wav", "-sr", "16000"]);
  });
});
