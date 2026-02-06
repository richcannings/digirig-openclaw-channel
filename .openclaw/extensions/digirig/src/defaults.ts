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
export const DEFAULT_RX_ACK_TONE_ENABLED = false;

export const DEFAULT_STT_COMMAND = "faster-whisper";
export const DEFAULT_STT_ARGS = ["{input}"]; // prints to stdout
export const DEFAULT_STT_TIMEOUT_MS = 15000;
