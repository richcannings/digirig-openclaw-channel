#!/usr/bin/env python3
import argparse
import os
import sys
from faster_whisper import WhisperModel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Path to WAV file")
    parser.add_argument("--model", default=os.getenv("FASTER_WHISPER_MODEL", "base"))
    parser.add_argument("--language", default=os.getenv("FASTER_WHISPER_LANGUAGE"))
    parser.add_argument("--device", default=os.getenv("FASTER_WHISPER_DEVICE", "cpu"))
    parser.add_argument("--compute_type", default=os.getenv("FASTER_WHISPER_COMPUTE", "int8"))
    args = parser.parse_args()

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, _info = model.transcribe(args.input, language=args.language)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
