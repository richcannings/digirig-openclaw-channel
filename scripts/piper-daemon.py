#!/usr/bin/env python3
"""Piper TTS daemon.

Simple HTTP server on 127.0.0.1:18090. Exposes the same contract as the Kokoro
daemon (scripts/kokoro-daemon.py) so the digirig plugin can switch engines with
a config flag.

Contract:
    POST /tts
      body: {"text": "..."}
      -> 200, raw 16-bit LE PCM, headers X-Sample-Rate / X-Channels / X-Format
      -> 4xx/5xx with JSON {"error": "..."}
    GET /healthz -> 200 "ok"
"""

import argparse
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys

DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 18090


class PiperHandler(http.server.BaseHTTPRequestHandler):
    # Suppress per-request access log spam — only surface errors.
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

            pcm = _synthesize(text)
            self.send_response(200)
            self.send_header("Content-Type", "audio/l16")
            self.send_header("X-Sample-Rate", str(server_state["sample_rate"]))
            self.send_header("X-Channels", "1")
            self.send_header("X-Format", "S16_LE")
            self.send_header("Content-Length", str(len(pcm)))
            self.end_headers()
            self.wfile.write(pcm)
        except Exception as e:
            sys.stderr.write(f"[piper] synthesis error: {e}\n")
            self._send_json_error(500, str(e))


# Piper emits raw PCM at the voice model's native sample rate. en_US-lessac-high
# is 22050 Hz. We read it out of the model's sidecar JSON at startup.
server_state = {"piper_bin": "", "model": "", "sample_rate": 22050, "length_scale": 1.0}


def _synthesize(text: str) -> bytes:
    args = [
        server_state["piper_bin"],
        "--model", server_state["model"],
        "--output-raw",
        "--length_scale", str(server_state["length_scale"]),
    ]
    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    stdout, _ = proc.communicate(input=text.encode("utf-8"))
    if proc.returncode != 0 or not stdout:
        raise RuntimeError(f"piper exited {proc.returncode} with {len(stdout)} bytes")
    return stdout


def _resolve_sample_rate(model_path: str) -> int:
    sidecar = model_path + ".json"
    try:
        with open(sidecar, "r", encoding="utf-8") as f:
            meta = json.load(f)
        return int(meta.get("audio", {}).get("sample_rate", 22050))
    except Exception:
        return 22050


def main():
    parser = argparse.ArgumentParser(description="Piper TTS HTTP daemon")
    parser.add_argument("--bind", default=DEFAULT_BIND)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--piper-bin",
        default=os.environ.get("PIPER_BIN", os.path.expanduser("~/.openclaw/piper/piper/piper")),
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("PIPER_MODEL", os.path.expanduser("~/.openclaw/piper/en_US-lessac-high.onnx")),
    )
    parser.add_argument("--length-scale", type=float, default=1.0,
                        help="Higher = slower speech (1.0 = native)")
    args = parser.parse_args()

    if not shutil.which(args.piper_bin) and not os.path.isfile(args.piper_bin):
        sys.stderr.write(f"[piper] binary not found: {args.piper_bin}\n")
        sys.stderr.write("         run scripts/setup-piper-daemon.sh to install.\n")
        sys.exit(1)
    if not os.path.isfile(args.model):
        sys.stderr.write(f"[piper] model not found: {args.model}\n")
        sys.stderr.write("         run scripts/setup-piper-daemon.sh to install.\n")
        sys.exit(1)

    server_state["piper_bin"] = args.piper_bin
    server_state["model"] = args.model
    server_state["length_scale"] = args.length_scale
    server_state["sample_rate"] = _resolve_sample_rate(args.model)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.bind, args.port), PiperHandler) as httpd:
        print(f"[piper] serving on http://{args.bind}:{args.port} (sample_rate={server_state['sample_rate']}Hz, model={os.path.basename(args.model)})", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
