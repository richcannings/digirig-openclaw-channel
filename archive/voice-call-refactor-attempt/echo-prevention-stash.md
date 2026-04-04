# Echo prevention code stash (removed)

Removed from `src/runtime.ts` (digirig-openclaw-channel) on 2026-02-15.

## TX/RX state and echo helpers
```ts
  let lastTxText = "";
  let lastTxAt = 0;

  const normalizeEchoText = (input: string): string =>
    input
      .toLowerCase()
      // keep only alphanumerics and spaces
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\b(w6rgc|w6r|rgc|ai|over|clear)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // Levenshtein distance: number of single-character edits to transform A -> B.
  const levenshtein = (a: string, b: string): number => {
    const alen = a.length;
    const blen = b.length;
    if (!alen) return blen;
    if (!blen) return alen;
    const dp = Array.from({ length: alen + 1 }, () => new Array(blen + 1).fill(0));
    for (let i = 0; i <= alen; i += 1) dp[i][0] = i;
    for (let j = 0; j <= blen; j += 1) dp[0][j] = j;
    for (let i = 1; i <= alen; i += 1) {
      for (let j = 1; j <= blen; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost,
        );
      }
    }
    return dp[alen][blen];
  };
```

## TX echo suppression in `speak()`
```ts
      audioMonitor.muteFor(2000);
      // Record last TX for echo suppression before playback.
      lastTxText = text.trim();
      lastTxAt = Date.now();
      ...
      // Mute RX briefly to avoid TX bleed/echo triggering RX.
      audioMonitor.muteFor(2000);
```

## RX dedupe / echo suppression in `utterance` handler
```ts
        // Drop duplicate RX lines within a short window (echo/dedupe).
        if (
          lastRxText &&
          normalizeEchoText(normalizedRx) === normalizeEchoText(lastRxText) &&
          Date.now() - lastRxAt < 5000
        ) {
          ctx.log?.info?.("[digirig] RX dropped (duplicate)");
          return;
        }

        // Drop RX that matches our last TX within 15s (echo suppression).
        if (lastTxText && Date.now() - lastTxAt < 15000) {
          const a = normalizeEchoText(normalizedRx);
          const b = normalizeEchoText(lastTxText);
          if (a && b) {
            // Similarity via Levenshtein distance (tolerates minor ASR errors).
            const dist = levenshtein(a, b);
            const maxLen = Math.max(a.length, b.length) || 1;
            const similarity = 1 - dist / maxLen;
            if (similarity >= 0.85) {
              ctx.log?.info?.(`[digirig] RX dropped (echo similarity=${similarity.toFixed(2)})`);
              return;
            }
          }
        }
```

## TX deliver mute-for
```ts
audioMonitor.muteFor(800);
```
