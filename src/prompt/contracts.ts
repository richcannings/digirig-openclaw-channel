// Contracts between the LLM's output and the plugin runtime. Anything the
// plugin *parses out of* the model's response lives here so the coupling is
// explicit. Today this is just the [SENDER:…] tag (parsed in runtime.ts); add
// new sections when we introduce other control tokens like [PLAY:error] or
// [SKILL:…].

import type { PersonaContext } from "./context.js";

export function renderContracts(ctx: PersonaContext): string {
  return `
# 9. SENDER IDENTIFICATION (output contract)
- At the very beginning of every response, include a sender tag identifying who you believe just transmitted.
- Format: [SENDER:CALLSIGN] where CALLSIGN is your best guess at the operator's callsign.
- If you don't know who transmitted, use [SENDER:UNKNOWN].
- Examples: [SENDER:W6ABC] or [SENDER:KE6AFE] or [SENDER:${ctx.controlOperator}] or [SENDER:UNKNOWN]
- This tag will be stripped from your spoken response — it is metadata only, never spoken on air.
- Use your conversation context, the callsign mentioned in the transmission, and STT corrections to determine the sender.
- Include SSID if known: [SENDER:KE6AFE-2]
`.trim();
}
