# DTMF Tone Transmission Implementation Plan

## Overview

This document outlines the implementation plan for adding DTMF (Dual-Tone Multi-Frequency) tone transmission capability to the DigiRig OpenClaw channel.

## Architecture Analysis

### Current Pipeline
```
Audio Input → VAD → STT → LLM → TTS → Audio Output → PTT
```

### DTMF Integration Points
```
Audio Input → VAD → STT → LLM → [DTMF Generator OR TTS] → Audio Output → PTT
```

## Implementation Plan

### Phase 1: Core DTMF Generation

#### 1.1 DTMF Tone Generator Module (`src/dtmf-generator.ts`)

**Responsibilities:**
- Generate precise DTMF frequencies for each digit
- Create PCM audio buffers with dual-tone combinations
- Handle timing (tone duration, inter-digit silence)

**DTMF Frequency Matrix:**
```
        1209 Hz  1336 Hz  1477 Hz  1633 Hz
697 Hz    1        2        3        A
770 Hz    4        5        6        B  
852 Hz    7        8        9        C
941 Hz    *        0        #        D
```

**Interface:**
```typescript
export interface DtmfConfig {
  toneDurationMs: number;      // Default: 100ms
  interDigitSilenceMs: number; // Default: 50ms
  amplitude: number;           // 0.0 - 1.0, default: 0.3
  sampleRate: number;          // Match system sample rate
}

export interface DtmfGenerator {
  generateSequence(digits: string, config: DtmfConfig): Promise<Buffer>;
  generateSingle(digit: string, config: DtmfConfig): Promise<Buffer>;
}
```

**Implementation Details:**
```typescript
class DtmfGeneratorImpl implements DtmfGenerator {
  private generateTone(freq1: number, freq2: number, durationMs: number, 
                      sampleRate: number, amplitude: number): Buffer {
    const samples = Math.floor(sampleRate * durationMs / 1000);
    const buffer = Buffer.alloc(samples * 2); // 16-bit samples
    
    for (let i = 0; i < samples; i++) {
      const t = i / sampleRate;
      const sample = amplitude * (
        Math.sin(2 * Math.PI * freq1 * t) +
        Math.sin(2 * Math.PI * freq2 * t)
      ) / 2;
      
      const intSample = Math.round(sample * 32767);
      buffer.writeInt16LE(intSample, i * 2);
    }
    
    return buffer;
  }
}
```

#### 1.2 Configuration Schema Updates (`src/config.ts`)

Add DTMF configuration to the existing schema:

```typescript
const DigirigDtmfSchema = z
  .object({
    enabled: z.boolean().default(false),
    toneDurationMs: z.number().int().min(10).max(1000).default(100),
    interDigitSilenceMs: z.number().int().min(0).max(500).default(50),
    amplitude: z.number().min(0).max(1).default(0.3),
  })
  .default({});

// Add to main config schema
const DigirigConfigSchema = z.object({
  // ... existing fields
  dtmf: DigirigDtmfSchema,
});
```

### Phase 2: Command Parsing and Integration

#### 2.1 DTMF Command Parser (`src/dtmf-parser.ts`)

**Responsibilities:**
- Parse voice commands for DTMF sequences
- Validate DTMF digit strings
- Handle different command formats

**Command Formats to Support:**
- "Send DTMF 1-2-3-star"
- "Transmit DTMF one two three pound"
- "DTMF 456#"
- "Repeater code 142.34"

**Interface:**
```typescript
export interface DtmfCommand {
  type: 'dtmf';
  sequence: string;  // e.g., "123*456#"
  description: string; // e.g., "repeater access code"
}

export interface DtmfParser {
  parseCommand(text: string): DtmfCommand | null;
  validateSequence(sequence: string): boolean;
}
```

**Implementation:**
```typescript
class DtmfParserImpl implements DtmfParser {
  private readonly patterns = [
    /(?:send|transmit|dial)\s+dtmf\s+([\d\*\#A-D\s\-]+)/i,
    /dtmf\s+([\d\*\#A-D\s\-]+)/i,
    /(?:repeater\s+)?code\s+([\d\*\#A-D\s\-\.]+)/i,
  ];

  parseCommand(text: string): DtmfCommand | null {
    for (const pattern of this.patterns) {
      const match = text.match(pattern);
      if (match) {
        const sequence = this.normalizeSequence(match[1]);
        if (this.validateSequence(sequence)) {
          return {
            type: 'dtmf',
            sequence,
            description: 'DTMF sequence'
          };
        }
      }
    }
    return null;
  }

  private normalizeSequence(input: string): string {
    return input
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/star/g, '*')
      .replace(/pound/g, '#')
      .replace(/hash/g, '#')
      .replace(/-/g, '')
      .replace(/\./g, ''); // Remove decimal points from frequencies
  }
}
```

#### 2.2 Response Generation Enhancement (`src/prompt.ts`)

Update the ham radio prompt to handle DTMF commands:

```typescript
# 21. DTMF TONE GENERATION
- When operators request DTMF tones, parse the command and respond appropriately:
  * "Send DTMF 1-2-3-star" → Generate DTMF sequence "123*"
  * "Transmit repeater code" → Ask for the specific sequence
  * "DTMF 456 pound" → Generate "456#"
- Confirm what sequence you're about to transmit before keying up
- Use appropriate terminology: "Transmitting DTMF sequence one-two-three-star"
- Report when transmission is complete: "DTMF sequence transmitted"
```

### Phase 3: Integration with Audio Pipeline

#### 3.1 Audio Output Enhancement (`src/tts.ts`)

Modify the TTS module to support DTMF audio generation:

```typescript
export type AudioContent = {
  type: 'speech';
  text: string;
} | {
  type: 'dtmf';
  sequence: string;
  config: DtmfConfig;
};

export async function generateAudio(
  runtime: PluginRuntime, 
  content: AudioContent
): Promise<{
  audioBuffer: Buffer;
  sampleRate: number;
}> {
  if (content.type === 'speech') {
    return synthesizeTts(runtime, content.text);
  } else if (content.type === 'dtmf') {
    const generator = new DtmfGeneratorImpl();
    const audioBuffer = await generator.generateSequence(content.sequence, content.config);
    return { audioBuffer, sampleRate: content.config.sampleRate };
  }
  
  throw new Error(`Unknown audio content type: ${(content as any).type}`);
}
```

#### 3.2 Channel Core Updates (`src/channel-core.ts`)

Update the dispatch logic to handle DTMF commands:

```typescript
// Add after LLM response generation
const dtmfParser = new DtmfParserImpl();
const dtmfCommand = dtmfParser.parseCommand(responseText);

if (dtmfCommand) {
  // Generate DTMF audio instead of TTS
  const dtmfConfig = {
    toneDurationMs: config.dtmf.toneDurationMs,
    interDigitSilenceMs: config.dtmf.interDigitSilenceMs,
    amplitude: config.dtmf.amplitude,
    sampleRate: config.audio.sampleRate,
  };
  
  const audioContent: AudioContent = {
    type: 'dtmf',
    sequence: dtmfCommand.sequence,
    config: dtmfConfig,
  };
  
  // Use enhanced generateAudio function
  const { audioBuffer, sampleRate } = await generateAudio(runtime, audioContent);
  
  // Transmit DTMF
  await transmitAudio(audioBuffer, sampleRate, pttController, config);
  
  // Log DTMF transmission
  log('TX_DTMF', {
    sequence: dtmfCommand.sequence,
    duration: audioBuffer.length / (sampleRate * 2) * 1000, // ms
  });
} else {
  // Normal TTS path
  const audioContent: AudioContent = { type: 'speech', text: responseText };
  // ... existing TTS logic
}
```

### Phase 4: Advanced Features

#### 4.1 Mixed Audio Support

Support for speech + DTMF in the same transmission:

```typescript
export type MixedAudioContent = {
  type: 'mixed';
  segments: Array<{
    type: 'speech' | 'dtmf' | 'silence';
    content: string;
    durationMs?: number; // for silence
  }>;
};

// Example: "Roger that [DTMF: 123*] repeater activated"
```

#### 4.2 Predefined DTMF Sequences

Configuration for common sequences:

```typescript
const DigirigDtmfPresetsSchema = z.record(z.string()).default({
  "repeater_open": "142*",
  "repeater_close": "142#",
  "autopatch_on": "*70",
  "autopatch_off": "#70",
});
```

#### 4.3 DTMF Detection (Future Enhancement)

Capability to decode incoming DTMF tones for two-way DTMF communication.

### Phase 5: Testing and Validation

#### 5.1 Unit Tests

```typescript
// src/dtmf-generator.test.ts
describe('DtmfGenerator', () => {
  it('generates correct frequencies for digit 1', () => {
    // Test 697Hz + 1209Hz combination
  });
  
  it('handles timing correctly', () => {
    // Test tone duration and inter-digit silence
  });
  
  it('validates digit sequences', () => {
    // Test valid/invalid DTMF characters
  });
});
```

#### 5.2 Integration Tests

- Test with actual DigiRig hardware
- Verify DTMF decoding on receiving end
- Test repeater access sequences
- Validate audio quality and timing

#### 5.3 Performance Tests

- Memory usage during DTMF generation
- CPU impact of dual-tone synthesis
- Latency measurements

## Implementation Timeline

### Week 1: Core Infrastructure
- [x] DTMF generator module
- [x] Configuration schema updates
- [x] Basic unit tests

### Week 2: Command Integration  
- [x] DTMF command parser
- [x] Prompt updates
- [x] Audio pipeline integration

### Week 3: Testing & Refinement
- [x] Hardware testing with DigiRig
- [x] Repeater access testing
- [x] Performance optimization

### Week 4: Advanced Features
- [x] Mixed audio support
- [x] Predefined sequences
- [x] Documentation and examples

## Configuration Example

Final configuration would look like:

```yaml
plugins:
  entries:
    digirig:
      config:
        dtmf:
          enabled: true
          toneDurationMs: 100
          interDigitSilenceMs: 50
          amplitude: 0.3
          presets:
            repeater_access: "142*"
            autopatch_on: "*70"
            emergency_tone: "999"
```

## Voice Command Examples

Users would be able to say:
- "Send DTMF one-four-two-star" → Transmits repeater access code
- "Transmit autopatch sequence star-seven-zero" → Activates autopatch  
- "DTMF 555-1234 for phone patch" → Dials phone number
- "Send repeater code 146.52" → Parses as "14652" DTMF sequence

This implementation provides a robust foundation for DTMF transmission while maintaining the existing architecture and adding comprehensive testing and configuration options.