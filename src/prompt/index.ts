// Assembles the ham-radio system prompt from its concern-specific parts and
// provides the per-message [System Data] formatter. The voice↔LLM pipeline in
// runtime.ts imports `buildHamRadioPrompt`, `formatSignalReport`, and the
// phonetic helpers from here.
//
// File map:
//   persona.ts       — who the AI is and how it talks
//   perception.ts    — what it knows about its noisy inputs
//   contracts.ts     — tags the plugin parses out of the response ([SENDER:…])
//   protocols.ts     — operating procedures (nets, ARES, doubling, FCC)
//   safety.ts        — absolute security rules
//   capabilities.ts  — registry of things the AI can *do* (maps to skills/)
//   operators.ts     — per-operator quirks (config-driven)
//   context.ts       — PersonaContext + buildPersonaContext(config)
//   phonetic.ts      — ITU phonetic spelling helpers (shared with runtime.ts)

import type { DigirigConfig } from "../config.js";
import { buildCapabilities, type CapabilityBlock } from "./capabilities.js";
import { buildPersonaContext, type PersonaContext } from "./context.js";
import { renderContracts } from "./contracts.js";
import { renderOperators } from "./operators.js";
import { renderPerception } from "./perception.js";
import { renderPersona } from "./persona.js";
import { renderProtocols } from "./protocols.js";
import { renderSafety } from "./safety.js";

const PREAMBLE =
  "You are an AI assistant communicating over a half-duplex amateur (ham) radio link.\n" +
  "You MUST adopt the persona of a professional, concise, and highly disciplined ham radio operator.";

function renderCapabilityBlock(block: CapabilityBlock): string {
  return `# ${block.title}\n${block.promptText}`;
}

/**
 * Build the full ham-radio system prompt for a given channel configuration.
 * Called once per channel start (see runtime.ts). The result is a plain
 * string; callers pass it into the LLM dispatcher unchanged.
 */
export function buildHamRadioPrompt(config: DigirigConfig): string {
  const ctx = buildPersonaContext(config);
  const capabilities = buildCapabilities(ctx);

  const sections: string[] = [
    PREAMBLE,
    renderPersona(ctx),
    renderPerception(ctx),
    renderContracts(ctx),
    renderProtocols(ctx),
    renderSafety(ctx),
    ...capabilities.map(renderCapabilityBlock),
    renderOperators(ctx),
  ];

  return "\n" + sections.join("\n\n") + "\n";
}

/**
 * Enumerate capability blocks for the given config without assembling the full
 * prompt. Useful for `/digirig doctor` output and introspection.
 */
export function listCapabilities(config: DigirigConfig): CapabilityBlock[] {
  return buildCapabilities(buildPersonaContext(config));
}

export { buildPersonaContext };
export type { CapabilityBlock, PersonaContext };
export { spellCallsignPhonetically, containsPhoneticCallsign } from "./phonetic.js";

/**
 * Rough mapping from post-AGC audio-level dBFS to an S-unit (1–9). This is not
 * a true RF S-meter reading — we're looking at mic-level audio downstream of
 * the receiver's AGC and squelch — but it gives the LLM a consistent anchor
 * for the "S" half of an RS report.
 *
 * Thresholds tuned for typical FM voice on a DigiRig USB sound card.
 */
export function estimateSUnit(rmsDb: number): number {
  if (rmsDb >= -22) return 9;
  if (rmsDb >= -28) return 8;
  if (rmsDb >= -34) return 7;
  if (rmsDb >= -40) return 6;
  if (rmsDb >= -46) return 5;
  if (rmsDb >= -52) return 4;
  if (rmsDb >= -58) return 3;
  if (rmsDb >= -64) return 2;
  return 1;
}

/**
 * Builds the per-message `[System Data]` block that the prompt refers to in
 * section 8 (SIGNAL REPORTS — RST). Returns an empty string if we don't have
 * an RMS reading for this utterance.
 */
export function formatSignalReport(rmsDb?: number, peakDb?: number): string {
  if (typeof rmsDb !== "number" || !Number.isFinite(rmsDb)) return "";
  const sUnit = estimateSUnit(rmsDb);
  const peakPart =
    typeof peakDb === "number" && Number.isFinite(peakDb)
      ? `, Peak ${peakDb.toFixed(1)} dBFS`
      : "";
  return (
    `\n[System Data: audio RMS ${rmsDb.toFixed(1)} dBFS${peakPart}. ` +
    `sUnitEstimate=${sUnit}. For an RS signal report, use ${sUnit} as the S value; ` +
    `choose R (1–5) based on how intelligible the text above was to you.]`
  );
}
