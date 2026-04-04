# DTMF Tone Experiment Archive

**Archived:** April 4, 2026  
**Reason:** DTMF tones were never successfully decoded by repeater controller (K6BJ). Needs fundamental redesign.

## Problem
DTMF tones generated through TTS audio synthesis path were not recognized by repeater DTMF decoders. Multiple on-air attempts with WB6DWP troubleshooting confirmed zero successful decodes.

## Likely Root Causes
1. TTS audio pipeline filters or distorts pure dual-tone signals
2. Frequency precision of synthesized tones may not meet decoder tolerances
3. Audio levels may differ between voice and tone output paths
4. Repeater may filter DTMF from certain input paths (AllStar/Echolink)

## Files Archived
- `dtmf-generator.ts` — ToneGeneratorDtmf class using `tonegenerator` npm package
- `dtmf-parser.ts` — StandardDtmfParser with regex command extraction
- `test-dtmf.ts` — Test harness for DTMF generation
- `audio-player.ts` — DigiRigAudioPlayer combining TTS + DTMF playback

## Code Also Removed From (not archived, just cleaned)
- `tts.ts` — AudioContent type, parseAudioContent(), synthesizeAudio(), generateDtmfSequence(), parseDtmfCommand()
- `runtime.ts` — parseAudioContent/synthesizeAudio imports and DTMF routing in speak()
- `config.ts` — DigirigDtmfSchema
- `defaults.ts` — DTMF default constants
- `prompt.ts` — Sections 11, 12, 14 (false DTMF capability claims)

## Prompt Sections Removed
### Section 11: DTMF TONE TRANSMISSION
Claimed "YOU CAN AND DO GENERATE DTMF TONES" — false. Tones never decoded.

### Section 12: K6BJ REPEATER CONTROL CODES  
Listed control codes (767=time, 768=temp, etc.) — useful reference but premature to include as capability.

### Section 14: DTMF CAPABILITY CONFIDENCE
Claimed "you have successfully transmitted DTMF tones on the air multiple times" — false.

## Redesign Notes
Future implementation should:
1. Bypass TTS pipeline entirely — write raw PCM dual-tone directly to audio device
2. Verify frequency accuracy with oscilloscope/spectrum analyzer before on-air testing
3. Test with repeater DTMF decoder in controlled environment first
4. Consider using sox or dedicated tone generation (not TTS path)
5. Implement audio feedback loop to verify output levels

## npm Dependencies Used
- `tonegenerator` (^0.3.3) — can be removed from package.json after cleanup
