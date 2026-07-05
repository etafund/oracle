import { describe, expect, test } from "vitest";

import {
  CLAUDE_CODE_CHALLENGE_PATTERNS,
  CLAUDE_CODE_RATE_LIMIT_PATTERNS,
  matchClaudeCodeRateLimitOrChallengeText,
} from "../../src/claude-code/rateLimitPatterns.js";

describe("matchClaudeCodeRateLimitOrChallengeText", () => {
  test("matches caam's own rate-limit vocabulary verbatim", () => {
    for (const text of [
      "Claude AI usage limit reached",
      "429 Too Many Requests",
      "You have exceeded your quota",
      "rate limit exceeded, please retry later",
      "quota exceeded, try again shortly",
    ]) {
      const match = matchClaudeCodeRateLimitOrChallengeText(text);
      expect(match?.kind).toBe("rate_limit");
    }
  });

  test("matches challenge/auth phrases and prioritizes them over rate-limit phrasing", () => {
    for (const text of [
      "authentication failed, please log in again",
      "401 Unauthorized",
      "403 Forbidden",
      "invalid token",
      "session expired, please re-authenticate",
    ]) {
      const match = matchClaudeCodeRateLimitOrChallengeText(text);
      expect(match?.kind).toBe("challenge");
    }
  });

  test("an ambiguous line matching both sets resolves as challenge (fail safe toward hard-halt)", () => {
    const match = matchClaudeCodeRateLimitOrChallengeText(
      "401 Unauthorized: rate limit exceeded for this revoked token",
    );
    expect(match?.kind).toBe("challenge");
  });

  test("returns undefined for ordinary text", () => {
    expect(matchClaudeCodeRateLimitOrChallengeText("Here is the final answer to your question.")).toBeUndefined();
    expect(matchClaudeCodeRateLimitOrChallengeText("")).toBeUndefined();
    expect(matchClaudeCodeRateLimitOrChallengeText(undefined)).toBeUndefined();
  });

  test("truncates very long matched text for logging", () => {
    const longText = `rate limit ${"x".repeat(1000)}`;
    const match = matchClaudeCodeRateLimitOrChallengeText(longText);
    expect(match?.matchedText.length).toBeLessThan(longText.length);
    expect(match?.matchedText.endsWith("…")).toBe(true);
  });

  test("pattern sets are non-empty and exported for extension", () => {
    expect(CLAUDE_CODE_RATE_LIMIT_PATTERNS.length).toBeGreaterThan(0);
    expect(CLAUDE_CODE_CHALLENGE_PATTERNS.length).toBeGreaterThan(0);
  });

  test("no longer matches a bare 'capacity' word (oracle-router-n0t: too generic, dropped)", () => {
    expect(
      matchClaudeCodeRateLimitOrChallengeText("the storage volume has more capacity now"),
    ).toBeUndefined();
    expect(
      matchClaudeCodeRateLimitOrChallengeText("let's raise the team's capacity for next sprint"),
    ).toBeUndefined();
  });
});
