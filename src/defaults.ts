export const DEFAULT_AUDIO_DEVICE = "plughw:0,0";
export const DEFAULT_AUDIO_SAMPLE_RATE = 16000;

export const DEFAULT_PTT_DEVICE = "/dev/ttyUSB0";
export const DEFAULT_PTT_LEAD_MS = 350;
export const DEFAULT_PTT_TAIL_MS = 120;

export const DEFAULT_RX_ENERGY_THRESHOLD = 0.002;
export const DEFAULT_RX_FRAME_MS = 20;
export const DEFAULT_RX_PRE_ROLL_MS = 100;
export const DEFAULT_RX_MIN_SPEECH_MS = 200;
export const DEFAULT_RX_MAX_SILENCE_MS = 1500;
export const DEFAULT_RX_MAX_RECORD_MS = 10000;
export const DEFAULT_RX_BUSY_HOLD_MS = 1000;
export const DEFAULT_RX_START_COOLDOWN_MS = 3000;
export const DEFAULT_RX_ENERGY_LOG_INTERVAL_MS = 1000;

export const DEFAULT_TX_CALLSIGN = "N0CALL/AI";
export const DEFAULT_TX_POLICY = "direct-only" as const;
export const DEFAULT_TX_ALIASES = "Overlord,Lord,Seven,7";
export const DEFAULT_STT_WS_URL = "ws://127.0.0.1:28080";

