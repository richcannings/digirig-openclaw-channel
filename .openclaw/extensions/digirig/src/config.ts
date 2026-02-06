import { z } from "zod";

import {
  DEFAULT_AUDIO_CHANNELS,
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
  DEFAULT_STT_ARGS,
  DEFAULT_STT_COMMAND,
  DEFAULT_STT_TIMEOUT_MS,
} from "./defaults.js";

const DigirigAudioSchema = z
  .object({
    inputDevice: z.string().default(DEFAULT_AUDIO_DEVICE),
    outputDevice: z.string().default(DEFAULT_AUDIO_DEVICE),
    sampleRate: z.number().int().positive().default(DEFAULT_AUDIO_SAMPLE_RATE),
    channels: z.number().int().min(1).max(2).default(DEFAULT_AUDIO_CHANNELS),
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
    frameMs: z.number().int().min(5).default(DEFAULT_RX_FRAME_MS),
    preRollMs: z.number().int().min(0).default(DEFAULT_RX_PRE_ROLL_MS),
    minSpeechMs: z.number().int().min(50).default(DEFAULT_RX_MIN_SPEECH_MS),
    maxSilenceMs: z.number().int().min(100).default(DEFAULT_RX_MAX_SILENCE_MS),
    maxRecordMs: z.number().int().min(1000).default(DEFAULT_RX_MAX_RECORD_MS),
    busyHoldMs: z.number().int().min(50).default(DEFAULT_RX_BUSY_HOLD_MS),
  })
  .default({});

const DigirigSttSchema = z.object({
  command: z.string().min(1, "stt.command is required").default(DEFAULT_STT_COMMAND),
  args: z.array(z.string()).default(DEFAULT_STT_ARGS),
  timeoutMs: z.number().int().min(1000).default(DEFAULT_STT_TIMEOUT_MS),
});

export const DigirigConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  audio: DigirigAudioSchema,
  ptt: DigirigPttSchema,
  rx: DigirigRxSchema,
  stt: DigirigSttSchema,
});

export type DigirigConfig = z.infer<typeof DigirigConfigSchema>;
