# Shared Helpers Refactor Plan (DigiRig)

## Goal
Extract a small set of shared helpers (text parsing + metric formatting) into `src/shared/` so runtime logic stays focused and we avoid duplicating small utilities.

## Scope
- **Move** text normalization + call‑detection helpers into `src/shared/text.ts`.
- **Move** audio metric formatting into `src/shared/metrics.ts`.
- **Update** `src/runtime.ts` to import and use these helpers.

## Proposed Files
```
src/shared/
  text.ts      # parseAliases, isDirectCall, formatRadioReply, normalizeSttText
  metrics.ts   # AudioMetricSummary + formatAudioMetrics
```

## Line Counts (planned)
- **src/shared/text.ts**: +49 lines (new)
- **src/shared/metrics.ts**: +16 lines (new)
- **src/runtime.ts**: –80 lines (remove local helper defs; add imports + helper usage)

**Total:** +65 / –80 → **net –15 lines**

> Note: exact counts are based on draft files and diff below.

---

## Patch (draft)
```diff
diff --git a/src/runtime.ts b/src/runtime.ts
index 6ab9820..346ce36 100644
--- a/src/runtime.ts
+++ b/src/runtime.ts
@@ -5,10 +5,12 @@ import { join } from "node:path";
 import { createReplyPrefixOptions, type ChannelGatewayStartContext } from "openclaw/plugin-sdk";
 import { getDigirigRuntime } from "./state.js";
 import type { DigirigConfig } from "./config.js";
-import { AudioMonitor } from "./audio-monitor.js";
+import { AudioMonitor, computeRms } from "./audio-monitor.js";
 import { PttController } from "./ptt.js";
 import { WhisperLiveClient } from "./stt-ws.js";
 import { playPcm, synthesizeTts } from "./tts.js";
+import { formatAudioMetrics, type AudioMetricSummary } from "./shared/metrics.js";
+import { formatRadioReply, isDirectCall, normalizeSttText, parseAliases } from "./shared/text.js";
@@ -24,62 +26,6 @@ export function appendCallsign(text: string, callsign?: string): string {
   return `${trimmed} ${callsign}`;
 }
-
-function parseAliases(input?: string): string[] {
-  if (!input) return [];
-  return input
-    .split(",")
-    .map((part) => part.trim())
-    .filter(Boolean);
-}
-
-function isDirectCall(text: string, callsign?: string, aliases: string[] = []): boolean {
-  const upper = text.toUpperCase();
-  const needles = [callsign, ...aliases].filter(Boolean) as string[];
-  if (!needles.length) return false;
-  const textBare = upper.replace(/[^A-Z0-9]/g, "");
-  return needles.some((needle) => {
-    const call = needle.toUpperCase();
-    if (upper.includes(call)) return true;
-    const callBare = call.replace(/[^A-Z0-9]/g, "");
-    return callBare.length > 0 && textBare.includes(callBare);
-  });
-}
-
-
-export type DigirigRuntime = {
-  start: (ctx: ChannelGatewayStartContext<DigirigConfig>) => Promise<{ stop: () => void }>;
-  stop: () => Promise<void>;
-  speak: (text: string) => Promise<void>;
-};
-
-function formatRadioReply(text: string, maxChars = 140): string {
-  const trimmed = text.trim().replace(/\s+/g, " ");
-  if (!trimmed) {
-    return "";
-  }
-  const sentenceMatch = trimmed.match(/^(.+?[\.!\?])(\s|$)/);
-  const base = sentenceMatch ? sentenceMatch[1] : trimmed;
-  return base.slice(0, maxChars).trim();
-}
-
-function normalizeSttText(text: string): string {
-  const trimmed = text.trim();
-  if (!trimmed) return "";
-  const lower = trimmed.toLowerCase();
-  if (lower === "[blank_audio]" || lower === "(blank audio)") return "";
-  if (/\bbeep\b/i.test(trimmed)) return "";
-  if (/^\s*[\[(].*[\])]\s*$/.test(trimmed)) return "";
-
-  // Drop stray 1–3 character prefix fragments (e.g., "GC.") when followed by a sentence.
-  const tokens = trimmed.split(/\s+/);
-  if (tokens.length > 1 && tokens[0].length <= 3) {
-    const remainder = tokens.slice(1).join(" ");
-    if (remainder.length >= 12) {
-      return remainder.trim();
-    }
-  }
-  return trimmed;
-}
@@ -155,6 +101,7 @@ export async function createDigirigRuntime(config: DigirigConfig): Promise<Digir
   let lastRxEndReason: string | null = null;
   let rxChunks: string[] = [];
   let inferredAliases: string[] = [];
+  let lastRxMetrics: AudioMetricSummary | null = null;
@@ -486,11 +445,15 @@ export async function createDigirigRuntime(config: DigirigConfig): Promise<Digir
       if (responseTimeMs !== null) {
         const metricTs = new Date().toISOString();
         ctx.log?.info?.(`[digirig] responseTimeMs=${responseTimeMs}`);
-        await appendTranscript(`[${metricTs}] METRIC: responseTimeMs=${responseTimeMs}`);
+        const audioMetric = formatAudioMetrics(lastRxMetrics);
+        await appendTranscript(
+          `[${metricTs}] METRIC: responseTimeMs=${responseTimeMs}${audioMetric}`,
+        );
       }
       rxBuffer = [];
       rxStartAt = 0;
       rxFinalized = true;
+      lastRxMetrics = null;
@@ -548,10 +511,17 @@ export async function createDigirigRuntime(config: DigirigConfig): Promise<Digir
-    audioMonitor.on("utterance", async (_utterance) => {
+    audioMonitor.on("utterance", async (utterance) => {
       if (rxFinalized) {
         return;
       }
+      const rms = computeRms(utterance.pcm);
+      const peak = computePeak(utterance.pcm);
+      lastRxMetrics = {
+        rmsDb: toDbfs(rms),
+        peakDb: toDbfs(peak),
+        clipped: peak >= 0.99,
+      };
@@ -615,6 +588,121 @@ export async function createDigirigRuntime(config: DigirigConfig): Promise<Digir
     };
   };
@@ -622,7 +710,74 @@ export async function createDigirigRuntime(config: DigirigConfig): Promise<Digir
-  return { start, stop, speak };
+  return { start, stop, speak, calibrateRx };
+}
+
+function computePeak(frame: Buffer): number {
+  if (frame.length < 2) {
+    return 0;
+  }
+  let max = 0;
+  for (let i = 0; i < frame.length; i += 2) {
+    const sample = Math.abs(frame.readInt16LE(i)) / 32768;
+    if (sample > max) max = sample;
+  }
+  return max;
+}
+
+function toDbfs(value: number): number {
+  if (value <= 0) return -Infinity;
+  return 20 * Math.log10(value);
+}
+
+async function captureWindowSample(
+  monitor: AudioMonitor,
+  level: number,
+  windowMs: number,
+  timeoutMs: number,
+): Promise<CalibrationSample> {
+  return await new Promise<CalibrationSample>((resolve, reject) => {
+    let sumSquares = 0;
+    let sampleCount = 0;
+    let peak = 0;
+    const startAt = Date.now();
+
+    const stop = () => {
+      monitor.removeListener("frame", handler);
+    };
+
+    const finish = () => {
+      stop();
+      const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
+      const rmsDb = toDbfs(rms);
+      const peakDb = toDbfs(peak);
+      const clipped = peak >= 0.99;
+      const durationMs = Date.now() - startAt;
+      resolve({ level, rms, peak, rmsDb, peakDb, clipped, durationMs });
+    };
+
+    const timeout = setTimeout(() => {
+      stop();
+      reject(new Error("Calibration timed out waiting for RX audio"));
+    }, Math.max(1000, timeoutMs));
+
+    const windowTimer = setTimeout(() => {
+      clearTimeout(timeout);
+      finish();
+    }, Math.max(1000, windowMs));
+
+    const handler = (frame: Buffer) => {
+      for (let i = 0; i < frame.length; i += 2) {
+        const sample = frame.readInt16LE(i) / 32768;
+        const abs = Math.abs(sample);
+        if (abs > peak) peak = abs;
+        sumSquares += sample * sample;
+        sampleCount += 1;
+      }
+    };
+
+    monitor.on("frame", handler);
+  });
+}
@@ -630,6 +785,11 @@ type CaptureMuteConfig = {
   control: string;
 };
+
+type CaptureLevelConfig = {
+  card: number;
+  control: string;
+};
+
+diff --git a/src/shared/metrics.ts b/src/shared/metrics.ts
+new file mode 100644
+index 0000000..b3f8c2a
+--- /dev/null
++++ b/src/shared/metrics.ts
+@@ -0,0 +1,16 @@
+export type AudioMetricSummary = {
+  peakDb: number;
+  rmsDb: number;
+  clipped: boolean;
+};
+
+export function formatAudioMetrics(summary: AudioMetricSummary | null): string {
+  if (!summary) return "";
+  const formatDb = (value: number) =>
+    Number.isFinite(value) ? value.toFixed(1) : "-∞";
+  return (
+    `, peak ${formatDb(summary.peakDb)} dBFS, ` +
+    `RMS ${formatDb(summary.rmsDb)} dBFS, ` +
+    `${summary.clipped ? "clipped" : "no clip"}`
+  );
+}
+
+diff --git a/src/shared/text.ts b/src/shared/text.ts
+new file mode 100644
+index 0000000..fd1a2b4
+--- /dev/null
++++ b/src/shared/text.ts
+@@ -0,0 +1,49 @@
+export function parseAliases(input?: string): string[] {
+  if (!input) return [];
+  return input
+    .split(",")
+    .map((part) => part.trim())
+    .filter(Boolean);
+}
+
+export function isDirectCall(text: string, callsign?: string, aliases: string[] = []): boolean {
+  const upper = text.toUpperCase();
+  const needles = [callsign, ...aliases].filter(Boolean) as string[];
+  if (!needles.length) return false;
+  const textBare = upper.replace(/[^A-Z0-9]/g, "");
+  return needles.some((needle) => {
+    const call = needle.toUpperCase();
+    if (upper.includes(call)) return true;
+    const callBare = call.replace(/[^A-Z0-9]/g, "");
+    return callBare.length > 0 && textBare.includes(callBare);
+  });
+}
+
+export function formatRadioReply(text: string, maxChars = 140): string {
+  const trimmed = text.trim().replace(/\s+/g, " ");
+  if (!trimmed) {
+    return "";
+  }
+  const sentenceMatch = trimmed.match(/^(.+?[\.!\?])(\s|$)/);
+  const base = sentenceMatch ? sentenceMatch[1] : trimmed;
+  return base.slice(0, maxChars).trim();
+}
+
+export function normalizeSttText(text: string): string {
+  const trimmed = text.trim();
+  if (!trimmed) return "";
+  const lower = trimmed.toLowerCase();
+  if (lower === "[blank_audio]" || lower === "(blank audio)") return "";
+  if (/\bbeep\b/i.test(trimmed)) return "";
+  if (/^\s*[\[(].*[\])]\s*$/.test(trimmed)) return "";
+
+  // Drop stray 1–3 character prefix fragments (e.g., "GC.") when followed by a sentence.
+  const tokens = trimmed.split(/\s+/);
+  if (tokens.length > 1 && tokens[0].length <= 3) {
+    const remainder = tokens.slice(1).join(" ");
+    if (remainder.length >= 12) {
+      return remainder.trim();
+    }
+  }
+  return trimmed;
+}
+```
