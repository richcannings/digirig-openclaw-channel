import { z } from "zod";

import {
  DEFAULT_AUDIO_DEVICE,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_PTT_DEVICE,
  DEFAULT_PTT_LEAD_MS,
  DEFAULT_PTT_TAIL_MS,
  DEFAULT_RX_BUSY_HOLD_MS,
  DEFAULT_RX_ENERGY_THRESHOLD,
  DEFAULT_RX_FRAME_MS,
  DEFAULT_RX_MAX_RECORD_MS,
  DEFAULT_RX_MAX_SILENCE_MS,
  DEFAULT_RX_MIN_SPEECH_MS,
  DEFAULT_RX_PRE_ROLL_MS,
  DEFAULT_RX_START_COOLDOWN_MS,
  DEFAULT_RX_ENERGY_LOG_INTERVAL_MS,
  DEFAULT_RX_CARRIER_SENSE_THRESHOLD,
  DEFAULT_TX_CALLSIGN,
  DEFAULT_TX_POLICY,
  DEFAULT_TX_ALIASES,
  DEFAULT_TX_MAX_DURATION_MS,
  DEFAULT_TX_COURTESY_DELAY_MS,
  DEFAULT_PERSONA_NAME,
  DEFAULT_PERSONA_LOCATION,
  DEFAULT_PERSONA_CONTROL_OPERATOR,
} from "./defaults.js";

const DigirigAudioSchema = z
  .object({
    inputDevice: z.string().default(DEFAULT_AUDIO_DEVICE),
    outputDevice: z.string().default(DEFAULT_AUDIO_DEVICE),
    sampleRate: z.number().int().positive().default(DEFAULT_AUDIO_SAMPLE_RATE),
  })
  .default({});

const DigirigPttSchema = z
  .object({
    device: z.string().min(1).default(DEFAULT_PTT_DEVICE),
    rts: z.boolean().default(true),
    leadMs: z.number().int().min(0).default(DEFAULT_PTT_LEAD_MS),
    tailMs: z.number().int().min(0).default(DEFAULT_PTT_TAIL_MS),
  })
  .default({});

const DigirigRxSchema = z
  .object({
    energyThreshold: z.number().min(0).default(DEFAULT_RX_ENERGY_THRESHOLD),
    energyLogIntervalMs: z.number().int().min(0).default(DEFAULT_RX_ENERGY_LOG_INTERVAL_MS),
    frameMs: z.number().int().min(5).default(DEFAULT_RX_FRAME_MS),
    preRollMs: z.number().int().min(0).default(DEFAULT_RX_PRE_ROLL_MS),
    minSpeechMs: z.number().int().min(50).default(DEFAULT_RX_MIN_SPEECH_MS),
    maxSilenceMs: z.number().int().min(100).default(DEFAULT_RX_MAX_SILENCE_MS),
    maxRecordMs: z.number().int().min(1000).default(DEFAULT_RX_MAX_RECORD_MS),
    busyHoldMs: z.number().int().min(50).default(DEFAULT_RX_BUSY_HOLD_MS),
    startCooldownMs: z.number().int().min(0).default(DEFAULT_RX_START_COOLDOWN_MS),
    carrierSenseThreshold: z.number().min(0).default(DEFAULT_RX_CARRIER_SENSE_THRESHOLD),
  })
  .default({});

// STT runs against a local Whisper HTTP daemon on 127.0.0.1:18088 (see scripts/stt_daemon.py).
// If the daemon isn't reachable, the runtime falls back to the `whisper` CLI — slower but works.
const DigirigSttSchema = z
  .object({
    language: z.string().default("en"),
    cliFallback: z
      .object({
        command: z.string().default("whisper"),
        model: z.string().default("base"),
      })
      .default({}),
  })
  .default({});

const DigirigTxSchema = z
  .object({
    callsign: z.string().min(1).default(DEFAULT_TX_CALLSIGN),
    policy: z.enum(["direct-only", "proactive"]).default(DEFAULT_TX_POLICY),
    aliases: z.string().default(DEFAULT_TX_ALIASES),
    maxTxMs: z.number().int().min(1000).default(DEFAULT_TX_MAX_DURATION_MS),
    courtesyDelayMs: z.number().int().min(0).default(DEFAULT_TX_COURTESY_DELAY_MS),
    // Gates the `digirig_tx` agent tool when policy=proactive.
    allowToolTx: z.boolean().default(true),
  })
  .default({});

// Optional per-channel LLM override. Lets the radio session use a faster model than the
// global OpenClaw default, and (if configured) fail over to a local Ollama model when the
// primary provider is unreachable.
const DigirigLlmSchema = z
  .object({
    model: z.string().optional(),
    offlineFallbackModel: z.string().optional(),
  })
  .default({});

// Optional local TTS backend. When `engine` is "off" (default) the plugin uses
// OpenClaw's cloud TTS chain (`runtime.tts.textToSpeechTelephony`). Set to
// "piper" or "kokoro" to route through a local HTTP daemon (installed by
// scripts/setup-{piper,kokoro}-daemon.sh — both daemons can run in parallel
// on different ports and `engine` picks which the plugin talks to).
const DigirigLocalTtsSchema = z
  .object({
    engine: z.enum(["off", "piper", "kokoro"]).default("off"),
    // Override the daemon URL. If unset, defaults to
    // http://127.0.0.1:18090 (piper) or :18091 (kokoro).
    url: z.string().optional(),
    // Voice id. Piper's voice is determined by the model file loaded by the
    // daemon; this field is ignored there. Kokoro honors it — e.g. "af_sarah",
    // "am_michael", "bf_isabella".
    voice: z.string().optional(),
    // Per-request speech speed passed to the daemon. 1.0 = normal.
    speed: z.number().positive().optional(),
  })
  .default({});

// Per-instance persona. Anything the on-air AI reveals about itself — the name
// operators address it by, the location it mentions in net check-ins, the FCC
// control operator, known-operator quirks — lives here. The prompt templates
// in `src/prompt/*.ts` interpolate these values rather than hardcoding them.
const DigirigPersonaSchema = z
  .object({
    // What the AI calls itself when asked "what's your name?". Also picked up
    // as a trigger word (the first entry of `tx.aliases` is typically this).
    name: z.string().default(DEFAULT_PERSONA_NAME),
    // Where the station is. Spoken in net check-ins. Empty = omit the location
    // line from the prompt. Example: "Westside Santa Cruz".
    location: z.string().default(DEFAULT_PERSONA_LOCATION),
    // The licensed human control operator for FCC purposes. Defaults to
    // `tx.callsign` with any trailing `/AI` suffix stripped — set explicitly
    // if that derivation isn't right.
    controlOperatorCallsign: z.string().default(DEFAULT_PERSONA_CONTROL_OPERATOR),
    // Regulars with known quirks. The on-air persona adapts per entry.
    // Example: [{ callsign: "WB6DWP", note: "be cheeky and joke around" }]
    knownOperators: z
      .array(
        z.object({
          callsign: z.string().min(1),
          note: z.string().min(1),
        }),
      )
      .default([]),
  })
  .default({});

const DigirigTonesSchema = z
  .object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(500).default(2000),
    assets: z
      .object({
        standby: z.string().default("./audio/standby_short.wav"),
        error: z.string().default("./audio/error.wav"),
        beep: z.string().default("./audio/ai.wav"),
      })
      .default({}),
  })
  .default({});

export const DigirigConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  audio: z.preprocess((val) => val ?? {}, DigirigAudioSchema),
  ptt: z.preprocess((val) => val ?? {}, DigirigPttSchema),
  rx: z.preprocess((val) => val ?? {}, DigirigRxSchema),
  stt: z.preprocess((val) => val ?? {}, DigirigSttSchema),
  tx: z.preprocess((val) => val ?? {}, DigirigTxSchema),
  llm: z.preprocess((val) => val ?? {}, DigirigLlmSchema),
  localTts: z.preprocess((val) => val ?? {}, DigirigLocalTtsSchema),
  tones: z.preprocess((val) => val ?? {}, DigirigTonesSchema),
  persona: z.preprocess((val) => val ?? {}, DigirigPersonaSchema),
});

export type DigirigConfig = z.infer<typeof DigirigConfigSchema>;
