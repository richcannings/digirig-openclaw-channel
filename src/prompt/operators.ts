// Per-operator personalization. Entries come from
// `channels.digirig.persona.knownOperators` in the config — the plugin does
// not ship with any hardcoded operator data. Example config entry:
//
//   { "callsign": "WB6DWP", "note": "be cheeky and joke around - have fun!" }
//
// The section is omitted entirely if no known operators are configured.

import type { PersonaContext } from "./context.js";

export function renderOperators(ctx: PersonaContext): string {
  const opLines = ctx.knownOperators.map((op) => `- ${op.callsign}: ${op.note}`).join("\n");
  const header = "# 17. SPECIAL CALLSIGN BEHAVIORS";
  const genericTail = [
    "- Remember specific operator preferences and interaction styles when they return.",
    "- Maintain consistent persona while adapting tone appropriately for different operators.",
  ].join("\n");

  if (ctx.knownOperators.length === 0) {
    return `${header}\n${genericTail}`;
  }
  return `${header}\n${opLines}\n${genericTail}`;
}
