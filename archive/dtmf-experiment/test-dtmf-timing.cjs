#!/usr/bin/env node

const tone = require('tonegenerator');
const fs = require('fs');
const { spawn } = require('child_process');

// Test DTMF timing issues offline
console.log('🎵 Testing DTMF Timing Issues Offline...\n');

function generateDtmfTone(digit, durationMs = 500, sampleRate = 16000, amplitude = 0.3) {
  const dtmfMatrix = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633],
  };

  if (!(digit in dtmfMatrix)) {
    throw new Error(`Invalid DTMF digit: ${digit}`);
  }

  const [freq1, freq2] = dtmfMatrix[digit];
  const lengthSeconds = durationMs / 1000;
  const volume = Math.round(tone.MAX_16 * amplitude);

  console.log(`Generating DTMF '${digit}': ${freq1}Hz + ${freq2}Hz, ${durationMs}ms`);

  // Generate both frequency components
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
  
  // Mix the two tones
  const mixed = new Int16Array(tone1.length);
  for (let i = 0; i < tone1.length; i++) {
    mixed[i] = Math.round((tone1[i] + tone2[i]) / 2);
  }
  
  return Buffer.from(mixed.buffer);
}

function generateWavHeader(sampleRate, channels, bitsPerSample, dataLength) {
  const buffer = Buffer.alloc(44);
  
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20);  // audio format (PCM)
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28); // byte rate
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32); // block align
  buffer.writeUInt16LE(bitsPerSample, 34);
  
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  
  return buffer;
}

function createWavFile(pcmData, filename, sampleRate = 16000) {
  const header = generateWavHeader(sampleRate, 1, 16, pcmData.length);
  const wavData = Buffer.concat([header, pcmData]);
  
  fs.writeFileSync(filename, wavData);
  console.log(`Created WAV file: ${filename} (${wavData.length} bytes, ${pcmData.length / 2 / sampleRate}s duration)`);
}

async function testDtmfTimings() {
  const testDurations = [100, 250, 500, 750, 1000]; // milliseconds
  
  console.log('📊 Testing different DTMF durations:\n');
  
  for (const duration of testDurations) {
    console.log(`🕐 Testing ${duration}ms duration:`);
    
    // Generate single digit "7" with this duration
    const pcmData = generateDtmfTone('7', duration);
    const actualDuration = pcmData.length / 2 / 16000; // 16-bit samples at 16kHz
    
    // Create WAV file
    const wavFile = `/tmp/dtmf-7-${duration}ms.wav`;
    createWavFile(pcmData, wavFile);
    
    console.log(`   Expected: ${duration}ms, Actual: ${(actualDuration * 1000).toFixed(1)}ms`);
    console.log(`   File: ${wavFile}`);
    console.log('');
  }
  
  console.log('🎯 Testing the 500ms duration (our target):');
  
  // Test our target 500ms duration with different digits
  const testSequence = ['7', '6', '7'];
  const buffers = [];
  
  for (let i = 0; i < testSequence.length; i++) {
    const digit = testSequence[i];
    const toneBuffer = generateDtmfTone(digit, 500); // 500ms per tone
    buffers.push(toneBuffer);
    
    // Add 100ms silence between digits
    if (i < testSequence.length - 1) {
      const silenceSamples = Math.floor(16000 * 0.1); // 100ms at 16kHz
      const silenceBuffer = Buffer.alloc(silenceSamples * 2);
      buffers.push(silenceBuffer);
    }
  }
  
  const sequenceBuffer = Buffer.concat(buffers);
  const sequenceDuration = sequenceBuffer.length / 2 / 16000;
  
  console.log(`Generated K6BJ time request sequence "767":`);
  console.log(`   Total duration: ${(sequenceDuration * 1000).toFixed(1)}ms`);
  console.log(`   Expected: ~1700ms (3 x 500ms tones + 2 x 100ms silence)`);
  
  const sequenceWav = '/tmp/dtmf-sequence-767-500ms.wav';
  createWavFile(sequenceBuffer, sequenceWav);
  
  console.log(`\n🔊 Test files created. Play them with:`);
  testDurations.forEach(d => {
    console.log(`aplay /tmp/dtmf-7-${d}ms.wav`);
  });
  console.log(`aplay ${sequenceWav}`);
  
  console.log(`\n📈 Analysis:`);
  console.log(`- If files play correctly at expected durations, the tonegenerator library works fine`);
  console.log(`- If the issue persists, it's in the DigiRig channel integration`);
  console.log(`- The 500ms single tone should be exactly half a second`);
  console.log(`- The 767 sequence should be about 1.7 seconds total`);
}

async function playTestFile() {
  const testFile = '/tmp/dtmf-7-500ms.wav';
  
  if (fs.existsSync(testFile)) {
    console.log('\n🔊 Playing 500ms test tone...');
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      const aplay = spawn('aplay', [testFile]);
      
      aplay.on('close', (code) => {
        const elapsed = Date.now() - startTime;
        console.log(`Playback finished in ${elapsed}ms (should be ~500ms + overhead)`);
        resolve();
      });
      
      aplay.on('error', (err) => {
        console.log('Audio playback error (OK if no device):', err.message);
        resolve();
      });
    });
  }
}

async function main() {
  try {
    await testDtmfTimings();
    await playTestFile();
  } catch (error) {
    console.error('Test failed:', error);
  }
}

main();