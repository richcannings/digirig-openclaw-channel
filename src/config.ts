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
  DEFAULT_TX_CALLSIGN,
  DEFAULT_TX_POLICY,
  DEFAULT_TX_ALIASES,
  DEFAULT_STT_TIMEOUT_MS,
  DEFAULT_STT_STREAM_URL,
  DEFAULT_STT_STREAM_INTERVAL_MS,
  DEFAULT_STT_STREAM_WINDOW_MS,
  DEFAULT_STT_SERVER_AUTOSTART,
  DEFAULT_STT_SERVER_COMMAND,
  DEFAULT_STT_SERVER_ARGS,
  DEFAULT_STT_SERVER_MODEL_PATH,
  DEFAULT_STT_SERVER_HOST,
  DEFAULT_STT_SERVER_PORT,
  DEFAULT_STT_SERVER_RESTART_MS,
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
    device: z.string().default(DEFAULT_PTT_DEVICE),
    rts: z.boolean().default(true),
    leadMs: z.number().int().min(0).default(DEFAULT_PTT_LEAD_MS),
    tailMs: z.number().int().min(0).default(DEFAULT_PTT_TAIL_MS),
  })
  .default({});

const DigirigRxSchema = z
  .object({
    energyThreshold: z.number().min(0).default(DEFAULT_RX_ENERGY_THRESHOLD),
    energyLogIntervalMs: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_RX_ENERGY_LOG_INTERVAL_MS),
    frameMs: z.number().int().min(5).default(DEFAULT_RX_FRAME_MS),
    preRollMs: z.number().int().min(0).default(DEFAULT_RX_PRE_ROLL_MS),
    minSpeechMs: z.number().int().min(50).default(DEFAULT_RX_MIN_SPEECH_MS),
    maxSilenceMs: z.number().int().min(100).default(DEFAULT_RX_MAX_SILENCE_MS),
    maxRecordMs: z.number().int().min(1000).default(DEFAULT_RX_MAX_RECORD_MS),
    busyHoldMs: z.number().int().min(50).default(DEFAULT_RX_BUSY_HOLD_MS),
    startCooldownMs: z.number().int().min(0).default(DEFAULT_RX_START_COOLDOWN_MS),
  })
  .default({});

const DigirigSttServerSchema = z
  .object({
    autoStart: z.boolean().default(DEFAULT_STT_SERVER_AUTOSTART),
    command: z.string().min(1).default(DEFAULT_STT_SERVER_COMMAND),
    args: z.string().default(DEFAULT_STT_SERVER_ARGS),
    modelPath: z.string().default(DEFAULT_STT_SERVER_MODEL_PATH),
    host: z.string().default(DEFAULT_STT_SERVER_HOST),
    port: z.number().int().min(1).default(DEFAULT_STT_SERVER_PORT),
    restartMs: z.number().int().min(0).default(DEFAULT_STT_SERVER_RESTART_MS),
  })
  .default({});

const DigirigSttSchema = z.object({
  timeoutMs: z.number().int().min(1000).default(DEFAULT_STT_TIMEOUT_MS),
  streamUrl: z.string().url().default(DEFAULT_STT_STREAM_URL),
  streamIntervalMs: z
    .number()
    .int()
    .min(100)
    .default(DEFAULT_STT_STREAM_INTERVAL_MS),
  streamWindowMs: z
    .number()
    .int()
    .min(500)
    .default(DEFAULT_STT_STREAM_WINDOW_MS),
  server: z.preprocess((val) => val ?? {}, DigirigSttServerSchema),
});

const DigirigTxSchema = z
  .object({
    callsign: z.string().min(1).default(DEFAULT_TX_CALLSIGN),
    policy: z
      .enum(["direct-only", "value-and-wait", "proactive"])
      .default(DEFAULT_TX_POLICY),
    aliases: z.string().default(DEFAULT_TX_ALIASES),
  })
  .default({});

export const DigirigConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  audio: z.preprocess((val) => val ?? {}, DigirigAudioSchema),
  ptt: z.preprocess((val) => val ?? {}, DigirigPttSchema),
  rx: z.preprocess((val) => val ?? {}, DigirigRxSchema),
  stt: z.preprocess((val) => val ?? {}, DigirigSttSchema),
  tx: z.preprocess((val) => val ?? {}, DigirigTxSchema),
});

export type DigirigConfig = z.infer<typeof DigirigConfigSchema>;
