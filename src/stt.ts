export type SttConfig = {
  timeoutMs: number;
  streamUrl: string;
  streamIntervalMs: number;
  streamWindowMs: number;
};

export async function runSttStream(params: {
  config: SttConfig;
  wavBuffer: Buffer;
}): Promise<string> {
  const { config, wavBuffer } = params;
  const url = config.streamUrl;

  const form = new FormData();
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  form.append("file", blob, "audio.wav");
  form.append("audio_file", blob, "audio.wav");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(bodyText || `STT stream failed (${res.status})`);
    }
    try {
      const parsed = JSON.parse(bodyText);
      const text = parsed?.text ?? parsed?.result ?? "";
      return String(text).trim();
    } catch {
      return bodyText.trim();
    }
  } finally {
    clearTimeout(timeout);
  }
}
