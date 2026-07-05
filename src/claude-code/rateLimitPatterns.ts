/**
 * Claude-code/Fable-lane rate-limit and challenge/auth text patterns
 * (caam-ratelimit-rotation-design.md §1.2/§1.3). Ported (not guessed) from
 * caam's own shipped detectors so oracle and caam agree on what "rate
 * limited" means for this exact CLI:
 *
 *  - Rate-limit patterns: `internal/ratelimit/detector.go:31-39`
 *    (`DefaultPatterns()[ProviderClaude]`) — a plain line-based
 *    regex-over-text scan, not a JSON-field check.
 *  - Challenge/auth patterns: `internal/health/penalty.go:76-90`'s
 *    `isAuthError` keyword set, plus CLI-idiomatic phrasing. Unlike the
 *    rate-limit set (which has a load-bearing upstream reference
 *    implementation to copy verbatim), no real Claude Code CLI
 *    auth-challenge transcript has been captured — this list is a
 *    best-effort seed, shipped as an easily-extended exported array (same
 *    convention as the browser lane's `RATE_LIMIT_PHRASES`,
 *    `src/browser/actions/challengeDetection.ts:117-123`) so it can be
 *    grown from a real incident without touching control flow.
 *
 * Precedence is load-bearing and mirrors caam's own `penalty.go` ordering
 * (`isAuthError` checked before `isRateLimitError`): challenge/auth is
 * checked FIRST. An ambiguous line that matches both pattern sets never
 * rotates — it hard-halts. Fail safe toward "ask a human", never toward
 * "auto-retry into a possibly-compromised account."
 */

export const CLAUDE_CODE_RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /usage.?limit/i,
  /capacity/i,
  /\b429\b/,
  /too.?many.?requests/i,
  /exceeded.*quota/i,
  /quota.*exceeded/i,
];

export const CLAUDE_CODE_CHALLENGE_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /forbidden/i,
  /authentication failed/i,
  /invalid token/i,
  /re-?authenticate/i,
  /please log in/i,
  /session expired/i,
  /logged out/i,
];

export type ClaudeCodeRateLimitOrChallengeKind = "challenge" | "rate_limit";

export interface ClaudeCodeRateLimitOrChallengeMatch {
  kind: ClaudeCodeRateLimitOrChallengeKind;
  /** The regex source that matched, for logging/audit. */
  pattern: string;
  /** The (truncated) text that matched, for logging/audit. */
  matchedText: string;
}

const MAX_MATCHED_TEXT_LENGTH = 400;

/**
 * Scans a single piece of text against the challenge set first, then the
 * rate-limit set (§1.3 precedence). Returns `undefined` when neither
 * matches.
 */
export function matchClaudeCodeRateLimitOrChallengeText(
  text: string | undefined,
): ClaudeCodeRateLimitOrChallengeMatch | undefined {
  if (!text) {
    return undefined;
  }
  for (const pattern of CLAUDE_CODE_CHALLENGE_PATTERNS) {
    if (pattern.test(text)) {
      return { kind: "challenge", pattern: pattern.source, matchedText: truncateMatch(text) };
    }
  }
  for (const pattern of CLAUDE_CODE_RATE_LIMIT_PATTERNS) {
    if (pattern.test(text)) {
      return { kind: "rate_limit", pattern: pattern.source, matchedText: truncateMatch(text) };
    }
  }
  return undefined;
}

function truncateMatch(text: string, maxLength: number = MAX_MATCHED_TEXT_LENGTH): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
