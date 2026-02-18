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
  DEFAULT_STT_WS_URL,
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

const DigirigSttSchema = z.object({
  wsUrl: z.string().min(1).default(DEFAULT_STT_WS_URL),
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
