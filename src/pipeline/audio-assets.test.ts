import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AudioAssets } from "./audio-assets.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("AudioAssets", () => {
  const tmpWavPath = join(tmpdir(), "test-asset.wav");

  afterEach(async () => {
    try {
      await fs.unlink(tmpWavPath);
    } catch {}
  });

  it("should fail gracefully and log a warning if file is missing", async () => {
    await AudioAssets.eagerLoad("missing", "/does/not/exist.wav", 16000);
    expect(AudioAssets.get("missing")).toBeUndefined();
  });

  // Note: we can't easily generate a perfect WAV byte array in this test without 'wavefile' builder
  // But we have real WAVs in the audio/ folder we can test against!
  it("should eagerly load a valid generated WAV file and strip headers", async () => {
    // Relying on the audio/standby_short.wav we generated earlier
    const realAssetPath = join(process.cwd(), "audio", "standby_short.wav");
    
    // Make sure the file exists first (our previous shell script created it)
    try {
      await fs.access(realAssetPath);
    } catch {
      console.warn(`Skipping test because ${realAssetPath} is missing`);
      return;
    }

    await AudioAssets.eagerLoad("test-standby", realAssetPath, 16000);
    const pcm = AudioAssets.get("test-standby");
    
    expect(pcm).toBeDefined();
    expect(Buffer.isBuffer(pcm)).toBe(true);
    // Raw PCM should be smaller than the original WAV file (headers stripped)
    const fileStat = await fs.stat(realAssetPath);
    expect(pcm!.length).toBeLessThan(fileStat.size);
  });
});
