import { describe, it, expect } from "vitest";
import { DigirigConfigSchema, type DigirigConfig } from "../config.js";
import {
  buildHamRadioPrompt,
  buildPersonaContext,
  containsPhoneticCallsign,
  estimateSUnit,
  formatSignalReport,
  listCapabilities,
  spellCallsignPhonetically,
} from "./index.js";

function makeConfig(overrides: Record<string, any> = {}): DigirigConfig {
  return DigirigConfigSchema.parse({
    tx: { callsign: "W6RGC/AI", aliases: "Seven,7,Overlord", ...overrides.tx },
    persona: {
      name: "Seven",
      location: "Westside Santa Cruz",
      knownOperators: [{ callsign: "WB6DWP", note: "be cheeky and joke around" }],
      ...overrides.persona,
    },
    ...overrides,
  });
}

describe("buildHamRadioPrompt — assembly", () => {
  it("includes every concern section", () => {
    const prompt = buildHamRadioPrompt(makeConfig());
    // One canary per source file so a missing import fails loudly.
    expect(prompt).toContain("THE ART OF THE CONVERSATION"); // persona.ts
    expect(prompt).toContain("TRANSLATING SPEECH-TO-TEXT"); // perception.ts
    expect(prompt).toContain("SENDER IDENTIFICATION"); // contracts.ts
    expect(prompt).toContain("FCC COMPLIANCE"); // protocols.ts
    expect(prompt).toContain("SECURITY BOUNDARIES"); // safety.ts
    expect(prompt).toContain("SPECIAL CALLSIGN BEHAVIORS"); // operators.ts
  });

  it("includes every registered capability", () => {
    const cfg = makeConfig();
    const caps = listCapabilities(cfg);
    expect(caps.length).toBeGreaterThan(0);
    const prompt = buildHamRadioPrompt(cfg);
    for (const cap of caps) {
      expect(prompt).toContain(cap.title);
      expect(cap.skillDir).toMatch(/^skills\//);
    }
  });
});

describe("buildHamRadioPrompt — identity interpolation", () => {
  it("uses the configured callsign everywhere it was previously hardcoded", () => {
    const prompt = buildHamRadioPrompt(
      makeConfig({ tx: { callsign: "KJ7ABC/AI" }, persona: { name: "Nova" } }),
    );
    expect(prompt).toContain("KJ7ABC/AI");
    expect(prompt).toContain("KJ7ABC"); // FCC control op
    expect(prompt).toContain("Nova");
    // Make sure the old instance-specific strings are gone.
    expect(prompt).not.toContain("W6RGC");
    expect(prompt).not.toContain("Seven");
  });

  it("uses the derived control operator (callsign minus /AI) by default", () => {
    const prompt = buildHamRadioPrompt(
      makeConfig({ tx: { callsign: "W6RGC/AI" }, persona: { name: "Seven" } }),
    );
    // FCC §13 line must name the control operator, not the /AI form.
    expect(prompt).toMatch(/licensed control operator W6RGC\b/);
  });

  it("honours an explicit controlOperatorCallsign override", () => {
    const prompt = buildHamRadioPrompt(
      makeConfig({
        tx: { callsign: "W6RGC/AI" },
        persona: { controlOperatorCallsign: "KE6AFE", name: "Seven" },
      }),
    );
    expect(prompt).toMatch(/licensed control operator KE6AFE\b/);
  });

  it("uses the phonetic callsign in the net check-in example", () => {
    const prompt = buildHamRadioPrompt(makeConfig());
    expect(prompt).toContain("Whiskey six Romeo Golf Charlie stroke Alpha India");
  });

  it("renders known operators from config", () => {
    const prompt = buildHamRadioPrompt(
      makeConfig({
        persona: {
          name: "Seven",
          knownOperators: [
            { callsign: "wb6dwp", note: "be cheeky" },
            { callsign: "N0CALL", note: "formal only" },
          ],
        },
      }),
    );
    expect(prompt).toContain("WB6DWP: be cheeky"); // callsign upper-cased
    expect(prompt).toContain("N0CALL: formal only");
  });

  it("omits the known-operators block entirely when none are configured", () => {
    const prompt = buildHamRadioPrompt(makeConfig({ persona: { knownOperators: [] } }));
    expect(prompt).toContain("SPECIAL CALLSIGN BEHAVIORS");
    expect(prompt).not.toContain("WB6DWP");
  });

  it("omits the location from the net check-in when not configured", () => {
    const prompt = buildHamRadioPrompt(
      makeConfig({ persona: { name: "Seven", location: "" } }),
    );
    expect(prompt).not.toContain(" in ,");
    expect(prompt).not.toMatch(/in \./);
  });
});

describe("buildPersonaContext", () => {
  it("puts the primary name at the front of aliases", () => {
    const ctx = buildPersonaContext(makeConfig());
    expect(ctx.aliases[0]).toBe("Seven");
  });

  it("does not duplicate the name if it's already in tx.aliases", () => {
    const ctx = buildPersonaContext(
      makeConfig({ tx: { callsign: "W6RGC/AI", aliases: "Seven,Overlord" } }),
    );
    expect(ctx.aliases.filter((a) => a.toLowerCase() === "seven")).toHaveLength(1);
  });
});

describe("spellCallsignPhonetically", () => {
  it("handles letters and digits", () => {
    expect(spellCallsignPhonetically("W6RGC")).toBe("Whiskey six Romeo Golf Charlie");
  });

  it('handles the "/" separator with "stroke"', () => {
    expect(spellCallsignPhonetically("W6RGC/AI")).toBe(
      "Whiskey six Romeo Golf Charlie stroke Alpha India",
    );
  });
});

describe("containsPhoneticCallsign", () => {
  it("matches the word-form spelling", () => {
    expect(
      containsPhoneticCallsign("73 de Whiskey six Romeo Golf Charlie", "W6RGC"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      containsPhoneticCallsign("signing off, WHISKEY SIX ROMEO GOLF CHARLIE", "W6RGC"),
    ).toBe(true);
  });

  it("returns false when only part of the callsign appears", () => {
    expect(containsPhoneticCallsign("Whiskey six Romeo", "W6RGC")).toBe(false);
  });
});

describe("estimateSUnit", () => {
  it("maps strong audio to S9", () => {
    expect(estimateSUnit(-10)).toBe(9);
    expect(estimateSUnit(-22)).toBe(9);
  });

  it("maps mid-level audio to mid S-units", () => {
    expect(estimateSUnit(-30)).toBe(7);
    expect(estimateSUnit(-40)).toBe(6);
    expect(estimateSUnit(-46)).toBe(5);
  });

  it("maps weak audio down to S1", () => {
    expect(estimateSUnit(-60)).toBe(2);
    expect(estimateSUnit(-80)).toBe(1);
  });

  it("is monotonic — more negative dBFS never gives a higher S-unit", () => {
    let prev = estimateSUnit(0);
    for (let db = 0; db >= -80; db -= 1) {
      const s = estimateSUnit(db);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("formatSignalReport", () => {
  it("returns empty string when RMS is missing", () => {
    expect(formatSignalReport(undefined, undefined)).toBe("");
    expect(formatSignalReport(undefined, -12)).toBe("");
  });

  it("returns empty string when RMS is NaN or infinite", () => {
    expect(formatSignalReport(NaN, -12)).toBe("");
    expect(formatSignalReport(Infinity)).toBe("");
  });

  it("formats RMS-only reports with an S-unit estimate", () => {
    const out = formatSignalReport(-20.37);
    expect(out).toContain("RMS -20.4 dBFS");
    expect(out).toContain("sUnitEstimate=9");
    expect(out).not.toContain("Peak");
  });

  it("formats RMS + Peak reports", () => {
    const out = formatSignalReport(-30.5, -14.2);
    expect(out).toContain("RMS -30.5 dBFS");
    expect(out).toContain("Peak -14.2 dBFS");
    expect(out).toContain("sUnitEstimate=7");
  });

  it("tells the LLM how to assemble the RS report", () => {
    const out = formatSignalReport(-20);
    expect(out).toContain("For an RS signal report");
    expect(out).toContain("R (1–5)");
  });
});
