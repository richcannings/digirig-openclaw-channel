// PersonaContext — the per-instance identity values that the prompt sections
// interpolate. Built once per channel start from `DigirigConfig` and passed
// into the render functions in sibling files.
//
// Rule of thumb: if a string in `persona.ts`, `perception.ts`, `protocols.ts`,
// `capabilities.ts`, or `operators.ts` names a specific station, operator, or
// location, it should come from here — not from a hardcoded literal.

import type { DigirigConfig } from "../config.js";
import { spellCallsignPhonetically } from "./phonetic.js";

export type KnownOperator = { callsign: string; note: string };

export type PersonaContext = {
  /** Full callsign as transmitted, e.g. "W6RGC/AI". */
  callsign: string;
  /** Callsign with any trailing "/AI" etc. stripped, e.g. "W6RGC". */
  controlOperator: string;
  /** Callsign spelled phonetically, e.g. "Whiskey six Romeo Golf Charlie stroke Alpha India". */
  phoneticCallsign: string;
  /** Name the AI is addressed by on the air, e.g. "Seven". */
  name: string;
  /** Alternate trigger names, e.g. ["Seven", "7", "Overlord"]. Includes `name` first. */
  aliases: string[];
  /** Optional location spoken in net check-ins, e.g. "Westside Santa Cruz". */
  location: string;
  /** Known operators with persona adjustments. */
  knownOperators: KnownOperator[];
};

function stripAiSuffix(callsign: string): string {
  return callsign.replace(/\/AI\b/i, "").trim();
}

function parseAliasString(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function buildPersonaContext(config: DigirigConfig): PersonaContext {
  const callsign = config.tx.callsign;
  const configuredControlOp = config.persona.controlOperatorCallsign.trim();
  const controlOperator = configuredControlOp || stripAiSuffix(callsign);
  const name = config.persona.name;
  const aliasList = parseAliasString(config.tx.aliases);

  // Ensure `name` shows up in the alias list at least once, without duplicating.
  const aliases = aliasList.some((a) => a.toLowerCase() === name.toLowerCase())
    ? aliasList
    : [name, ...aliasList];

  return {
    callsign,
    controlOperator,
    phoneticCallsign: spellCallsignPhonetically(callsign),
    name,
    aliases,
    location: config.persona.location,
    knownOperators: config.persona.knownOperators.map((k) => ({
      callsign: k.callsign.toUpperCase(),
      note: k.note,
    })),
  };
}
