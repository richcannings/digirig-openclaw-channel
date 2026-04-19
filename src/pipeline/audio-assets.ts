import { promises as fs } from "node:fs";
import { join } from "node:path";
import pkg from "wavefile";
const { WaveFile } = pkg;

export class AudioAssets {
  private static cache = new Map<string, Buffer>();

  /**
   * Loads a WAV file, strips its headers, and stores the raw PCM buffer in memory.
   */
  static async eagerLoad(key: string, filepath: string, expectedSampleRate: number): Promise<void> {
    try {
      const fileBuffer = await fs.readFile(filepath);
      const wav = new WaveFile(fileBuffer);
      
      const format = wav.fmt.audioFormat;
      const sampleRate = wav.fmt.sampleRate;
      const channels = wav.fmt.numChannels;
      const bits = wav.fmt.bitsPerSample;
      
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw new Error(`Asset ${filepath} must be 16-bit Mono PCM WAV`);
      }
      if (sampleRate !== expectedSampleRate) {
        throw new Error(`Asset ${filepath} sample rate ${sampleRate}Hz does not match channel ${expectedSampleRate}Hz`);
      }

      // raw PCM bytes
      const rawPcm = Buffer.from(wav.data.samples);
      this.cache.set(key, rawPcm);
    } catch (err) {
      console.warn(`[digirig] Warning: Failed to load audio asset '${key}' from ${filepath}: ${String(err)}`);
    }
  }

  static get(key: string): Buffer | undefined {
    return this.cache.get(key);
  }
}
