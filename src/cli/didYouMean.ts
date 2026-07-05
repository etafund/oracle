// Shared Levenshtein-distance intent-inference helpers for the CORE CLI
// surface (agent-ergonomics Axiom 7: recover from legible-but-wrong
// invocations — a mistyped flag, `--lane` value, or core command name —
// instead of silently failing or, worse, silently auto-running the wrong
// thing). Callers are expected to build the candidate list from the
// tool's own live registry at call time (`program.options`,
// `program.commands`, the reviewed-lane list) rather than hardcoding it,
// so a suggestion can never drift from what the CLI actually accepts.
//
// This is deliberately plain (non-Damerau) Levenshtein distance — no
// adjacent-transposition credit — so "Levenshtein-1" means exactly one
// insertion, deletion, or substitution. That keeps the strict callers
// (flag/command typo correction) conservative: a suggestion is only ever
// offered when it's unambiguously one edit away.

/** Standard Levenshtein edit distance (insert/delete/substitute), case-insensitive. */
export function levenshteinDistance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const rows = left.length + 1;
  const cols = right.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) distances[i][0] = i;
  for (let j = 0; j < cols; j += 1) distances[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] + cost,
      );
    }
  }
  return distances[rows - 1][cols - 1];
}

/**
 * Nearest candidate at *exactly* the given edit distance or closer
 * (default: strict Levenshtein-1, the "did you mean" bar for flags and
 * command names — a looser fuzzy match risks pointing an agent at the
 * wrong flag/command entirely). Ties keep the first candidate in
 * iteration order, so pass candidates in the tool's own stable
 * registration order for deterministic output.
 *
 * Returns `null` for an exact match (distance 0 — not a typo) or when no
 * candidate is within `maxDistance`.
 */
export function nearestByEditDistance(
  input: string,
  candidates: readonly string[],
  maxDistance = 1,
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== null && bestDistance > 0 && bestDistance <= maxDistance ? best : null;
}
