import { describe, expect, test } from "vitest";

import {
  ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR,
  DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES,
  base64EncodedByteLength,
  resolveClaudeCodeMaxInlineBytes,
  assertClaudeCodeInlineBudget,
} from "../../src/claude-code/inlineBudget.js";
import { FileValidationError } from "../../src/oracle/errors.js";

describe("DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES (bead oracle-router-8fa re-pin)", () => {
  test("is re-pinned to the 32 MB Anthropic request-body ceiling", () => {
    // Down from the former 64 MB, which sat above both claude's 10 MB
    // text-stdin cap and the 32 MB API request-body limit.
    expect(DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe("base64EncodedByteLength (bead oracle-router-8fa)", () => {
  test("computes the padded base64 output length (~+33%) for a raw byte count", () => {
    expect(base64EncodedByteLength(0)).toBe(0);
    expect(base64EncodedByteLength(1)).toBe(4);
    expect(base64EncodedByteLength(2)).toBe(4);
    expect(base64EncodedByteLength(3)).toBe(4);
    expect(base64EncodedByteLength(4)).toBe(8);
    expect(base64EncodedByteLength(300)).toBe(400);
  });

  test("matches what Buffer.toString('base64') actually produces", () => {
    for (const size of [1, 2, 3, 17, 64, 255, 1024]) {
      const encoded = Buffer.alloc(size, 0x41).toString("base64");
      expect(encoded.length).toBe(base64EncodedByteLength(size));
    }
  });
});

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
