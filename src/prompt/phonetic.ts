// ITU phonetic alphabet used by both:
//   - `src/prompt/*.ts` templates — to render the callsign phonetically in the
//     system prompt (e.g. net check-in example).
//   - `src/runtime.ts:appendCallsign` — to detect when the LLM has already said
//     its callsign phonetically and skip the auto-append.
//
// Keeping the table in one place means both use sites agree on which variant
// to produce/accept (e.g. "six" rather than "six/six-er"), so the check stays
// consistent with what the LLM was told to say.

export const LETTER_PHONETIC: Record<string, string> = {
  A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot",
  G: "Golf", H: "Hotel", I: "India", J: "Juliet", K: "Kilo", L: "Lima",
  M: "Mike", N: "November", O: "Oscar", P: "Papa", Q: "Quebec", R: "Romeo",
  S: "Sierra", T: "Tango", U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray",
  Y: "Yankee", Z: "Zulu",
};

// Word forms for each digit. Used when building the lowercase phonetic haystack
// we search on in `appendCallsign`. The prompt template also renders these in
// word form ("Whiskey six Romeo…") so the LLM says the same thing we look for.
const DIGIT_WORD: Record<string, string> = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
  "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
};

// The separator spoken for "/" in a callsign like "W6RGC/AI". ITU standard.
const SLASH_SPOKEN = "stroke";

function phoneticizeChar(ch: string, opts: { digitAsWord: boolean }): string | null {
  const upper = ch.toUpperCase();
  if (upper in LETTER_PHONETIC) return LETTER_PHONETIC[upper];
  if (/[0-9]/.test(upper)) return opts.digitAsWord ? DIGIT_WORD[upper] : upper;
  return null;
}

/**
 * Render a callsign as a space-separated phonetic string suitable for dropping
 * into a prompt or a TTS script. `"W6RGC/AI"` → `"Whiskey six Romeo Golf
 * Charlie stroke Alpha India"`. Unknown characters are skipped.
 */
export function spellCallsignPhonetically(callsign: string): string {
  return callsign
    .split("/")
    .map((part) =>
      part
        .split("")
        .map((ch) => phoneticizeChar(ch, { digitAsWord: true }))
        .filter((s): s is string => s !== null)
        .join(" "),
    )
    .filter((s) => s.length > 0)
    .join(` ${SLASH_SPOKEN} `);
}

/**
 * Did the given text already contain the callsign spelled out phonetically?
 * Used to suppress `appendCallsign` when the LLM has already ID'd in words.
 * Compares on the lowercase, word-form spelling produced by
 * `spellCallsignPhonetically`.
 */
export function containsPhoneticCallsign(text: string, callsign: string): boolean {
  const spelled = spellCallsignPhonetically(callsign).toLowerCase();
  if (!spelled) return false;
  return text.toLowerCase().includes(spelled);
}
