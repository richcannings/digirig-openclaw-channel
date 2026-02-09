export const DEFAULT_AUDIO_DEVICE = "hw:2,0";
export const DEFAULT_AUDIO_SAMPLE_RATE = 16000;

export const DEFAULT_PTT_DEVICE = "/dev/ttyUSB0";
export const DEFAULT_PTT_LEAD_MS = 350;
export const DEFAULT_PTT_TAIL_MS = 120;

export const DEFAULT_RX_ENERGY_THRESHOLD = 0.01;
export const DEFAULT_RX_FRAME_MS = 20;
export const DEFAULT_RX_PRE_ROLL_MS = 250;
export const DEFAULT_RX_MIN_SPEECH_MS = 250;
export const DEFAULT_RX_MAX_SILENCE_MS = 650;
export const DEFAULT_RX_MAX_RECORD_MS = 10000;
export const DEFAULT_RX_BUSY_HOLD_MS = 350;
export const DEFAULT_RX_ENERGY_LOG_INTERVAL_MS = 0;

export const DEFAULT_TX_CALLSIGN = "W6RGC/AI";
export const DEFAULT_STT_TIMEOUT_MS = 15000;
export const DEFAULT_STT_STREAM_URL = "http://127.0.0.1:18080/inference";
export const DEFAULT_STT_STREAM_INTERVAL_MS = 800;
export const DEFAULT_STT_STREAM_WINDOW_MS = 4000;

export const DEFAULT_STT_SERVER_AUTOSTART = true;
export const DEFAULT_STT_SERVER_COMMAND = "whisper-server";
export const DEFAULT_STT_SERVER_ARGS = "-m {model} --host {host} --port {port}";
export const DEFAULT_STT_SERVER_MODEL_PATH = "";
export const DEFAULT_STT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_STT_SERVER_PORT = 18080;
export const DEFAULT_STT_SERVER_RESTART_MS = 2000;
