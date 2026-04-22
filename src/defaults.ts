export const DEFAULT_AUDIO_DEVICE = "plughw:0,0";
export const DEFAULT_AUDIO_SAMPLE_RATE = 16000;

export const DEFAULT_PTT_DEVICE = "/dev/ttyUSB0";
export const DEFAULT_PTT_LEAD_MS = 350;
export const DEFAULT_PTT_TAIL_MS = 120;

export const DEFAULT_RX_ENERGY_THRESHOLD = 0.1;
export const DEFAULT_RX_FRAME_MS = 20;
export const DEFAULT_RX_PRE_ROLL_MS = 600;
export const DEFAULT_RX_MIN_SPEECH_MS = 200;
export const DEFAULT_RX_MAX_SILENCE_MS = 250;
export const DEFAULT_RX_MAX_RECORD_MS = 10000;
export const DEFAULT_RX_BUSY_HOLD_MS = 1000;
export const DEFAULT_RX_START_COOLDOWN_MS = 3000;
export const DEFAULT_RX_ENERGY_LOG_INTERVAL_MS = 1000;
export const DEFAULT_RX_CARRIER_SENSE_THRESHOLD = 0.0008;

export const DEFAULT_TX_CALLSIGN = "N0CALL/AI";
export const DEFAULT_TX_POLICY = "direct-only" as const;
// Additional on-air names operators might use to address the AI. Empty by default —
// set this per-instance. Example: "Seven,7,Overlord".
export const DEFAULT_TX_ALIASES = "";
export const DEFAULT_TX_MAX_DURATION_MS = 120000;
export const DEFAULT_TX_COURTESY_DELAY_MS = 2000;

// Persona defaults. These are generic fallbacks so the plugin out-of-the-box
// doesn't impersonate a specific station. Set `channels.digirig.persona.*` to
// configure per-instance.
export const DEFAULT_PERSONA_NAME = "Station";
export const DEFAULT_PERSONA_LOCATION = "";
// Empty string means "derive from tx.callsign by stripping trailing /AI".
export const DEFAULT_PERSONA_CONTROL_OPERATOR = "";
