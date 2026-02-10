import { describe, expect, it } from "vitest";
import { computeRms } from "./audio-monitor.js";

describe("computeRms", () => {
  it("returns near zero for silence", () => {
    const buf = Buffer.alloc(200);
    expect(computeRms(buf)).toBeLessThan(0.001);
  });

  it("returns higher energy for tone", () => {
    const buf = Buffer.alloc(200);
    for (let i = 0; i < buf.length; i += 2) {
      buf.writeInt16LE(10000, i);
    }
    expect(computeRms(buf)).toBeGreaterThan(0.2);
  });
});
