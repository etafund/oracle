import { describe, expect, test } from "vitest";
import {
  shouldRequirePrompt,
  isSuspiciousBarePositionalPrompt,
} from "../../src/cli/promptRequirement.js";

describe("shouldRequirePrompt", () => {
  test("allows status subcommand without prompt", () => {
    const requires = shouldRequirePrompt(["status"], { status: undefined });
    expect(requires).toBe(false);
  });

  test("allows session subcommand without prompt", () => {
    const requires = shouldRequirePrompt(["session", "abc123"], { session: undefined });
    expect(requires).toBe(false);
  });

  test("allows follow-up subcommand to resolve its own prompt", () => {
    const requires = shouldRequirePrompt(["follow-up", "abc123"], {});
    expect(requires).toBe(false);
  });

  test("requires prompt for default run", () => {
    const requires = shouldRequirePrompt(["--model", "gpt-5.1"], {});
    expect(requires).toBe(true);
  });

  test("requires prompt when preview enabled and no positional provided", () => {
    const requires = shouldRequirePrompt([], { preview: "summary" });
    expect(requires).toBe(true);
  });

  test("allows root --session flag without prompt", () => {
    const requires = shouldRequirePrompt(["--session", "abc123"], { session: "abc123" });
    expect(requires).toBe(false);
  });

  test("allows hidden finalizer command without prompt", () => {
    const requires = shouldRequirePrompt(["--finalize-session", "abc123"], {
      finalizeSession: "abc123",
    });
    expect(requires).toBe(false);
  });
});

describe("isSuspiciousBarePositionalPrompt", () => {
  test.each(["lanes", "models", "login", "statuss", "doctorr"])(
    "treats the single-word bare positional %s as suspicious (fail-closed)",
    (token) => {
      expect(isSuspiciousBarePositionalPrompt(token)).toBe(true);
    },
  );

  test("allows a multi-word prompt (contains whitespace)", () => {
    expect(isSuspiciousBarePositionalPrompt("explain this codebase")).toBe(false);
    expect(isSuspiciousBarePositionalPrompt("review the diff for bugs")).toBe(false);
  });

  test("ignores undefined / empty tokens", () => {
    expect(isSuspiciousBarePositionalPrompt(undefined)).toBe(false);
    expect(isSuspiciousBarePositionalPrompt("")).toBe(false);
    expect(isSuspiciousBarePositionalPrompt("   ")).toBe(false);
  });
});
