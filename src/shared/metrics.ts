export type AudioMetricSummary = {
  peakDb: number;
  rmsDb: number;
  clipped: boolean;
};

export function formatAudioMetrics(summary: AudioMetricSummary | null): string {
  if (!summary) return "";
  const formatDb = (value: number) =>
    Number.isFinite(value) ? value.toFixed(1) : "-∞";
  return (
    `, peak ${formatDb(summary.peakDb)} dBFS, ` +
    `RMS ${formatDb(summary.rmsDb)} dBFS, ` +
    `${summary.clipped ? "clipped" : "no clip"}`
  );
}
