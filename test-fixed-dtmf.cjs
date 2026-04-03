#!/usr/bin/env node

const fs = require('fs');
const { spawn } = require('child_process');

// Fixed DTMF generator with proper timing control
console.log('🎵 Creating Fixed DTMF Generator with 250ms tone + 250ms spacing...\n');

function generateDtmfTone(freq1, freq2, durationMs, sampleRate = 16000, amplitude = 0.3) {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const buffer = Buffer.alloc(samples * 2); // 16-bit
  
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

function generateSilence(durationMs, sampleRate = 16000) {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  return Buffer.alloc(samples * 2); // 16-bit silence
}

function generateDtmfSequence(sequence, toneDurationMs = 250, spaceDurationMs = 250) {
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
      console.log(`Generating DTMF '${digit}': ${freq1}Hz + ${freq2}Hz, ${toneDurationMs}ms`);
      
      const toneBuffer = generateDtmfTone(freq1, freq2, toneDurationMs);
      buffers.push(toneBuffer);
      
      // Add spacing between digits (except after last digit)
      if (i < sequence.length - 1) {
        const silenceBuffer = generateSilence(spaceDurationMs);
        buffers.push(silenceBuffer);
        console.log(`Adding ${spaceDurationMs}ms silence`);
      }
    }
  }
  
  return Buffer.concat(buffers);
}

function generateWavHeader(sampleRate, channels, bitsPerSample, dataLength) {
  const buffer = Buffer.alloc(44);
  
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32);
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
  const actualDuration = pcmData.length / 2 / sampleRate;
  console.log(`Created: ${filename} (${(actualDuration * 1000).toFixed(0)}ms duration)`);
  return actualDuration;
}

async function testFixedDtmf() {
  console.log('🧪 Testing Fixed DTMF with your specs (250ms tone + 250ms space):\n');
  
  // Test 1: Single digit with 250ms
  console.log('📍 Test 1: Single digit "7" with 250ms tone');
  const singleTone = generateDtmfSequence('7', 250, 0); // No spacing for single digit
  const singleDuration = createWavFile(singleTone, '/tmp/dtmf-fixed-7-250ms.wav');
  
  // Test 2: Sequence "767" with 250ms tone + 250ms spacing
  console.log('\n📍 Test 2: K6BJ time request "767" with 250ms tone + 250ms spacing');
  const sequence767 = generateDtmfSequence('767', 250, 250);
  const sequenceDuration = createWavFile(sequence767, '/tmp/dtmf-fixed-767.wav');
  
  console.log(`\n✅ Expected vs Actual timing:`);
  console.log(`Single "7": Expected 250ms, Got ${(singleDuration * 1000).toFixed(0)}ms`);
  console.log(`Sequence "767": Expected 1250ms (3×250 + 2×250), Got ${(sequenceDuration * 1000).toFixed(0)}ms`);
  
  // Test 3: Different sequences for variety
  console.log('\n📍 Test 3: Other K6BJ codes');
  const tests = [
    { name: 'temp-768', sequence: '768' },
    { name: 'voltage-769', sequence: '769' },
    { name: 'emergency-78911', sequence: '78911' }
  ];
  
  for (const test of tests) {
    const buffer = generateDtmfSequence(test.sequence, 250, 250);
    const duration = createWavFile(buffer, `/tmp/dtmf-fixed-${test.name}.wav`);
    const expectedMs = test.sequence.length * 250 + (test.sequence.length - 1) * 250;
    console.log(`${test.name}: Expected ${expectedMs}ms, Got ${(duration * 1000).toFixed(0)}ms`);
  }
  
  console.log('\n🔊 Test playback:');
  console.log('aplay /tmp/dtmf-fixed-7-250ms.wav      # Should be exactly 250ms');
  console.log('aplay /tmp/dtmf-fixed-767.wav          # Should be exactly 1250ms (1.25 seconds)');
  
  return { singleDuration, sequenceDuration };
}

async function playTestSequence() {
  const testFile = '/tmp/dtmf-fixed-767.wav';
  
  if (fs.existsSync(testFile)) {
    console.log('\n🔊 Playing fixed K6BJ time request (767)...');
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      const aplay = spawn('aplay', [testFile]);
      
      aplay.on('close', (code) => {
        const elapsed = Date.now() - startTime;
        console.log(`✅ Playback completed in ${elapsed}ms (should be ~1250ms + small overhead)`);
        resolve(elapsed);
      });
      
      aplay.on('error', (err) => {
        console.log('Audio playback error (OK if no device):', err.message);
        resolve(0);
      });
    });
  }
}

async function main() {
  try {
    const { singleDuration, sequenceDuration } = await testFixedDtmf();
    const playbackTime = await playTestSequence();
    
    console.log('\n🎯 Results Summary:');
    console.log(`✅ Single tone (250ms): Generated ${(singleDuration * 1000).toFixed(0)}ms`);
    console.log(`✅ Sequence "767" (1250ms): Generated ${(sequenceDuration * 1000).toFixed(0)}ms`);
    console.log(`✅ Playback time: ${playbackTime}ms (includes overhead)`);
    
    if (Math.abs(singleDuration * 1000 - 250) < 10) {
      console.log('🎉 Fixed DTMF generator working correctly!');
      console.log('📻 Ready to integrate into DigiRig channel');
    } else {
      console.log('❌ Still has timing issues');
    }
    
  } catch (error) {
    console.error('Test failed:', error);
  }
}

main();