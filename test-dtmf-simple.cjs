#!/usr/bin/env node

const tone = require('tonegenerator');
const fs = require('fs');
const { spawn } = require('child_process');

// DTMF frequency matrix
const dtmfMatrix = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633],
};

function generateDtmfTone(digit, config = {}) {
  const {
    toneDurationMs = 100,
    amplitude = 0.3,
    sampleRate = 16000
  } = config;

  if (!(digit in dtmfMatrix)) {
    throw new Error(`Invalid DTMF digit: ${digit}`);
  }

  const [freq1, freq2] = dtmfMatrix[digit];
  const lengthSeconds = toneDurationMs / 1000;
  const volume = Math.round(tone.MAX_16 * amplitude);

  console.log(`Generating DTMF '${digit}': ${freq1}Hz + ${freq2}Hz, ${toneDurationMs}ms`);

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
  
  // Mix the two tones (DTMF = dual frequency)
  const mixed = new Int16Array(tone1.length);
  for (let i = 0; i < tone1.length; i++) {
    mixed[i] = Math.round((tone1[i] + tone2[i]) / 2);
  }
  
  return Buffer.from(mixed.buffer);
}

function generateDtmfSequence(sequence, config = {}) {
  const {
    toneDurationMs = 100,
    interDigitSilenceMs = 50,
    sampleRate = 16000
  } = config;

  const buffers = [];

  for (let i = 0; i < sequence.length; i++) {
    const digit = sequence[i];
    
    // Generate tone for this digit
    const toneBuffer = generateDtmfTone(digit, { toneDurationMs, sampleRate, amplitude: config.amplitude });
    buffers.push(toneBuffer);
    
    // Add silence between digits (except after last digit)
    if (i < sequence.length - 1 && interDigitSilenceMs > 0) {
      const silenceSamples = Math.floor(sampleRate * interDigitSilenceMs / 1000);
      const silenceBuffer = Buffer.alloc(silenceSamples * 2); // 16-bit silence
      buffers.push(silenceBuffer);
    }
  }
  
  return Buffer.concat(buffers);
}

async function testDtmfGeneration() {
  console.log('🎵 Testing DTMF Generation with tonegenerator...');
  
  const config = {
    toneDurationMs: 100,
    interDigitSilenceMs: 50,
    amplitude: 0.3,
    sampleRate: 16000,
  };

  // Test 1: Single digit
  console.log('\n📍 Test 1: Single digit');
  const singleTone = generateDtmfTone('5', config);
  console.log(`Generated ${singleTone.length} bytes for digit '5'`);

  // Test 2: DTMF sequence
  console.log('\n📍 Test 2: DTMF sequence');
  const sequence = '123*0#';
  const sequenceBuffer = generateDtmfSequence(sequence, config);
  console.log(`Generated ${sequenceBuffer.length} bytes for sequence '${sequence}'`);

  // Test 3: Write test files
  console.log('\n📍 Test 3: Writing test files');
  
  const testCases = [
    { name: 'single-5', data: singleTone },
    { name: 'sequence-123star0pound', data: sequenceBuffer },
    { name: 'repeater-access-142star', data: generateDtmfSequence('142*', config) },
    { name: 'emergency-911', data: generateDtmfSequence('911', config) },
  ];

  for (const testCase of testCases) {
    const filename = `/tmp/dtmf-${testCase.name}.raw`;
    fs.writeFileSync(filename, testCase.data);
    console.log(`${testCase.name} → ${filename} (${testCase.data.length} bytes)`);
  }

  console.log('\n✅ DTMF generation complete!');
  console.log('\n🔊 To test audio output:');
  console.log('aplay -f S16_LE -r 16000 -c 1 /tmp/dtmf-sequence-123star0pound.raw');
  console.log('\n🎧 Check available audio devices:');
  console.log('aplay -l');
}

async function playTestTone() {
  console.log('\n🔊 Testing audio playback...');
  
  // Generate a simple test sequence
  const testBuffer = generateDtmfSequence('123', {
    toneDurationMs: 150,
    interDigitSilenceMs: 100,
    amplitude: 0.3,
    sampleRate: 16000
  });
  
  const tmpFile = '/tmp/dtmf-test-playback.raw';
  fs.writeFileSync(tmpFile, testBuffer);
  
  console.log('Playing DTMF sequence "123" on default device...');
  
  return new Promise((resolve, reject) => {
    const aplayProcess = spawn('aplay', [
      '-f', 'S16_LE',     // 16-bit signed little-endian
      '-r', '16000',      // 16kHz sample rate
      '-c', '1',          // mono
      tmpFile
    ]);

    aplayProcess.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Audio playback successful!');
        resolve();
      } else {
        console.log(`❌ aplay exited with code ${code}`);
        reject(new Error(`aplay exited with code ${code}`));
      }
    });

    aplayProcess.on('error', (err) => {
      console.log('❌ Audio playback error:', err.message);
      reject(err);
    });
  });
}

// Run the test
async function main() {
  try {
    await testDtmfGeneration();
    
    // Try to play a test tone
    try {
      await playTestTone();
    } catch (error) {
      console.log('Audio playback test failed (this is OK if no audio device available):', error.message);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

main();