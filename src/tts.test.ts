// Component tests for the TTS routing layer.
//
// We spin up a real in-process HTTP server to stand in for the Piper / Kokoro
// daemon — that way we exercise the same fetch/header/Buffer path the runtime
// uses in production, without shelling out to Python.
//
// The cloud-TTS fallback path is tested with a minimal hand-rolled mock for
// `runtime.tts.textToSpeechTelephony`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DigirigConfigSchema, type DigirigConfig } from "./config.js";
import { synthesizeTts } from "./tts.js";

// ─── test harness: in-process TTS daemon ──────────────────────────────────

type HandlerRecord = {
  reqBody: string;
  reqMethod: string;
  reqUrl: string;
};

type FakeDaemon = {
  server: Server;
  url: string;
  requests: HandlerRecord[];
};

function startFakeDaemon(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  return new Promise<FakeDaemon>((resolve) => {
    const requests: HandlerRecord[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        requests.push({ reqBody: body, reqMethod: req.method ?? "", reqUrl: req.url ?? "" });
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function stopFakeDaemon(d: FakeDaemon) {
  return new Promise<void>((resolve) => d.server.close(() => resolve()));
}

// ─── config helper ────────────────────────────────────────────────────────

function makeConfig(localTts: Partial<DigirigConfig["localTts"]> = {}): DigirigConfig {
  return DigirigConfigSchema.parse({ localTts });
}

// ─── minimal fake PluginRuntime ───────────────────────────────────────────
// runtime only needs `.tts.textToSpeechTelephony` and `.config` on the cloud
// path; the local path doesn't touch it at all.

type FakeCloudTtsOutcome =
  | { success: true; audioBuffer: Buffer; sampleRate: number }
  | { success: false; error: string };

function fakeRuntimeForCloud(outcome: FakeCloudTtsOutcome, recordCalls?: string[]): any {
  return {
    config: {} as any,
    tts: {
      textToSpeechTelephony: async ({ text }: { text: string }) => {
        recordCalls?.push(text);
        return outcome;
      },
    },
  };
}

// ─── tests ────────────────────────────────────────────────────────────────

describe("synthesizeTts — cloud path (localTts.engine=off)", () => {
  it("uses runtime.tts.textToSpeechTelephony and returns its audioBuffer", async () => {
    const calls: string[] = [];
    const pcm = Buffer.alloc(1024, 1);
    const runtime = fakeRuntimeForCloud(
      { success: true, audioBuffer: pcm, sampleRate: 8000 },
      calls,
    );
    const out = await synthesizeTts(runtime, "Roger, over.", makeConfig({ engine: "off" }));
    expect(calls).toEqual(["Roger, over."]);
    expect(out.audioBuffer).toBe(pcm);
    expect(out.sampleRate).toBe(8000);
  });

  it("also takes the cloud path when localTts is absent entirely", async () => {
    const pcm = Buffer.alloc(16, 2);
    const runtime = fakeRuntimeForCloud({ success: true, audioBuffer: pcm, sampleRate: 16000 });
    const out = await synthesizeTts(runtime, "hi", makeConfig());
    expect(out.sampleRate).toBe(16000);
  });

  it("throws when the cloud provider reports failure", async () => {
    const runtime = fakeRuntimeForCloud({ success: false, error: "no_provider_registered" });
    await expect(
      synthesizeTts(runtime, "hi", makeConfig({ engine: "off" })),
    ).rejects.toThrow(/no_provider_registered/);
  });

  it("throws a descriptive error when the runtime has no TTS seam", async () => {
    const runtime = { config: {}, tts: {} } as any;
    await expect(synthesizeTts(runtime, "hi", makeConfig({ engine: "off" }))).rejects.toThrow(
      /textToSpeechTelephony/,
    );
  });
});

describe("synthesizeTts — local path (engine=piper|kokoro)", () => {
  let daemon: FakeDaemon | undefined;

  afterEach(async () => {
    if (daemon) {
      await stopFakeDaemon(daemon);
      daemon = undefined;
    }
  });

  it("POSTs JSON to /tts and returns the PCM body + sampleRate header", async () => {
    const canned = Buffer.alloc(2048, 7);
    daemon = await startFakeDaemon((req, res) => {
      res.writeHead(200, {
        "Content-Type": "audio/l16",
        "X-Sample-Rate": "22050",
        "X-Channels": "1",
      });
      res.end(canned);
    });

    const out = await synthesizeTts(
      {} as any,
      "Five by nine, over.",
      makeConfig({ engine: "piper", url: daemon.url }),
    );
    expect(out.audioBuffer.length).toBe(canned.length);
    expect(out.audioBuffer.equals(canned)).toBe(true);
    expect(out.sampleRate).toBe(22050);

    // Request shape
    expect(daemon.requests.length).toBe(1);
    expect(daemon.requests[0].reqMethod).toBe("POST");
    expect(daemon.requests[0].reqUrl).toBe("/tts");
    expect(JSON.parse(daemon.requests[0].reqBody)).toEqual({ text: "Five by nine, over." });
  });

  it("passes `voice` and `speed` through to the daemon body when configured", async () => {
    daemon = await startFakeDaemon((_req, res) => {
      res.writeHead(200, { "X-Sample-Rate": "24000" });
      res.end(Buffer.alloc(8));
    });

    await synthesizeTts(
      {} as any,
      "hello",
      makeConfig({ engine: "kokoro", url: daemon.url, voice: "am_michael", speed: 1.15 }),
    );
    const body = JSON.parse(daemon.requests[0].reqBody);
    expect(body.voice).toBe("am_michael");
    expect(body.speed).toBe(1.15);
  });

  it("omits voice/speed from the body when they aren't configured", async () => {
    daemon = await startFakeDaemon((_req, res) => {
      res.writeHead(200, { "X-Sample-Rate": "22050" });
      res.end(Buffer.alloc(8));
    });
    await synthesizeTts({} as any, "hi", makeConfig({ engine: "piper", url: daemon.url }));
    const body = JSON.parse(daemon.requests[0].reqBody);
    expect(body).toEqual({ text: "hi" });
  });

  it("defaults sampleRate to 22050 if the daemon omits X-Sample-Rate", async () => {
    daemon = await startFakeDaemon((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(4));
    });
    const out = await synthesizeTts(
      {} as any,
      "hi",
      makeConfig({ engine: "piper", url: daemon.url }),
    );
    expect(out.sampleRate).toBe(22050);
  });

  it("throws with a connect-refused hint when the daemon is down", async () => {
    // Nothing listening on this port; don't start a daemon.
    await expect(
      synthesizeTts(
        {} as any,
        "hi",
        makeConfig({ engine: "piper", url: "http://127.0.0.1:1" }), // reserved low port
      ),
    ).rejects.toThrow(/piper/);
  });

  it("surfaces a non-2xx daemon error body", async () => {
    daemon = await startFakeDaemon((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "synthesis failed: voice not found" }));
    });
    await expect(
      synthesizeTts({} as any, "hi", makeConfig({ engine: "kokoro", url: daemon.url })),
    ).rejects.toThrow(/kokoro.*500.*voice not found/);
  });

  it("throws when the daemon returns an empty body (zero PCM)", async () => {
    daemon = await startFakeDaemon((_req, res) => {
      res.writeHead(200, { "X-Sample-Rate": "22050" });
      res.end();
    });
    await expect(
      synthesizeTts({} as any, "hi", makeConfig({ engine: "piper", url: daemon.url })),
    ).rejects.toThrow(/empty audio/);
  });
});
