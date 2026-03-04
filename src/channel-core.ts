import { createReplyPrefixOptions } from "openclaw/plugin-sdk";

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
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "digirig",
    accountId: route.accountId,
  });

  return runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver,
      onError: (err: unknown, info: { kind: string }) =>
        log?.error?.(`[digirig] ${info.kind} reply failed: ${String(err)}`),
    },
    replyOptions: {
      onModelSelected,
      onAgentRunStart: (runId: string) => log?.info?.(`[digirig] agent run start: ${runId}`),
      disableBlockStreaming: true,
    },
  });
}
