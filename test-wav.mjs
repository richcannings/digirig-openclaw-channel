import fs from "node:fs";
import pkg from 'wavefile';
const { WaveFile } = pkg;

const buf = fs.readFileSync("./audio/standby_short.wav");
const wav = new WaveFile(buf);
console.log("Format:", wav.fmt.audioFormat);
console.log("Sample Rate:", wav.fmt.sampleRate);
console.log("Channels:", wav.fmt.numChannels);
console.log("Bits:", wav.fmt.bitsPerSample);

// extract PCM data
const samples = wav.data.samples;
console.log("Raw length:", samples.length);
