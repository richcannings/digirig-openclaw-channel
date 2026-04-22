#!/usr/bin/env python3
"""Kokoro-82M TTS daemon.

Simple HTTP server on 127.0.0.1:18091. Exposes the same contract as the Piper
daemon (scripts/piper-daemon.py) so the digirig plugin can switch engines with
a config flag.

Uses `kokoro-onnx` on CPU or GPU (ONNX Runtime picks automatically based on
which provider is available). ~330 MB model + ~25 MB voice file, ~200 ms
per sentence on CPU.

Contract:
    POST /tts
      body: {"text": "...", "voice": "af_sarah"}
      -> 200, raw 16-bit LE PCM, headers X-Sample-Rate / X-Channels / X-Format
      -> 4xx/5xx with JSON {"error": "..."}
    GET /healthz -> 200 "ok"
"""

import argparse
import http.server
import json
import os
import socketserver
import sys
import threading

import numpy as np

try:
    from kokoro_onnx import Kokoro
except ImportError:
    sys.stderr.write("[kokoro] kokoro-onnx not installed. Run scripts/setup-kokoro-daemon.sh first.\n")
    sys.exit(1)


DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 18091
DEFAULT_VOICE = "af_sarah"
DEFAULT_LANG = "en-us"
DEFAULT_SPEED = 1.0

# Kokoro always emits at 24 kHz.
KOKORO_SAMPLE_RATE = 24000


class KokoroHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json_error(self, status: int, message: str):
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        self._send_json_error(404, "not found")

    def do_POST(self):
        if self.path != "/tts":
            self._send_json_error(404, "not found")
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            text = (data.get("text") or "").strip()
            if not text:
                self._send_json_error(400, "empty text")
                return
            voice = data.get("voice") or server_state["default_voice"]
            speed = float(data.get("speed") or server_state["default_speed"])

            pcm = _synthesize(text, voice=voice, speed=speed)
            self.send_response(200)
            self.send_header("Content-Type", "audio/l16")
            self.send_header("X-Sample-Rate", str(KOKORO_SAMPLE_RATE))
            self.send_header("X-Channels", "1")
            self.send_header("X-Format", "S16_LE")
            self.send_header("X-Voice", voice)
            self.send_header("Content-Length", str(len(pcm)))
            self.end_headers()
            self.wfile.write(pcm)
        except Exception as e:
            sys.stderr.write(f"[kokoro] synthesis error: {e}\n")
            self._send_json_error(500, str(e))


server_state = {
    "model": None,
    "default_voice": DEFAULT_VOICE,
    "default_speed": DEFAULT_SPEED,
    "default_lang": DEFAULT_LANG,
    "lock": threading.Lock(),
}


def _synthesize(text: str, voice: str, speed: float) -> bytes:
    # kokoro_onnx's Kokoro instance isn't guaranteed thread-safe; serialize.
    with server_state["lock"]:
        samples, sample_rate = server_state["model"].create(
            text, voice=voice, speed=speed, lang=server_state["default_lang"]
        )
    # samples is float32 in [-1, 1]. Convert to 16-bit PCM.
    int16 = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
    return int16.tobytes()


def main():
    parser = argparse.ArgumentParser(description="Kokoro-82M TTS HTTP daemon")
    parser.add_argument("--bind", default=DEFAULT_BIND)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--model-path",
        default=os.environ.get("KOKORO_MODEL", os.path.expanduser("~/.openclaw/kokoro/kokoro-v1.0.onnx")),
    )
    parser.add_argument(
        "--voices-path",
        default=os.environ.get("KOKORO_VOICES", os.path.expanduser("~/.openclaw/kokoro/voices-v1.0.bin")),
    )
    parser.add_argument("--voice", default=DEFAULT_VOICE,
                        help=f"default voice (e.g. af_sarah, am_michael); override per-request with body voice field")
    parser.add_argument("--speed", type=float, default=DEFAULT_SPEED,
                        help="default speech speed (1.0 = normal, 1.25 = 25%% faster)")
    args = parser.parse_args()

    if not os.path.isfile(args.model_path):
        sys.stderr.write(f"[kokoro] model not found: {args.model_path}\n")
        sys.stderr.write("         run scripts/setup-kokoro-daemon.sh to install.\n")
        sys.exit(1)
    if not os.path.isfile(args.voices_path):
        sys.stderr.write(f"[kokoro] voices not found: {args.voices_path}\n")
        sys.stderr.write("         run scripts/setup-kokoro-daemon.sh to install.\n")
        sys.exit(1)

    print(f"[kokoro] loading model {os.path.basename(args.model_path)}...", flush=True)
    server_state["model"] = Kokoro(args.model_path, args.voices_path)
    server_state["default_voice"] = args.voice
    server_state["default_speed"] = args.speed

    socketserver.TCPServer.allow_reuse_address = True
    # ThreadingTCPServer would let multiple requests in at once, but Kokoro
    # synthesis is serialized anyway. TCPServer is fine.
    with socketserver.TCPServer((args.bind, args.port), KokoroHandler) as httpd:
        print(f"[kokoro] serving on http://{args.bind}:{args.port} (voice={args.voice}, speed={args.speed}, sample_rate={KOKORO_SAMPLE_RATE}Hz)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
