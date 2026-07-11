import { z } from "zod";
import { THINKING_TIME_INPUT_VALUES, normalizeThinkingTimeLevel } from "../oracle/thinkingTime.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";

export const CONSULT_PRESETS = ["chatgpt-pro-heavy"] as const;
export const CONSULT_LANES = ["chatgpt-pro", "gemini-deep-think", "fable-local"] as const;
export const CONSULT_ENGINES = ["api", "browser", "claude-code"] as const;

export const browserThinkingTimeRawSchema = z.enum(THINKING_TIME_INPUT_VALUES);

export const browserThinkingTimeInputSchema = browserThinkingTimeRawSchema.transform(
  (value): ThinkingTimeLevel => {
    const normalized = normalizeThinkingTimeLevel(value);
    if (!normalized) {
      throw new Error(`Unknown browserThinkingTime value: ${value}`);
    }
    return normalized;
  },
);

// --- Strict tool-input schemas (single source of truth) ---
//
// Every MCP tool advertises AND enforces the exact same Zod object: the shape it
// registers as `inputSchema` is the shape it parses in the handler, so the schema an
// agent reads can never drift from what the tool accepts. Crucially the object is
// `strict`, so the MCP SDK (which otherwise silently strips unknown keys before the
// handler runs) rejects typos. That closes the paid-run trap where a mistyped safety
// flag such as `dry_run`/`dryrun` is dropped and a real, billed ChatGPT Pro run starts
// in place of the intended `dryRun` preview.

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distance = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    distance[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    distance[0][j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      distance[i][j] = Math.min(
        distance[i - 1][j] + 1,
        distance[i][j - 1] + 1,
        distance[i - 1][j - 1] + substitutionCost,
      );
    }
  }
  return distance[rows - 1][cols - 1];
}

function nearestKnownKey(unknownKey: string, validKeys: readonly string[]): string | undefined {
  const target = unknownKey.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const key of validKeys) {
    const distance = levenshtein(target, key.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  // Only suggest a correction when it is plausibly a typo of the unknown key, so an
  // unrelated stray key does not get a misleading "did you mean" pointer.
  const threshold = Math.max(2, Math.ceil(unknownKey.length / 2));
  return best !== undefined && bestDistance <= threshold ? best : undefined;
}

function describeUnknownKeys(unknownKeys: readonly string[], validKeys: readonly string[]): string {
  return unknownKeys
    .map((key) => {
      const suggestion = nearestKnownKey(key, validKeys);
      return suggestion
        ? `Unknown input key "${key}". Did you mean "${suggestion}"?`
        : `Unknown input key "${key}".`;
    })
    .join(" ");
}

/**
 * Build a strict Zod object from a raw shape. The returned schema rejects unknown keys
 * with a message that names the offending key and its closest valid neighbour, and it
 * doubles as the advertised MCP `inputSchema` so the contract and the enforcement can
 * never diverge.
 */
export function strictToolSchema<Shape extends z.ZodRawShape>(shape: Shape) {
  const validKeys = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys" ? describeUnknownKeys(issue.keys, validKeys) : undefined,
  });
}
