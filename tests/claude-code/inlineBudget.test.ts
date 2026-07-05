import { describe, expect, test } from "vitest";

import {
  ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR,
  DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES,
  resolveClaudeCodeMaxInlineBytes,
  assertClaudeCodeInlineBudget,
} from "../../src/claude-code/inlineBudget.js";
import { FileValidationError } from "../../src/oracle/errors.js";

describe("resolveClaudeCodeMaxInlineBytes (claude-provider-map.md finding #1)", () => {
  test("falls back to the default when nothing is configured or set", () => {
    expect(resolveClaudeCodeMaxInlineBytes(undefined, {})).toBe(
      DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES,
    );
  });

  test("the previously-dead env var now sets the budget", () => {
    expect(
      resolveClaudeCodeMaxInlineBytes(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR]: "12345",
      }),
    ).toBe(12345);
  });

  test("an explicit programmatic override wins over the env var", () => {
    expect(
      resolveClaudeCodeMaxInlineBytes(999, {
        [ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR]: "12345",
      }),
    ).toBe(999);
  });

  test("rejects a malformed env var value with a clear error", () => {
    expect(() =>
      resolveClaudeCodeMaxInlineBytes(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR]: "not-a-number",
      }),
    ).toThrow(/positive integer/);
  });

  test("ignores a non-positive or non-finite configured value and falls back", () => {
    expect(resolveClaudeCodeMaxInlineBytes(0, {})).toBe(DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES);
    expect(resolveClaudeCodeMaxInlineBytes(-5, {})).toBe(DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES);
    expect(resolveClaudeCodeMaxInlineBytes(Number.NaN, {})).toBe(
      DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES,
    );
  });
});

describe("assertClaudeCodeInlineBudget (claude-provider-map.md finding #1, concrete gap #2)", () => {
  test("passes silently when the combined prompt is within budget", () => {
    expect(() => assertClaudeCodeInlineBudget("short prompt", 100, {})).not.toThrow();
  });

  test("throws a FileValidationError naming the measured size and the limit when over budget", () => {
    expect(() => assertClaudeCodeInlineBudget("x".repeat(101), 100, {})).toThrow(
      FileValidationError,
    );
    try {
      assertClaudeCodeInlineBudget("x".repeat(101), 100, {});
      throw new Error("expected assertClaudeCodeInlineBudget to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FileValidationError);
      const message = (error as Error).message;
      expect(message).toContain("101 bytes");
      expect(message).toContain("100 bytes");
      expect(message).toContain(ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR);
    }
  });

  test("the env var alone can lower the budget enough to trigger the check", () => {
    expect(() =>
      assertClaudeCodeInlineBudget("x".repeat(50), undefined, {
        [ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR]: "10",
      }),
    ).toThrow(/exceeding the Claude Code local-mode inline budget of 10 bytes/);
  });

  test("measures UTF-8 byte length, not JS string length", () => {
    // Each "é" is 1 UTF-16 code unit but 2 UTF-8 bytes; 60 of them is 120
    // bytes, over a 100-byte budget even though `.length` is only 60.
    const prompt = "é".repeat(60);
    expect(prompt.length).toBe(60);
    expect(() => assertClaudeCodeInlineBudget(prompt, 100, {})).toThrow(/120 bytes/);
  });
});
