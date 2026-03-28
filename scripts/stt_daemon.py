#!/usr/bin/env python3
import http.server
import socketserver
import json
import argparse
import os
import tempfile
import warnings

# Suppress FP16 warnings on CPU
warnings.filterwarnings("ignore")

model = None

class WhisperHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global model
        if self.path == '/transcribe':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length == 0:
                    self.send_error(400, "Empty payload")
                    return
                
                audio_data = self.rfile.read(content_length)
                
                fd, path = tempfile.mkstemp(suffix=".wav")
                try:
                    with os.fdopen(fd, 'wb') as f:
                        f.write(audio_data)
                    
                    # Run inference. The model is already hot in VRAM!
                    # fp16=True takes advantage of RTX 3060 Tensor Cores for massive speedups
                    result = model.transcribe(path, fp16=True, language="en")
                    
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'text': result.get('text', '')}).encode('utf-8'))
                finally:
                    if os.path.exists(path):
                        os.remove(path)
            except Exception as e:
                self.send_error(500, str(e))
        else:
            self.send_error(404, "Not Found")
            
    def log_message(self, format, *args):
        # Suppress noisy HTTP logs so we only see startup/errors
        pass

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Hot-Loaded Whisper STT Daemon")
    parser.add_argument('--model', default='medium.en', help='Whisper model to load into VRAM')
    parser.add_argument('--port', type=int, default=18088, help='Port to bind the HTTP server to')
    args = parser.parse_args()
    
    import whisper
    print(f"Loading Whisper model '{args.model}' into VRAM. This will take a moment...")
    model = whisper.load_model(args.model)
    print(f"Model '{args.model}' loaded successfully.")
    print(f"Starting Hot-Loaded STT Daemon on http://127.0.0.1:{args.port}/transcribe")
    
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), WhisperHandler) as httpd:
        httpd.serve_forever()
