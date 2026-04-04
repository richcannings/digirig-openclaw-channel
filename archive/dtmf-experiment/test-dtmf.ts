#!/usr/bin/env node

import { createDtmfGenerator, type DtmfConfig } from './dtmf-generator.js';
import { createDtmfParser } from './dtmf-parser.js';
import { createAudioPlayer } from './audio-player.js';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

async function testDtmfGeneration() {
  console.log('🎵 Testing DTMF Generation...');
  
  const generator = createDtmfGenerator();
  const parser = createDtmfParser();
  const audioPlayer = createAudioPlayer();
  
  const config: DtmfConfig = {
    toneDurationMs: 100,
    interDigitSilenceMs: 50,
    amplitude: 0.3,
    sampleRate: 16000,
  };

  // Test 1: Generate single digit
  console.log('\n📍 Test 1: Single digit generation');
  const singleTone = await generator.generateSingle('5', config);
  console.log(`Generated ${singleTone.length} bytes for digit '5'`);

  // Test 2: Generate sequence
  console.log('\n📍 Test 2: Sequence generation');
  const sequence = '123*456#';
  const sequenceBuffer = await generator.generateSequence(sequence, config);
  console.log(`Generated ${sequenceBuffer.length} bytes for sequence '${sequence}'`);

  // Test 3: Command parsing
  console.log('\n📍 Test 3: Command parsing');
  const testCommands = [
    'Send DTMF 1-2-3-star',
    'transmit DTMF 456 pound',
    'DTMF 789',
    'repeater code 142*',
    'Just normal speech without DTMF',
  ];

  for (const cmd of testCommands) {
    const parsed = parser.parseCommand(cmd);
    console.log(`"${cmd}" → ${parsed ? `DTMF: ${parsed.sequence}` : 'No DTMF detected'}`);
  }

  // Test 4: Audio content parsing
  console.log('\n📍 Test 4: Audio content parsing');
  const audioContents = [
    'Send DTMF one two three star',
    'Roger that, standing by',
  ];

  for (const text of audioContents) {
    const content = audioPlayer.parseAudioContent(text, 16000);
    console.log(`"${text}" → Type: ${content.type}`);
    if (content.type === 'dtmf') {
      console.log(`  Sequence: ${content.sequence}`);
      console.log(`  Confirmation: "${audioPlayer.generateDtmfConfirmation(content.sequence)}"`);
    }
  }

  // Test 5: Write test file for manual verification
  console.log('\n📍 Test 5: Writing test audio files');
  
  // Write DTMF sequence to file
  const dtmfTestFile = '/tmp/test-dtmf-sequence.raw';
  writeFileSync(dtmfTestFile, sequenceBuffer);
  console.log(`DTMF sequence written to: ${dtmfTestFile}`);
  console.log('Play with: aplay -D default -f S16_LE -r 16000 -c 1 /tmp/test-dtmf-sequence.raw');

  // Generate a few specific test cases
  const testCases = [
    { name: 'emergency', sequence: '911' },
    { name: 'repeater-access', sequence: '142*' },
    { name: 'autopatch-on', sequence: '*70' },
    { name: 'phone-number', sequence: '5551234' },
  ];

  for (const testCase of testCases) {
    const buffer = await generator.generateSequence(testCase.sequence, config);
    const filename = `/tmp/dtmf-${testCase.name}.raw`;
    writeFileSync(filename, buffer);
    console.log(`${testCase.name}: ${testCase.sequence} → ${filename}`);
  }

  console.log('\n✅ DTMF testing complete!');
  console.log('\nTo test audio output, run:');
  console.log('aplay -D hw:1,0 -f S16_LE -r 16000 -c 1 /tmp/test-dtmf-sequence.raw');
  console.log('(adjust hw:1,0 to your DigiRig device)');
}

async function testAudioDevices() {
  console.log('\n🔊 Available audio devices:');
  
  return new Promise<void>((resolve) => {
    const aplay = spawn('aplay', ['-l']);
    
    aplay.stdout.on('data', (data) => {
      console.log(data.toString());
    });
    
    aplay.on('close', () => {
      resolve();
    });
  });
}

// Run tests
async function main() {
  try {
    await testAudioDevices();
    await testDtmfGeneration();
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}