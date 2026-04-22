// Pure, stateless text helpers used by the runtime. Kept here (rather than
// inline in runtime.ts) so they can be unit-tested without spinning up the
// channel. None of these touch the filesystem, network, or any mutable state;
// each is a plain function of its inputs.
//
// The companion runtime-y helper `loadKnownCallsigns()` (which reads the
// SCCARC roster CSV) lives in runtime.ts because it does disk I/O.

import { containsPhoneticCallsign } from "../prompt/phonetic.js";

/** Valid FCC-shape callsign. Up to 2 leading letters, 1–4 digits, 1–4 suffix letters. */
export const CALLSIGN_REGEX = /^[A-Z]{1,2}\d{1,4}[A-Z]{1,4}$/;

/** A callsign-like pattern anywhere in running text (for corrector walks). */
export const CALLSIGN_PATTERN = /\b[A-Z]{1,2}\d{1,4}[A-Z]{0,4}\b/gi;

/**
 * Append the station's callsign to a reply if it isn't already there in
 * letters-and-digits form OR spelled phonetically. Used by the FCC 10-min ID
 * window and by the legacy `outbound.sendText` path.
 */
export function appendCallsign(text: string, callsign?: string): string {
  const trimmed = text.trim();
  if (!trimmed || !callsign?.trim()) return trimmed;

  const cleanText = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cleanCallsign = callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleanText.endsWith(cleanCallsign)) return trimmed;

  // Suppress the append if the LLM already said the callsign phonetically
  // ("whiskey six romeo golf charlie"). Shared helper — same spelling the
  // prompt template uses, so the two sides of the contract stay in sync.
  if (containsPhoneticCallsign(trimmed, callsign)) return trimmed;

  return `${trimmed} ${callsign}`;
}

/** Split a comma-separated alias string into a clean list. */
export function parseAliases(input?: string): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * True if the operator's transcribed text appears to address *this* station.
 * Matches the full callsign, any alias, or either side of a `/SUFFIX` split,
 * both in readable form and in bare alphanumeric form (so "W6-RGC" still
 * matches "W6RGC").
 */
export function isDirectCall(text: string, callsign?: string, aliases: string[] = []): boolean {
  const upper = text.toUpperCase();
  const needles = [callsign, ...aliases].filter(Boolean) as string[];
  if (!needles.length) return false;
  const textBare = upper.replace(/[^A-Z0-9]/g, "");

  return needles.some((needle) => {
    const call = needle.toUpperCase();
    if (upper.includes(call)) return true;

    if (call.includes("/")) {
      const parts = call.split("/");
      for (const part of parts) {
        if (part.length >= 3 && upper.includes(part)) return true;
      }
    }

    const callBare = call.replace(/[^A-Z0-9]/g, "");
    return callBare.length > 0 && textBare.includes(callBare);
  });
}

/**
 * Normalize a transcription and drop well-known Whisper hallucinations
 * (empty-audio markers, "thank you for watching", low-diversity repetition,
 * etc.). Also strips a very short leading word when the remainder is
 * substantive — covers the "7" / "uh" onset pattern.
 *
 * Returns `""` when the transcription should be ignored.
 */
export function normalizeSttText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "[blank_audio]" || lower === "(blank audio)") return "";
  if (/\bbeep\b/i.test(trimmed)) return "";
  if (/^\s*[\[(].*[\])]\s*$/.test(trimmed)) return "";
  if (!/[a-z0-9]/i.test(trimmed)) return "";

  // Filter common Whisper static hallucinations.
  const strippedLower = lower.replace(/[^a-z0-9\s]/g, "").trim();
  if (
    ["you", "thank you", "thanks for watching", "thank you for watching"].includes(strippedLower)
  ) {
    return "";
  }

  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length >= 10) {
    const unique = new Set(tokens).size;
    const diversity = unique / tokens.length;
    if (diversity < 0.3) {
      return "";
    }
  }

  const rawTokens = trimmed.split(/\s+/);
  if (rawTokens.length > 1 && rawTokens[0].length <= 3) {
    const remainder = rawTokens.slice(1).join(" ");
    if (remainder.length >= 12) {
      return remainder.trim();
    }
  }
  return trimmed;
}

/** Classic Levenshtein edit distance. Tested against callsign fuzzy-match. */
export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Given a possibly-garbled callsign and a list of known good callsigns,
 * return the best correction within `maxDistance` edits, or `null` if the
 * input is already known (no correction needed) or nothing close enough
 * matches.
 */
export function fuzzyMatchCallsign(
  garbled: string,
  knownCallsigns: string[],
  maxDistance = 2,
): string | null {
  const upper = garbled.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!upper || upper.length < 3) return null;

  if (knownCallsigns.includes(upper)) return null;

  let bestMatch: string | null = null;
  let bestDist = maxDistance + 1;

  for (const known of knownCallsigns) {
    const dist = levenshtein(upper, known);
    if (dist > 0 && dist < bestDist) {
      bestDist = dist;
      bestMatch = known;
    }
  }

  return bestMatch;
}

type CorrectCallsignsLog = { info?: (msg: string) => void };

/**
 * Walk a transcribed text, find callsign-shaped tokens, and replace any that
 * fuzzy-match a known-good callsign. Used on every RX after STT.
 */
export function correctCallsignsInText(
  text: string,
  knownCallsigns: string[],
  log?: CorrectCallsignsLog,
): string {
  if (!knownCallsigns.length) return text;

  return text.replace(CALLSIGN_PATTERN, (match) => {
    const correction = fuzzyMatchCallsign(match, knownCallsigns);
    if (correction && correction !== match.toUpperCase()) {
      log?.info?.(`[digirig] callsign corrected: "${match}" → "${correction}"`);
      return correction;
    }
    return match;
  });
}

/**
 * Cap a reply at `maxWords` and normalize whitespace. Truncation is a soft
 * guardrail against the LLM writing a wall of text — the prompt already asks
 * for brevity.
 */
export function formatRadioReply(text: string, maxWords = 300): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const words = trimmed.split(" ");
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(" ").trim();
}

/**
 * Gate for streaming dispatch: only speak a block if it's at least 8 words
 * OR ends with sentence-terminal punctuation. Prevents mid-thought chunks
 * from being sent to TTS.
 */
export function isSpeakableStreamingReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 8) return true;
  return /[.!?]\s*$/.test(t);
}
