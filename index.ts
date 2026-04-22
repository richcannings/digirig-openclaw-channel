import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema } from "openclaw/plugin-sdk/core";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { DigirigConfigSchema, type DigirigConfig } from "./src/config.js";
import { DEFAULT_TX_CALLSIGN } from "./src/defaults.js";
import { appendCallsign, createDigirigRuntime, type DigirigRuntime } from "./src/runtime.js";
import { getDigirigRuntime, setDigirigRuntime } from "./src/state.js";

const meta = {
  id: "digirig",
  label: "DigiRig",
  selectionLabel: "DigiRig (local audio/PTT)",
  detailLabel: "DigiRig Mobile",
  docsPath: "/channels/digirig",
  blurb: "Link to ham radio using digirig.net and monitor connection health.",
  systemImage: "dot.radiowaves.left.and.right",
};

const digirigPlugin: ChannelPlugin<DigirigConfig> = {
  id: "digirig",
  meta,
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.digirig"] },
  configSchema: buildChannelConfigSchema(DigirigConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => {
      const raw = (cfg.channels?.digirig ?? {}) as DigirigConfig;
      return DigirigConfigSchema.parse(raw);
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => {
      const digirig = (cfg.channels?.digirig ?? {}) as DigirigConfig;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          digirig: {
            ...digirig,
            enabled,
          },
        },
      };
    },
    isConfigured: (account) => true,
    describeAccount: (account) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account.enabled ?? true,
      configured: true,
    }),
  },
  status: {
    // Opt out of OpenClaw's 30-minute stale-socket health check. That check is
    // designed for network-backed chat channels (Slack, Telegram long-polling)
    // where no inbound events for 30 min means the websocket is dead. DigiRig
    // is a physical radio — 30 min of quiet on the repeater is normal
    // operation, not a reason to kill arecord and restart the channel.
    skipStaleSocketHealthCheck: true,
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastInboundAt: null,
      lastEventAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account.enabled ?? true,
      configured: true,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastEventAt: runtime?.lastEventAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      const runtime = getRuntime();
      const cfg = getDigirigRuntime().config.loadConfig();
      const callsign = cfg.channels?.digirig?.tx?.callsign ?? DEFAULT_TX_CALLSIGN;
      // Strip any [SENDER:CALLSIGN] prefix the LLM emits (see prompt/contracts.ts
      // section 9). That tag is plugin-internal metadata and must never be spoken.
      const stripped = text.replace(/^\s*\[SENDER:[A-Z0-9\/-]+\]\s*/i, "");
      await runtime.speak(appendCallsign(stripped, callsign));
      return { channel: "digirig", messageId: `digirig-${Date.now()}` };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const runtime = await ensureRuntime(ctx.account);
      return runtime.start(ctx);
    },
    stopAccount: async () => {
      if (!runtime) return;
      await runtime.stop();
      runtime = null;
      runtimePromise = null;
    },
  },
};

let runtimePromise: Promise<DigirigRuntime> | null = null;
let runtime: DigirigRuntime | null = null;

async function ensureRuntime(config: DigirigConfig): Promise<DigirigRuntime> {
  if (runtime) {
    return runtime;
  }
  if (!runtimePromise) {
    runtimePromise = createDigirigRuntime(config);
  }
  runtime = await runtimePromise;
  return runtime;
}

function getRuntime(): DigirigRuntime {
  if (!runtime) {
    throw new Error("DigiRig runtime not initialized");
  }
  return runtime;
}

export default function register(api: { runtime: unknown; registerCommand: Function; registerTool: Function }) {
  setDigirigRuntime(api.runtime);
  // @ts-expect-error plugin api shape is provided by OpenClaw at runtime
  api.registerChannel({ plugin: digirigPlugin });

  const usage = "Usage: /digirig tx <text> | /digirig unkey | /digirig doctor | /digirig setup";

  const handleDigirigCommand = async (ctx: { args?: string }) => {
    const raw = (ctx.args ?? "").trim();
    if (!raw) {
      return { text: usage };
    }
    const [cmd, ...rest] = raw.split(/\s+/);
    const action = cmd.toLowerCase();
    if (action === "tx") {
      const text = rest.join(" ").trim();
      if (!text) {
        return { text: "Usage: /digirig tx <text>" };
      }
      const runtime = getRuntime();
      const cfg = getDigirigRuntime().config.loadConfig();
      const callsign = cfg.channels?.digirig?.tx?.callsign ?? DEFAULT_TX_CALLSIGN;
      await runtime.speak(appendCallsign(text, callsign));
      return { text: "Transmitted via DigiRig" };
    }

    if (action === "unkey") {
      if (!runtime) {
        return { text: "DigiRig runtime is not running — nothing to unkey." };
      }
      const { cancelledJobs } = await runtime.emergencyUnkey();
      return {
        text: cancelledJobs > 0
          ? `PTT released. Cancelled ${cancelledJobs} queued TX job${cancelledJobs === 1 ? "" : "s"}.`
          : "PTT released.",
      };
    }

    if (action === "doctor") {
      const cfg = getDigirigRuntime().config.loadConfig();
      const ttsEngine = cfg.channels?.digirig?.localTts?.engine ?? "off";
      const [listener, audioIn, audioOut, serial] = await Promise.all([
        runShellCapture("ss", ["-ltn"]),
        runShellCapture("arecord", ["-l"]),
        runShellCapture("aplay", ["-l"]),
        runShellCapture("bash", ["-lc", "ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | head -n 1"]),
      ]);
      const sttListening = listener.stdout.includes(":18088");
      const txApiListening = listener.stdout.includes(":18089");
      const piperListening = listener.stdout.includes(":18090");
      const kokoroListening = listener.stdout.includes(":18091");
      const inputDevice = detectLikelyAlsaDevice(audioIn.stdout) ?? "plughw:0,0";
      const outputDevice = detectLikelyAlsaDevice(audioOut.stdout) ?? "plughw:0,0";
      const pttDevice = serial.stdout.trim() || "/dev/ttyUSB0";

      // Flag only the TTS daemon the plugin is currently configured to use.
      // Other daemons being up/down is informational rather than blocking.
      const ttsLines: string[] = [];
      if (ttsEngine === "piper") {
        ttsLines.push(`- TTS engine: piper (127.0.0.1:18090) — ${piperListening ? "listening" : "NOT LISTENING — run bash scripts/setup-piper-daemon.sh"}`);
      } else if (ttsEngine === "kokoro") {
        ttsLines.push(`- TTS engine: kokoro (127.0.0.1:18091) — ${kokoroListening ? "listening" : "NOT LISTENING — run bash scripts/setup-kokoro-daemon.sh"}`);
      } else {
        ttsLines.push(`- TTS engine: cloud (localTts.engine=off) — requires an OpenClaw speech provider configured under messages.tts.providers.*`);
        if (piperListening) ttsLines.push(`  (note: Piper daemon IS running on :18090 — set localTts.engine=piper to use it)`);
        if (kokoroListening) ttsLines.push(`  (note: Kokoro daemon IS running on :18091 — set localTts.engine=kokoro to use it)`);
      }

      const lines = [
        "DigiRig doctor:",
        `- STT daemon (127.0.0.1:18088): ${sttListening ? "listening" : "not listening (falls back to whisper CLI)"}`,
        `- TX API (127.0.0.1:18089): ${txApiListening ? "listening" : "not listening — is the gateway running?"}`,
        ...ttsLines,
        `- detected input device: ${inputDevice}`,
        `- detected output device: ${outputDevice}`,
        `- detected PTT serial: ${pttDevice}`,
        "",
        "If the STT daemon isn't running: bash scripts/setup-stt-daemon.sh",
        "If the TX API isn't running:     openclaw gateway restart",
        "Full guided install:             bash scripts/setup.sh",
      ];
      return { text: lines.join("\n") };
    }

    if (action === "setup") {
      const audioIn = await runShellCapture("arecord", ["-l"]);
      const audioOut = await runShellCapture("aplay", ["-l"]);
      const serial = await runShellCapture("bash", ["-lc", "ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | head -n 1"]);
      const inputDevice = detectLikelyAlsaDevice(audioIn.stdout) ?? "plughw:0,0";
      const outputDevice = detectLikelyAlsaDevice(audioOut.stdout) ?? "plughw:0,0";
      const pttDevice = serial.stdout.trim() || "/dev/ttyUSB0";

      const lines = [
        "Quick setup commands:",
        "",
        "# Hardware",
        `openclaw config set channels.digirig.audio.inputDevice "${inputDevice}"`,
        `openclaw config set channels.digirig.audio.outputDevice "${outputDevice}"`,
        `openclaw config set channels.digirig.ptt.device "${pttDevice}"`,
        "openclaw config set channels.digirig.ptt.rts true",
        "",
        "# Identity (REQUIRED — the defaults are generic placeholders)",
        'openclaw config set channels.digirig.tx.callsign "YOURCALL/AI"',
        'openclaw config set channels.digirig.tx.aliases "Seven,7,Overlord"',
        'openclaw config set channels.digirig.persona.name "Seven"',
        'openclaw config set channels.digirig.persona.location "Your City, State"',
        '# Known operators (optional):',
        '# openclaw config set channels.digirig.persona.knownOperators \'[{"callsign":"WB6DWP","note":"be cheeky - have fun with this operator"}]\'',
        "",
        "openclaw gateway restart",
        "",
        "Then run: /digirig doctor",
      ];
      return { text: lines.join("\n") };
    }

    return { text: usage };
  };

  // Manual TX command: /digirig tx <text>
  // @ts-expect-error plugin api shape is provided by OpenClaw at runtime
  api.registerCommand({
    name: "digirig",
    description: "DigiRig commands (tx, unkey, doctor, setup)",
    acceptsArgs: true,
    requireAuth: false,
    handler: handleDigirigCommand,
  });

  // Alias: /digiread ...
  // @ts-expect-error plugin api shape is provided by OpenClaw at runtime
  api.registerCommand({
    name: "digiread",
    description: "Alias for /digirig",
    acceptsArgs: true,
    requireAuth: false,
    handler: handleDigirigCommand,
  });

  // Agent tool: digirig_tx
  // @ts-expect-error plugin api shape is provided by OpenClaw at runtime
  api.registerTool({
    name: "digirig_tx",
    label: "DigiRig TX",
    description: "Transmit text over DigiRig (respects tx.policy=proactive).",
    parameters: Type.Object({
      text: Type.String({ description: "Text to transmit over DigiRig" }),
      callsign: Type.Optional(Type.String({ description: "Override callsign" })),
    }),
    async execute(_toolCallId: string, params: { text?: string; callsign?: string }) {
      const json = (payload: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });
      const text = String(params?.text ?? "").trim();
      if (!text) {
        throw new Error("text is required");
      }
      const cfg = getDigirigRuntime().config.loadConfig();
      const policy = cfg.channels?.digirig?.tx?.policy ?? "direct-only";
      if (policy !== "proactive") {
        throw new Error("digirig_tx requires tx.policy=proactive");
      }
      const allowToolTx = cfg.channels?.digirig?.tx?.allowToolTx ?? true;
      if (!allowToolTx) {
        throw new Error("digirig_tx is disabled by tx.allowToolTx=false");
      }
      const callsign = (params?.callsign ?? cfg.channels?.digirig?.tx?.callsign ?? DEFAULT_TX_CALLSIGN).trim();
      const runtime = getRuntime();
      await runtime.speak(appendCallsign(text, callsign));
      return json({ ok: true, transmitted: true });
    },
  });
}

async function runShellCapture(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: `${stderr}${String(err)}`, code: null });
    });
    proc.on("exit", (code) => {
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function detectLikelyAlsaDevice(output: string): string | null {
  const lines = output.split(/\r?\n/);
  const devices: Array<{ card: number; dev: number; line: string; score: number }> = [];

  for (const line of lines) {
    const match = line.match(/card\s+(\d+)\s*:[^,]*,\s*device\s+(\d+)\s*:/i);
    if (!match) continue;
    const card = Number(match[1]);
    const dev = Number(match[2]);
    const lower = line.toLowerCase();
    let score = 0;
    if (lower.includes("usb pnp sound device")) score += 100;
    if (lower.includes("usb audio")) score += 80;
    if (lower.includes("device")) score += 30;
    devices.push({ card, dev, line, score });
  }

  if (!devices.length) return null;
  devices.sort((a, b) => b.score - a.score || a.card - b.card || a.dev - b.dev);
  const best = devices[0];
  return `plughw:${best.card},${best.dev}`;
}

export { digirigPlugin };
