import { describe, expect, it } from "vitest";
import {
  CALLSIGN_PATTERN,
  CALLSIGN_REGEX,
  appendCallsign,
  correctCallsignsInText,
  formatRadioReply,
  fuzzyMatchCallsign,
  isDirectCall,
  isSpeakableStreamingReply,
  levenshtein,
  normalizeSttText,
  parseAliases,
} from "./text-utils.js";

describe("appendCallsign", () => {
  it("returns empty for empty text", () => {
    expect(appendCallsign("", "W6RGC/AI")).toBe("");
    expect(appendCallsign("   ", "W6RGC/AI")).toBe("");
  });

  it("returns text unchanged when no callsign is configured", () => {
    expect(appendCallsign("hello world", undefined)).toBe("hello world");
    expect(appendCallsign("hello world", "")).toBe("hello world");
    expect(appendCallsign("hello world", "   ")).toBe("hello world");
  });

  it("appends the callsign when absent", () => {
    expect(appendCallsign("Roger, back to you.", "W6RGC/AI")).toBe(
      "Roger, back to you. W6RGC/AI",
    );
  });

  it("does not double-append when callsign is already at the end", () => {
    expect(appendCallsign("Roger, back to you. W6RGC/AI", "W6RGC/AI")).toBe(
      "Roger, back to you. W6RGC/AI",
    );
  });

  it("ignores punctuation differences when checking end-of-text", () => {
    // Note trailing period and internal slash: bare-alphanumeric compare still matches.
    expect(appendCallsign("Clear. W6RGC/AI.", "W6RGC/AI")).toBe("Clear. W6RGC/AI.");
  });

  it("suppresses append when callsign appears phonetically anywhere in the text", () => {
    expect(
      appendCallsign("Sign-off, whiskey six romeo golf charlie stroke alpha india.", "W6RGC/AI"),
    ).toBe("Sign-off, whiskey six romeo golf charlie stroke alpha india.");
  });

  it("trims the text before returning", () => {
    expect(appendCallsign("   hello    ", "W6RGC/AI")).toBe("hello W6RGC/AI");
  });

  it("works for any callsign, not just W6RGC", () => {
    expect(appendCallsign("Signing off.", "KJ7ABC/AI")).toBe("Signing off. KJ7ABC/AI");
    expect(
      appendCallsign("seventy-three, kilo juliet seven alpha bravo charlie stroke alpha india.", "KJ7ABC/AI"),
    ).toBe("seventy-three, kilo juliet seven alpha bravo charlie stroke alpha india.");
  });
});

describe("parseAliases", () => {
  it("returns [] for empty / undefined input", () => {
    expect(parseAliases(undefined)).toEqual([]);
    expect(parseAliases("")).toEqual([]);
    expect(parseAliases("   ")).toEqual([]);
  });

  it("splits on commas and trims whitespace", () => {
    expect(parseAliases("Seven, 7 , Overlord")).toEqual(["Seven", "7", "Overlord"]);
  });

  it("drops empty entries from stray commas", () => {
    expect(parseAliases("Seven,,7,")).toEqual(["Seven", "7"]);
    expect(parseAliases(",,,")).toEqual([]);
  });

  it("preserves case (aliases are matched case-insensitively downstream)", () => {
    expect(parseAliases("SEVEN,overlord")).toEqual(["SEVEN", "overlord"]);
  });
});

describe("isDirectCall", () => {
  it("returns false with no callsign and no aliases", () => {
    expect(isDirectCall("hello world")).toBe(false);
    expect(isDirectCall("hello world", undefined, [])).toBe(false);
  });

  it("matches the literal callsign anywhere in the text", () => {
    expect(isDirectCall("this is W6RGC/AI, how copy?", "W6RGC/AI")).toBe(true);
    expect(isDirectCall("W6RGC/AI go ahead", "W6RGC/AI")).toBe(true);
  });

  it("matches either side of a /-separated callsign (min 3 chars)", () => {
    // "/AI" alone is only 2 chars → doesn't match.
    expect(isDirectCall("Looking for AI help.", "W6RGC/AI", [])).toBe(false);
    // "W6RGC" is 5 chars → matches.
    expect(isDirectCall("Hey W6RGC how's it going", "W6RGC/AI", [])).toBe(true);
  });

  it("matches aliases", () => {
    expect(isDirectCall("7 this is Rich, radio check", "W6RGC/AI", ["Seven", "7", "Overlord"])).toBe(
      true,
    );
    expect(isDirectCall("overlord, are you there?", "W6RGC/AI", ["Seven", "7", "Overlord"])).toBe(
      true,
    );
  });

  it("matches a bare-alphanumeric form of the callsign (tolerant of STT insertions)", () => {
    // Whisper sometimes splits "W6RGC" → "W 6 R G C". Bare compare collapses that.
    expect(isDirectCall("this is W 6 R G C AI, over", "W6RGC/AI")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(isDirectCall("how is the weather today", "W6RGC/AI", ["Seven", "7"])).toBe(false);
    expect(isDirectCall("how is KD6ABC doing", "W6RGC/AI", ["Seven", "7"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isDirectCall("SEVEN THIS IS KD6ABC", "W6RGC/AI", ["seven"])).toBe(true);
  });
});

describe("normalizeSttText", () => {
  it("returns empty for empty / whitespace input", () => {
    expect(normalizeSttText("")).toBe("");
    expect(normalizeSttText("    ")).toBe("");
  });

  it("drops Whisper blank-audio markers", () => {
    expect(normalizeSttText("[blank_audio]")).toBe("");
    expect(normalizeSttText("(blank audio)")).toBe("");
    expect(normalizeSttText("  [BLANK_AUDIO]  ")).toBe("");
  });

  it("drops pure-beep / bracketed-only transcripts", () => {
    expect(normalizeSttText("beep")).toBe("");
    expect(normalizeSttText("[music]")).toBe("");
    expect(normalizeSttText("(silence)")).toBe("");
  });

  it("drops no-letters-or-digits input", () => {
    expect(normalizeSttText("...!")).toBe("");
    expect(normalizeSttText("---")).toBe("");
  });

  it("drops the common Whisper hallucinations", () => {
    expect(normalizeSttText("you")).toBe("");
    expect(normalizeSttText("You.")).toBe("");
    expect(normalizeSttText("Thank you")).toBe("");
    expect(normalizeSttText("Thanks for watching!")).toBe("");
    expect(normalizeSttText("Thank you for watching.")).toBe("");
  });

  it("drops low-diversity repetition loops", () => {
    // 12 tokens, only 1 unique → diversity 0.083 < 0.3 threshold.
    expect(normalizeSttText("no no no no no no no no no no no no")).toBe("");
  });

  it("keeps normal utterances", () => {
    expect(normalizeSttText("seven, this is W6RGC, radio check.")).toBe(
      "seven, this is W6RGC, radio check.",
    );
  });

  it("strips a very short leading word when the remainder is substantive", () => {
    // "7" alone would be noise; the real content starts after it.
    expect(normalizeSttText("7 this is W6RGC radio check")).toBe("this is W6RGC radio check");
  });

  it("leaves the leading word alone when the remainder is short", () => {
    // "the dog" stripping gives "dog" (< 12 chars) → unchanged.
    expect(normalizeSttText("the dog")).toBe("the dog");
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("W6RGC", "W6RGC")).toBe(0);
  });

  it("counts a single insertion", () => {
    expect(levenshtein("W6RGC", "W6RGCC")).toBe(1);
  });

  it("counts a single deletion", () => {
    expect(levenshtein("W6RGC", "W6RG")).toBe(1);
  });

  it("counts a single substitution", () => {
    expect(levenshtein("WB6DWP", "WB60WP")).toBe(1);
    expect(levenshtein("KE6AFE", "KU6AFE")).toBe(1);
  });

  it("handles empty inputs", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("handles fully-disjoint strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });
});

describe("fuzzyMatchCallsign", () => {
  const roster = ["W6RGC", "WB6DWP", "KE6AFE", "KJ6DZB"];

  it("returns null when the input is already a known callsign", () => {
    expect(fuzzyMatchCallsign("W6RGC", roster)).toBeNull();
    expect(fuzzyMatchCallsign("wb6dwp", roster)).toBeNull(); // case-insensitive via upper
  });

  it("corrects a 1-distance garble", () => {
    expect(fuzzyMatchCallsign("WB60WP", roster)).toBe("WB6DWP");
    expect(fuzzyMatchCallsign("KU6AFE", roster)).toBe("KE6AFE");
  });

  it("corrects a 2-distance garble", () => {
    expect(fuzzyMatchCallsign("WB60WX", roster, 2)).toBe("WB6DWP");
  });

  it("returns null when nothing is within maxDistance", () => {
    expect(fuzzyMatchCallsign("ZZ9ZZZ", roster)).toBeNull();
  });

  it("returns null for too-short input (< 3 chars)", () => {
    expect(fuzzyMatchCallsign("W6", roster)).toBeNull();
    expect(fuzzyMatchCallsign("", roster)).toBeNull();
  });

  it("strips punctuation before matching", () => {
    expect(fuzzyMatchCallsign("wb-6-dwp!", roster)).toBeNull(); // bare form == "WB6DWP" which is known
    expect(fuzzyMatchCallsign("wb-6-0-wp", roster)).toBe("WB6DWP"); // bare "WB60WP" 1 edit away
  });

  it("returns null for empty roster", () => {
    expect(fuzzyMatchCallsign("WB60WP", [])).toBeNull();
  });
});

describe("correctCallsignsInText", () => {
  const roster = ["W6RGC", "WB6DWP", "KE6AFE"];

  it("returns text unchanged when roster is empty", () => {
    expect(correctCallsignsInText("WB60WP good morning", [])).toBe("WB60WP good morning");
  });

  it("leaves text unchanged when no callsign-shaped tokens are present", () => {
    expect(correctCallsignsInText("hello world", roster)).toBe("hello world");
  });

  it("corrects a garbled callsign inline", () => {
    expect(correctCallsignsInText("WB60WP, good morning", roster)).toBe("WB6DWP, good morning");
  });

  it("leaves a valid known callsign unchanged", () => {
    expect(correctCallsignsInText("W6RGC, thanks for the check", roster)).toBe(
      "W6RGC, thanks for the check",
    );
  });

  it("corrects multiple callsigns independently in one string", () => {
    expect(correctCallsignsInText("WB60WP to KU6AFE, roger", roster)).toBe(
      "WB6DWP to KE6AFE, roger",
    );
  });

  it("calls the log.info callback when a correction is made", () => {
    const logs: string[] = [];
    correctCallsignsInText("WB60WP hello", roster, { info: (m) => logs.push(m) });
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("WB60WP");
    expect(logs[0]).toContain("WB6DWP");
  });

  it("does not call log.info when no correction happens", () => {
    const logs: string[] = [];
    correctCallsignsInText("W6RGC hello", roster, { info: (m) => logs.push(m) });
    expect(logs).toEqual([]);
  });
});

describe("formatRadioReply", () => {
  it("returns empty for empty input", () => {
    expect(formatRadioReply("")).toBe("");
    expect(formatRadioReply("   ")).toBe("");
  });

  it("normalizes internal whitespace", () => {
    expect(formatRadioReply("hello\n\nworld   again")).toBe("hello world again");
  });

  it("passes short replies through unchanged", () => {
    expect(formatRadioReply("Roger, five by nine.")).toBe("Roger, five by nine.");
  });

  it("truncates at maxWords", () => {
    const many = Array.from({ length: 350 }, (_, i) => `w${i}`).join(" ");
    const out = formatRadioReply(many, 300);
    const count = out.split(" ").length;
    expect(count).toBe(300);
    expect(out.endsWith(" ")).toBe(false);
  });

  it("honours a custom maxWords", () => {
    expect(formatRadioReply("a b c d e f g h", 3)).toBe("a b c");
  });
});

describe("isSpeakableStreamingReply", () => {
  it("rejects empty / whitespace", () => {
    expect(isSpeakableStreamingReply("")).toBe(false);
    expect(isSpeakableStreamingReply("   ")).toBe(false);
  });

  it("rejects short replies with no terminal punctuation", () => {
    expect(isSpeakableStreamingReply("Roger")).toBe(false);
    expect(isSpeakableStreamingReply("Roger back")).toBe(false);
  });

  it("accepts short replies with terminal punctuation", () => {
    expect(isSpeakableStreamingReply("Roger.")).toBe(true);
    expect(isSpeakableStreamingReply("Copy that!")).toBe(true);
    expect(isSpeakableStreamingReply("Say again?")).toBe(true);
  });

  it("accepts 8-or-more-word replies even without terminal punctuation", () => {
    expect(isSpeakableStreamingReply("one two three four five six seven eight")).toBe(true);
  });

  it("rejects 7-word replies without terminal punctuation", () => {
    expect(isSpeakableStreamingReply("one two three four five six seven")).toBe(false);
  });

  it("tolerates trailing whitespace after punctuation", () => {
    expect(isSpeakableStreamingReply("Roger.  ")).toBe(true);
  });
});

describe("CALLSIGN_REGEX + CALLSIGN_PATTERN", () => {
  it("CALLSIGN_REGEX matches a full-string FCC-shape callsign", () => {
    expect(CALLSIGN_REGEX.test("W6RGC")).toBe(true);
    expect(CALLSIGN_REGEX.test("WB6DWP")).toBe(true);
    expect(CALLSIGN_REGEX.test("KJ7ABCD")).toBe(true); // 4-letter suffix
    expect(CALLSIGN_REGEX.test("K6BJ")).toBe(true);    // 2-letter suffix
  });

  it("CALLSIGN_REGEX rejects things that don't look like full callsigns", () => {
    expect(CALLSIGN_REGEX.test("")).toBe(false);
    expect(CALLSIGN_REGEX.test("W6")).toBe(false);      // no suffix letters
    expect(CALLSIGN_REGEX.test("RGC")).toBe(false);     // no digits
    expect(CALLSIGN_REGEX.test("w6rgc")).toBe(false);   // case-sensitive
    expect(CALLSIGN_REGEX.test("W6RGC/AI")).toBe(false); // trailing /AI not allowed
  });

  it("CALLSIGN_PATTERN finds callsign-shaped tokens in running text", () => {
    const matches = "this is W6RGC, station KE6AFE here, over".match(CALLSIGN_PATTERN);
    expect(matches).toEqual(["W6RGC", "KE6AFE"]);
  });

  it("CALLSIGN_PATTERN is forgiving enough to catch garbled callsigns", () => {
    // "WB60WP" has a 0 (zero) instead of D — still matches the broad pattern
    // so the fuzzy matcher gets a shot at correcting it.
    const matches = "hello WB60WP".match(CALLSIGN_PATTERN);
    expect(matches).toEqual(["WB60WP"]);
  });
});
