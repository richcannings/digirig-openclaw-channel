#!/bin/bash
# scripts/generate-assets.sh
# Generates the latency acknowledgment audio assets using OpenClaw's TTS and ffmpeg.

set -e

# Target ALSA format for DigiRig: 16kHz, Mono, 16-bit PCM WAV
SAMPLE_RATE=16000
CHANNELS=1

mkdir -p audio
cd audio

echo "Generating 'standby_short.wav'..."
openclaw infer tts convert --text "Stand by." --output tmp_short.mp3
ffmpeg -y -i tmp_short.mp3 -ar $SAMPLE_RATE -ac $CHANNELS -c:a pcm_s16le standby_short.wav
rm tmp_short.mp3

echo "Generating 'standby_long.wav'..."
openclaw infer tts convert --text "Stand by. W6RGC stroke AI." --output tmp_long.mp3
ffmpeg -y -i tmp_long.mp3 -ar $SAMPLE_RATE -ac $CHANNELS -c:a pcm_s16le standby_long.wav
rm tmp_long.mp3

echo "Generating 'error.wav'..."
openclaw infer tts convert --text "I'm sorry, I cannot do that Dave. W6RGC stroke AI." --output tmp_error.mp3
ffmpeg -y -i tmp_error.mp3 -ar $SAMPLE_RATE -ac $CHANNELS -c:a pcm_s16le error.wav
rm tmp_error.mp3

echo "Audio assets generated successfully!"
ls -l *.wav
