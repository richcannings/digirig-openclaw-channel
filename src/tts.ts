import { spawn } from "node:child_process";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
// @ts-ignore - CommonJS import in ES module
import tone from "tonegenerator";

export type AudioContent = {
  type: 'speech';
  text: string;
} | {
  type: 'dtmf';
  sequence: string;
  config: DtmfConfig;
};

export interface DtmfConfig {
  toneDurationMs: number;
  interDigitSilenceMs: number;
  amplitude: number;
  sampleRate: number;
}

export async function synthesizeTts(runtime: PluginRuntime, text: string): Promise<{
  audioBuffer: Buffer;
  sampleRate: number;
}> {
  if (!runtime.tts?.textToSpeechTelephony) {
    throw new Error("TTS runtime not available (textToSpeechTelephony missing)");
  }

  const result = await runtime.tts.textToSpeechTelephony({
    text,
    cfg: runtime.config,
  });

  if (!result.success || !result.audioBuffer || !result.sampleRate) {
    throw new Error(result.error ?? "TTS failed");
  }

  return { audioBuffer: result.audioBuffer, sampleRate: result.sampleRate };
}

/**
 * Enhanced audio synthesis that supports both speech and DTMF
 */
export async function synthesizeAudio(runtime: PluginRuntime, content: AudioContent): Promise<{
  audioBuffer: Buffer;
  sampleRate: number;
}> {
  if (content.type === 'speech') {
    return synthesizeTts(runtime, content.text);
  } else if (content.type === 'dtmf') {
    const audioBuffer = generateDtmfSequence(content.sequence, content.config);
    return { audioBuffer, sampleRate: content.config.sampleRate };
  }
  
  throw new Error(`Unknown audio content type: ${(content as any).type}`);
}

/**
 * Parse text to determine if it contains DTMF commands
 */
export function parseAudioContent(text: string, sampleRate: number): AudioContent {
  const dtmfCommand = parseDtmfCommand(text);
  
  if (dtmfCommand) {
    const config: DtmfConfig = {
      toneDurationMs: 500, // Use the updated 500ms duration
      interDigitSilenceMs: 50,
      amplitude: 0.3,
      sampleRate,
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
 * Parse DTMF commands from text
 */
function parseDtmfCommand(text: string): { sequence: string; description: string } | null {
  const patterns = [
    /(?:send|transmit|dial)\s+dtmf\s+([\d\*\#A-D\s\-\.pound star hash]+)/i,
    /^dtmf\s+([\d\*\#A-D\s\-\.pound star hash]+)/i,
    /(?:repeater\s+|access\s+)?code\s+([\d\*\#A-D\s\-\.]+)/i,
    /(?:send|transmit)\s+tones?\s+([\d\*\#A-D\s\-\.]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const sequence = normalizeDtmfSequence(match[1]);
      if (isValidDtmfSequence(sequence)) {
        return {
          sequence,
          description: `DTMF sequence ${sequence}`
        };
      }
    }
  }
  
  return null;
}

/**
 * Normalize DTMF sequence from spoken/text input
 */
function normalizeDtmfSequence(input: string): string {
  return input
    .toLowerCase()
    .trim()
    // Convert spelled-out symbols
    .replace(/\bstar\b/g, '*')
    .replace(/\bpound\b/g, '#')
    .replace(/\bhash\b/g, '#')
    .replace(/\basterisk\b/g, '*')
    // Convert spelled-out numbers
    .replace(/\bone\b/g, '1')
    .replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3')
    .replace(/\bfour\b/g, '4')
    .replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6')
    .replace(/\bseven\b/g, '7')
    .replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9')
    .replace(/\bzero\b/g, '0')
    // Remove separators and whitespace
    .replace(/[\s\-\.]/g, '')
    // Convert to uppercase for A-D
    .toUpperCase();
}

/**
 * Validate DTMF sequence
 */
function isValidDtmfSequence(sequence: string): boolean {
  return /^[0-9A-D*#]+$/.test(sequence) && sequence.length > 0 && sequence.length <= 20;
}

/**
 * Generate DTMF audio sequence
 */
function generateDtmfSequence(sequence: string, config: DtmfConfig): Buffer {
  const dtmfMatrix: { [key: string]: [number, number] } = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633],
  };

  const buffers: Buffer[] = [];
  
  for (let i = 0; i < sequence.length; i++) {
    const digit = sequence[i].toUpperCase();
    
    if (digit in dtmfMatrix) {
      // Generate DTMF tone for this digit
      const [freq1, freq2] = dtmfMatrix[digit];
      const toneBuffer = generateDualTone(freq1, freq2, config);
      buffers.push(toneBuffer);
      
      // Add silence between digits (except after last digit)
      if (i < sequence.length - 1 && config.interDigitSilenceMs > 0) {
        const silenceBuffer = generateSilence(config.interDigitSilenceMs, config.sampleRate);
        buffers.push(silenceBuffer);
      }
    }
  }
  
  return Buffer.concat(buffers);
}

/**
 * Generate dual-tone DTMF audio
 */
function generateDualTone(freq1: number, freq2: number, config: DtmfConfig): Buffer {
  const lengthSeconds = config.toneDurationMs / 1000;
  const volume = Math.round((tone as any).MAX_16 * config.amplitude);
  
  // Generate both frequency components
  const tone1 = (tone as any)({ 
    freq: freq1, 
    lengthInSeconds: lengthSeconds,
    volume: volume
  });
  
  const tone2 = (tone as any)({ 
    freq: freq2, 
    lengthInSeconds: lengthSeconds,
    volume: volume
  });
  
  // Mix the two tones (DTMF = dual frequency)
  const mixed = new Int16Array(tone1.length);
  for (let i = 0; i < tone1.length; i++) {
    mixed[i] = Math.round((tone1[i] + tone2[i]) / 2);
  }
  
  return Buffer.from(mixed.buffer);
}

/**
 * Generate silence buffer
 */
function generateSilence(durationMs: number, sampleRate: number): Buffer {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  return Buffer.alloc(samples * 2); // 16-bit silence
}

export async function playPcm(params: {
  device: string;
  sampleRate: number;
  channels: number;
  pcm: Buffer;
  signal?: AbortSignal;
}): Promise<void> {
  const { device, sampleRate, channels, pcm, signal } = params;

  if (signal?.aborted) {
    throw new Error("playPcm aborted before start");
  }

  const proc = spawn("aplay", [
    "-D",
    device,
    "-f",
    "S16_LE",
    "-r",
    String(sampleRate),
    "-c",
    String(channels),
    "-t",
    "raw",
  ]);

  const onAbort = () => {
    if (proc.pid) {
      proc.kill("SIGKILL");
    }
  };

  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  proc.stdin?.write(pcm);
  proc.stdin?.end();

  await new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal?.aborted) {
        reject(new Error("aplay forcefully aborted by timeout signal"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`aplay exited with ${code ?? "unknown"}`));
      }
    });
  });
}
