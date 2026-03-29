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
    carrierSenseThreshold: z.number().min(0).default(DEFAULT_RX_CARRIER_SENSE_THRESHOLD),
  })
  .default({});

  const DigirigSttSchema = z.object({
  localWhisper: z.object({
    command: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
  language: z.string().optional(),
  });

  const DigirigTxSchema = z
  .object({
    callsign: z.string().min(1).default(DEFAULT_TX_CALLSIGN),
    policy: z
      .enum(["direct-only", "proactive"])
      .default(DEFAULT_TX_POLICY),
    aliases: z.string().default(DEFAULT_TX_ALIASES),
    maxTxMs: z.number().int().min(1000).default(DEFAULT_TX_MAX_DURATION_MS),
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
