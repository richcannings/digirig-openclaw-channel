import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { synthesizeTts } from "./tts.js";
import { createDtmfGenerator, type DtmfConfig } from "./dtmf-generator.js";
import { createDtmfParser } from "./dtmf-parser.js";

export type AudioContent = {
  type: 'speech';
  text: string;
} | {
  type: 'dtmf';
  sequence: string;
  config: DtmfConfig;
};

export interface AudioPlayer {
  generateAndPlayAudio(runtime: PluginRuntime, content: AudioContent, device: string): Promise<void>;
  generateAudioBuffer(runtime: PluginRuntime, content: AudioContent): Promise<{
    audioBuffer: Buffer;
    sampleRate: number;
  }>;
}

export class DigiRigAudioPlayer implements AudioPlayer {
  private dtmfGenerator = createDtmfGenerator();
  private dtmfParser = createDtmfParser();

  async generateAndPlayAudio(runtime: PluginRuntime, content: AudioContent, device: string): Promise<void> {
    const { audioBuffer, sampleRate } = await this.generateAudioBuffer(runtime, content);
    await this.playPcmBuffer(audioBuffer, sampleRate, device);
  }

  async generateAudioBuffer(runtime: PluginRuntime, content: AudioContent): Promise<{
    audioBuffer: Buffer;
    sampleRate: number;
  }> {
    if (content.type === 'speech') {
      return await synthesizeTts(runtime, content.text);
    } else if (content.type === 'dtmf') {
      const audioBuffer = await this.dtmfGenerator.generateSequence(content.sequence, content.config);
      return { audioBuffer, sampleRate: content.config.sampleRate };
    }
    
    throw new Error(`Unknown audio content type: ${(content as any).type}`);
  }

  /**
   * Determine if text contains DTMF commands and return appropriate AudioContent
   */
  parseAudioContent(text: string, defaultSampleRate: number): AudioContent {
    const dtmfCommand = this.dtmfParser.parseCommand(text);
    
    if (dtmfCommand) {
      const config: DtmfConfig = {
        toneDurationMs: 100,
        interDigitSilenceMs: 50,
        amplitude: 0.3,
        sampleRate: defaultSampleRate,
      };
      
      return {
        type: 'dtmf',
        sequence: dtmfCommand.sequence,
        config,
      };
    }
    
    return {
      type: 'speech',
      text,
    };
  }

  /**
   * Generate confirmation text for DTMF transmission
   */
  generateDtmfConfirmation(sequence: string): string {
    const readableSequence = sequence
      .replace(/\*/g, ' star')
      .replace(/#/g, ' pound')
      .split('')
      .join(' ')
      .trim();
    
    return `Transmitting DTMF sequence ${readableSequence}`;
  }

  private async playPcmBuffer(pcm: Buffer, sampleRate: number, device: string): Promise<void> {
    // Create temporary file for aplay
    const tmpFile = join(tmpdir(), `dtmf-${Date.now()}.raw`);
    
    try {
      // Write PCM data to temporary file
      await new Promise<void>((resolve, reject) => {
        const stream = createWriteStream(tmpFile);
        stream.write(pcm);
        stream.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      // Play with aplay
      await new Promise<void>((resolve, reject) => {
        const aplayProcess = spawn('aplay', [
          '-D', device,
          '-f', 'S16_LE',     // 16-bit signed little-endian
          '-r', sampleRate.toString(),
          '-c', '1',          // mono
          tmpFile
        ]);

        aplayProcess.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`aplay exited with code ${code}`));
          }
        });

        aplayProcess.on('error', reject);
      });
    } finally {
      // Clean up temporary file
      try {
        await unlink(tmpFile);
      } catch (error) {
        // Ignore cleanup errors
        console.warn('Failed to clean up temporary audio file:', error);
      }
    }
  }
}

// Factory function
export function createAudioPlayer(): AudioPlayer {
  return new DigiRigAudioPlayer();
}