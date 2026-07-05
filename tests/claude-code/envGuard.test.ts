import { describe, expect, test } from "vitest";

import {
  ClaudeCodeEnvGuardError,
  findBlockedClaudeCodeEnvironmentSources,
  prepareClaudeCodeEnvironment,
} from "../../src/claude-code/envGuard.js";

describe("Claude Code env guard", () => {
  test("passes with a boring allowlisted environment", () => {
    const prepared = prepareClaudeCodeEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/user",
      USER: "user",
      OPENAI_API_KEY: "sk-test",
    });

    expect(prepared.childEnv).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      USER: "user",
    });
    expect(prepared.warnings).toEqual([]);
  });

  test("hard-refuses ANTHROPIC_API_KEY presence regardless of value or case", () => {
    for (const env of [
      { ANTHROPIC_API_KEY: "" },
      { ANTHROPIC_API_KEY: "   " },
      { anthropic_api_key: "sk-ant-secret" },
    ]) {
      expect(() => prepareClaudeCodeEnvironment(env)).toThrow(ClaudeCodeEnvGuardError);
    }
  });

  test("error messages name sources but do not print secret values", () => {
    try {
      prepareClaudeCodeEnvironment({ ANTHROPIC_API_KEY: "sk-ant-secret-value" });
      throw new Error("expected env guard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeCodeEnvGuardError);
      expect(String((error as Error).message)).toContain("ANTHROPIC_API_KEY");
      expect(String((error as Error).message)).not.toContain("sk-ant-secret-value");
    }
  });

  test("refuses ambiguous Anthropic and provider routing variables", () => {
    const sources = findBlockedClaudeCodeEnvironmentSources({
      ANTHROPIC_AUTH_TOKEN: "token",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "x",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
    });

    expect(sources).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_VERTEX",
    ]);
  });

  test("scrubs ANTHROPIC_MODEL with an explicit warning by default", () => {
    const prepared = prepareClaudeCodeEnvironment({
      PATH: "/usr/bin",
      ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
    });

    expect(prepared.childEnv).toEqual({ PATH: "/usr/bin" });
    expect(prepared.scrubbedSources).toEqual(["ANTHROPIC_MODEL"]);
    expect(prepared.warnings).toEqual([
      expect.objectContaining({
        source: "ANTHROPIC_MODEL",
        action: "omitted_from_child_env",
      }),
    ]);
  });

  test("can conservatively refuse ANTHROPIC_MODEL when requested", () => {
    expect(() =>
      prepareClaudeCodeEnvironment(
        { ANTHROPIC_MODEL: "claude-haiku-4-5-20251001" },
        { anthropicModelPolicy: "refuse" },
      ),
    ).toThrow(/ANTHROPIC_MODEL/);
  });

  test("allowlists ORACLE_CLAUDE_CODE_CAAM_PROFILE as an argv-derived value, not a secret", () => {
    const prepared = prepareClaudeCodeEnvironment({
      PATH: "/usr/bin",
      ORACLE_CLAUDE_CODE_CAAM_PROFILE: "arthur",
    });

    expect(prepared.childEnv).toEqual({
      PATH: "/usr/bin",
      ORACLE_CLAUDE_CODE_CAAM_PROFILE: "arthur",
    });
  });

  test("a configured caam profile does not loosen the ANTHROPIC_* refusal", () => {
    expect(() =>
      prepareClaudeCodeEnvironment({
        PATH: "/usr/bin",
        ORACLE_CLAUDE_CODE_CAAM_PROFILE: "arthur",
        ANTHROPIC_API_KEY: "sk-ant-secret",
      }),
    ).toThrow(ClaudeCodeEnvGuardError);
  });
});
