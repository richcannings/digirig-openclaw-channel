import tone from 'tonegenerator';

export interface DtmfConfig {
  toneDurationMs: number;      // Default: 100ms
  interDigitSilenceMs: number; // Default: 50ms
  amplitude: number;           // 0.0 - 1.0, default: 0.3
  sampleRate: number;          // Match system sample rate
}

export interface DtmfGenerator {
  generateSequence(digits: string, config: DtmfConfig): Promise<Buffer>;
  generateSingle(digit: string, config: DtmfConfig): Promise<Buffer>;
  isValidDtmfSequence(sequence: string): boolean;
}

export class ToneGeneratorDtmf implements DtmfGenerator {
  private readonly dtmfMatrix: { [key: string]: [number, number] } = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633],
  };

  async generateSequence(digits: string, config: DtmfConfig): Promise<Buffer> {
    const buffers: Buffer[] = [];
    
    for (let i = 0; i < digits.length; i++) {
      const digit = digits[i].toUpperCase();
      
      if (digit in this.dtmfMatrix) {
        // Generate DTMF tone for this digit
        const toneBuffer = await this.generateSingle(digit, config);
        buffers.push(toneBuffer);
        
        // Add silence between digits (except after last digit)
        if (i < digits.length - 1 && config.interDigitSilenceMs > 0) {
          const silenceBuffer = this.generateSilence(config.interDigitSilenceMs, config.sampleRate);
          buffers.push(silenceBuffer);
        }
      }
    }
    
    return Buffer.concat(buffers);
  }

  async generateSingle(digit: string, config: DtmfConfig): Promise<Buffer> {
    const upperDigit = digit.toUpperCase();
    
    if (!(upperDigit in this.dtmfMatrix)) {
      throw new Error(`Invalid DTMF digit: ${digit}`);
    }

    const [freq1, freq2] = this.dtmfMatrix[upperDigit];
    return this.generateDualTone(freq1, freq2, config);
  }

  isValidDtmfSequence(sequence: string): boolean {
    const cleaned = sequence.toUpperCase().replace(/[\s\-]/g, '');
    return /^[0-9A-D*#]+$/.test(cleaned) && cleaned.length > 0;
  }

  private generateDualTone(freq1: number, freq2: number, config: DtmfConfig): Buffer {
    const lengthSeconds = config.toneDurationMs / 1000;
    const volume = Math.round((tone as any).MAX_16 * config.amplitude);
    
    // Generate both frequency components
    const tone1 = (tone as any)({ 
      freq: freq1, 
      lengthInSeconds: lengthSeconds,
      volume: volume,
      sampleRate: config.sampleRate
    });
    
    const tone2 = (tone as any)({ 
      freq: freq2, 
      lengthInSeconds: lengthSeconds,
      volume: volume,
      sampleRate: config.sampleRate
    });
    
    // Mix the two tones (DTMF = dual frequency)
    const mixed = new Int16Array(tone1.length);
    for (let i = 0; i < tone1.length; i++) {
      mixed[i] = Math.round((tone1[i] + tone2[i]) / 2);
    }
    
    return Buffer.from(mixed.buffer);
  }

  private generateSilence(durationMs: number, sampleRate: number): Buffer {
    const samples = Math.floor(sampleRate * durationMs / 1000);
    return Buffer.alloc(samples * 2); // 16-bit silence
  }
}

// Factory function for easy instantiation
export function createDtmfGenerator(): DtmfGenerator {
  return new ToneGeneratorDtmf();
}