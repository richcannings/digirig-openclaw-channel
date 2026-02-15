import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
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
    isConfigured: (account) => Boolean(account.stt?.streamUrl?.trim()),
    describeAccount: (account) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account.enabled ?? true,
      configured: Boolean(account.stt?.streamUrl?.trim()),
    }),
  },
  status: {
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
      configured: Boolean(account.stt?.streamUrl?.trim()),
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
      await runtime.speak(appendCallsign(text, callsign));
      return { channel: "digirig", messageId: `digirig-${Date.now()}` };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const runtime = await ensureRuntime(ctx.account);
      return runtime.start(ctx);
    },
    stopAccount: async () => {
      const runtime = getRuntime();
      await runtime.stop();
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

  // Manual TX command: /digirig tx <text>
  // @ts-expect-error plugin api shape is provided by OpenClaw at runtime
  api.registerCommand({
    name: "digirig",
    description: "DigiRig commands (tx)",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: { args?: string }) => {
      const raw = (ctx.args ?? "").trim();
      if (!raw) {
        return { text: "Usage: /digirig tx <text>" };
      }
      const [cmd, ...rest] = raw.split(/\s+/);
      if (cmd.toLowerCase() !== "tx") {
        return { text: "Usage: /digirig tx <text>" };
      }
      const text = rest.join(" ").trim();
      if (!text) {
        return { text: "Usage: /digirig tx <text>" };
      }
      const runtime = getRuntime();
      const cfg = getDigirigRuntime().config.loadConfig();
      const callsign = cfg.channels?.digirig?.tx?.callsign ?? DEFAULT_TX_CALLSIGN;
      await runtime.speak(appendCallsign(text, callsign));
      return { text: "✅ Transmitted via DigiRig" };
    },
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

export { digirigPlugin };
