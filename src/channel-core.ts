import { createReplyPrefixOptions } from "openclaw/plugin-sdk/channel-runtime";

export function createRadioContextPayload(
  runtime: any,
  cfg: any,
  route: any,
  text: string,
  radioPrompt: string,
) {
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "DigiRig",
    from: "radio",
    timestamp: Date.now(),
    envelope: envelopeOptions,
    body: text,
  });

  const radioSessionKey = "digirig:radio";
  return runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: text,
    CommandBody: text,
    BodyForAgent: `${radioPrompt}\n\n${text}`,
    BodyForCommands: text,
    CommandSource: "channel",
    CommandTargetSessionKey: radioSessionKey,
    From: "digirig:radio",
    To: "digirig:radio",
    SessionKey: radioSessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: "radio",
    SenderName: "radio",
    SenderId: "radio",
    Provider: "digirig",
    Surface: "digirig",
    MessageSid: `digirig-${Date.now()}`,
    OriginatingChannel: "digirig",
    OriginatingTo: "digirig:radio",
    CommandAuthorized: true,
  });
}

export async function recordInboundSession(runtime: any, cfg: any, route: any, ctxPayload: any, log: any) {
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => log?.error?.(`[digirig] session record error: ${String(err)}`),
  });
}

export async function dispatchRadioReply(params: {
  runtime: any;
  cfg: any;
  route: any;
  ctxPayload: any;
  deliver: (payload: { text?: string }) => Promise<void>;
  log: any;
}) {
  const { runtime, cfg, route, ctxPayload, deliver, log } = params;

  // Clone config to apply LLM override for radio
  const radioCfg = JSON.parse(JSON.stringify(cfg));
  const digirigCfg = radioCfg.channels?.digirig ?? {};
  const modelOverride = digirigCfg.llm?.model;
  const offlineFallback = digirigCfg.llm?.offlineFallbackModel;

  if (modelOverride && radioCfg.agents?.list) {
    const agent = radioCfg.agents.list.find((a: any) => a.id === route.agentId);
    if (agent) {
      if (!agent.model) agent.model = {};
      agent.model.primary = modelOverride;
      if (offlineFallback) {
        agent.model.fallbacks = [offlineFallback, ...(agent.model.fallbacks || [])];
      }
      log?.info?.(`[digirig] Overriding route agent model to: ${modelOverride} (fallback: ${offlineFallback || "none"})`);
    }
  }

  let prefixOptions: any = {};
  let onModelSelected: any = undefined;
  if (typeof createReplyPrefixOptions === "function") {
    const opts = createReplyPrefixOptions({
      cfg: radioCfg,
      agentId: route.agentId,
      channel: "digirig",
      accountId: route.accountId,
    });
    onModelSelected = opts.onModelSelected;
    const { onModelSelected: _, ...rest } = opts;
    prefixOptions = rest;
  }

  return runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: radioCfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver,
      onError: (err: unknown, info: { kind: string }) =>
        log?.error?.(`[digirig] ${info.kind} reply failed: ${String(err)}`),
    },
    replyOptions: {
      onModelSelected: (selected: any) => {
        log?.info?.(`[digirig] Model selected for reply: ${selected.provider}/${selected.model}`);
        if (onModelSelected) onModelSelected(selected);
      },
      onAgentRunStart: (runId: string) => log?.info?.(`[digirig] agent run start: ${runId}`),
      disableBlockStreaming: false,
    },
  });
}
