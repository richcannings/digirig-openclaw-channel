import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema } from "openclaw/plugin-sdk";
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
    nativeCommands: false,
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
    isConfigured: (account) => Boolean(account.stt?.command?.trim()),
    describeAccount: (account) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account.enabled ?? true,
      configured: Boolean(account.stt?.command?.trim()),
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

export default function register(api: { runtime: unknown }) {
  setDigirigRuntime(api.runtime);
  // @ts-expect-error plugin api shape is provided by OpenClaw at runtime
  api.registerChannel({ plugin: digirigPlugin });
}

export { digirigPlugin };
