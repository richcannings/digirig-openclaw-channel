import { z } from "zod";

const DigirigAudioSchema = z
  .object({
    device: z.string().default("hw:2,0"),
    sampleRate: z.number().int().positive().default(16000),
    channels: z.number().int().min(1).max(2).default(1),
  })
  .default({});

const DigirigPttSchema = z
  .object({
    device: z.string().default("/dev/ttyUSB0"),
    rts: z.boolean().default(true),
    leadMs: z.number().int().min(0).default(120),
    tailMs: z.number().int().min(0).default(120),
  })
  .default({});

const DigirigRxSchema = z
  .object({
    energyThreshold: z.number().min(0).default(0.02),
    frameMs: z.number().int().min(5).default(20),
    preRollMs: z.number().int().min(0).default(150),
    minSpeechMs: z.number().int().min(50).default(200),
    maxSilenceMs: z.number().int().min(100).default(700),
    maxRecordMs: z.number().int().min(1000).default(10000),
    busyHoldMs: z.number().int().min(50).default(300),
  })
  .default({});

const DigirigSttSchema = z.object({
  command: z.string().min(1, "stt.command is required"),
  args: z.array(z.string()).default(["{input}"]),
  timeoutMs: z.number().int().min(1000).default(15000),
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
