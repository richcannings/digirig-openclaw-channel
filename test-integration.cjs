#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');

// Mock the TTS functions (simplified versions for testing)
const tone = require('tonegenerator');

function parseAudioContent(text, sampleRate) {
  const dtmfCommand = parseDtmfCommand(text);
  
  if (dtmfCommand) {
    const config = {
      toneDurationMs: 100,
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

function parseDtmfCommand(text) {
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

function normalizeDtmfSequence(input) {
  return input
    .toLowerCase()
    .trim()
    .replace(/\bstar\b/g, '*')
    .replace(/\bpound\b/g, '#')
    .replace(/\bhash\b/g, '#')
    .replace(/\basterisk\b/g, '*')
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
    .replace(/[\s\-\.]/g, '')
    .toUpperCase();
}

function isValidDtmfSequence(sequence) {
  return /^[0-9A-D*#]+$/.test(sequence) && sequence.length > 0 && sequence.length <= 20;
}

function generateDtmfSequence(sequence, config) {
  const dtmfMatrix = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633],
  };

  const buffers = [];
  
  for (let i = 0; i < sequence.length; i++) {
    const digit = sequence[i].toUpperCase();
    
    if (digit in dtmfMatrix) {
      const [freq1, freq2] = dtmfMatrix[digit];
      const toneBuffer = generateDualTone(freq1, freq2, config);
      buffers.push(toneBuffer);
      
      if (i < sequence.length - 1 && config.interDigitSilenceMs > 0) {
        const silenceBuffer = generateSilence(config.interDigitSilenceMs, config.sampleRate);
        buffers.push(silenceBuffer);
      }
    }
  }
  
  return Buffer.concat(buffers);
}

function generateDualTone(freq1, freq2, config) {
  const lengthSeconds = config.toneDurationMs / 1000;
  const volume = Math.round(tone.MAX_16 * config.amplitude);
  
  const tone1 = tone({ 
    freq: freq1, 
    lengthInSeconds: lengthSeconds,
    volume: volume
  });
  
  const tone2 = tone({ 
    freq: freq2, 
    lengthInSeconds: lengthSeconds,
    volume: volume
  });
  
  const mixed = new Int16Array(tone1.length);
  for (let i = 0; i < tone1.length; i++) {
    mixed[i] = Math.round((tone1[i] + tone2[i]) / 2);
  }
  
  return Buffer.from(mixed.buffer);
}

function generateSilence(durationMs, sampleRate) {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  return Buffer.alloc(samples * 2);
}

async function synthesizeAudio(content) {
  if (content.type === 'speech') {
    // Simulate TTS (just return a message)
    console.log(`[TTS] Would synthesize: "${content.text}"`);
    return {
      audioBuffer: Buffer.from('fake-tts-audio'),
      sampleRate: 16000
    };
  } else if (content.type === 'dtmf') {
    console.log(`[DTMF] Generating sequence: ${content.sequence}`);
    const audioBuffer = generateDtmfSequence(content.sequence, content.config);
    return { audioBuffer, sampleRate: content.config.sampleRate };
  }
  
  throw new Error(`Unknown audio content type: ${content.type}`);
}

async function testIntegration() {
  console.log('🎵 Testing DigiRig DTMF Integration...');
  
  const testCases = [
    'Send DTMF one-two-three-star',
    'transmit dtmf 456 pound',
    'DTMF 789',
    'repeater code 142 star',
    'Roger that, standing by',
    'Send DTMF 911 for emergency',
    'Just normal speech without any tones',
    'access code 456 hash',
  ];

  for (const testText of testCases) {
    console.log(`\n📝 Input: "${testText}"`);
    
    // Parse the content
    const content = parseAudioContent(testText, 16000);
    console.log(`🔍 Type: ${content.type}`);
    
    if (content.type === 'dtmf') {
      console.log(`🎵 DTMF Sequence: ${content.sequence}`);
      
      // Generate the confirmation message
      const readableSequence = content.sequence
        .replace(/\*/g, ' star')
        .replace(/#/g, ' pound')
        .split('')
        .join(' ')
        .trim();
      console.log(`📢 Confirmation: "Transmitting DTMF sequence ${readableSequence}"`);
      
      // Generate audio
      const result = await synthesizeAudio(content);
      console.log(`🔊 Generated ${result.audioBuffer.length} bytes of DTMF audio`);
      
      // Write test file
      const filename = `/tmp/integration-test-${content.sequence.replace(/[*#]/g, '_')}.raw`;
      fs.writeFileSync(filename, result.audioBuffer);
      console.log(`💾 Saved to: ${filename}`);
      
    } else {
      console.log(`🗣️ Speech: "${content.text}"`);
      await synthesizeAudio(content);
    }
  }

  console.log('\n✅ Integration test complete!');
  console.log('\n🔊 Example DigiRig workflow:');
  console.log('1. Operator: "Send DTMF one-four-two-star"');
  console.log('2. AI parses → DTMF: "142*"');
  console.log('3. AI responds: "Transmitting DTMF sequence 1 4 2 star"');
  console.log('4. System generates DTMF tones and plays through DigiRig');
  console.log('5. Repeater receives access code 142* and grants access');
}

testIntegration().catch(console.error);