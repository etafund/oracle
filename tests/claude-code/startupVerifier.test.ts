import { describe, expect, test } from "vitest";

import { verifyClaudeCodeRun } from "../../src/claude-code/startupVerifier.js";

function startup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    model: "claude-fable-5",
    tools: [],
    mcp_servers: [],
    permissionMode: "plan",
    slash_commands: [],
    skills: [],
    plugins: [],
    fast_mode_state: "off",
    agents: ["claude", "Explore", "general-purpose", "Plan"],
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    modelUsage: {
      "claude-fable-5": {},
      "claude-haiku-4-5-20251001": {},
    },
    total_cost_usd: 0,
    ...overrides,
  };
}

describe("Claude Code startup/result verifier", () => {
  test("accepts the observed subscription startup shape with auxiliary Haiku bookkeeping", () => {
    const verified = verifyClaudeCodeRun([{ json: startup() }, { json: result() }]);

    expect(verified.ok).toBe(true);
    expect(verified.failures).toEqual([]);
    expect(verified.metadata).toMatchObject({
      apiKeySource: "none",
      modelRequested: "fable",
      modelResolvedFromInit: "claude-fable-5",
      modelObserved: "claude-fable-5",
      modelUsageKeys: ["claude-fable-5", "claude-haiku-4-5-20251001"],
      modelUsageAuxiliaryKeys: ["claude-haiku-4-5-20251001"],
      modelVerificationStatus: "observed",
      totalCostUsdObserved: 0,
      visibleThinkingCaptured: false,
    });
  });

  test("accepts requested Fable aliases in visible startup model evidence", () => {
    expect(verifyClaudeCodeRun([startup({ model: "fable" }), result()]).ok).toBe(true);
  });

  test("rejects API auth, available tools, MCP servers, and model mismatch", () => {
    const verified = verifyClaudeCodeRun([
      startup({
        apiKeySource: "ANTHROPIC_API_KEY",
        tools: ["Read"],
        mcp_servers: [{ name: "local" }],
        model: "claude-haiku-4-5-20251001",
      }),
      result(),
    ]);

    expect(verified.ok).toBe(false);
    expect(verified.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "api_auth_source_rejected", field: "apiKeySource" }),
        expect.objectContaining({ code: "non_empty_surface", field: "tools" }),
        expect.objectContaining({ code: "non_empty_surface", field: "mcp_servers" }),
        expect.objectContaining({ code: "model_mismatch", field: "model" }),
      ]),
    );
  });

  test("rejects custom surfaces and fallback/session persistence signals", () => {
    const verified = verifyClaudeCodeRun([
      startup({
        agents: ["claude", "custom-reviewer"],
        slash_commands: ["project-command"],
        skills: ["local-skill"],
        plugins: ["local-plugin"],
        fast_mode_state: "on",
        fallback_model: "claude-haiku-4-5-20251001",
        sessionPersistence: true,
      }),
      result(),
    ]);

    expect(verified.ok).toBe(false);
    expect(verified.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "custom_agents_rejected", field: "agents" }),
        expect.objectContaining({ code: "non_empty_surface", field: "slash_commands" }),
        expect.objectContaining({ code: "non_empty_surface", field: "skills" }),
        expect.objectContaining({ code: "non_empty_surface", field: "plugins" }),
        expect.objectContaining({ code: "unexpected_startup_value", field: "fast_mode_state" }),
        expect.objectContaining({ code: "unexpected_startup_value", field: "fallback_model" }),
        expect.objectContaining({ code: "unexpected_startup_value", field: "sessionPersistence" }),
      ]),
    );
  });

  test("rejects missing critical startup fields", () => {
    const badStartup = startup();
    delete badStartup.tools;
    delete badStartup.apiKeySource;

    const verified = verifyClaudeCodeRun([badStartup, result()]);

    expect(verified.ok).toBe(false);
    expect(verified.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_api_key_source" }),
        expect.objectContaining({ code: "missing_or_invalid_empty_array", field: "tools" }),
      ]),
    );
  });

  test("rejects non-Fable result usage unless primary Fable evidence exists", () => {
    const verified = verifyClaudeCodeRun([
      startup(),
      result({ modelUsage: { "claude-haiku-4-5-20251001": {} } }),
    ]);

    expect(verified.ok).toBe(false);
    expect(verified.metadata.modelVerificationStatus).toBe("fallback_observed");
    expect(verified.failures).toContainEqual(
      expect.objectContaining({ code: "model_usage_mismatch", field: "modelUsage" }),
    );
  });

  test("marks visible thinking when the stream exposes thinking deltas", () => {
    const verified = verifyClaudeCodeRun([
      startup(),
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "visible" },
        },
      },
      result(),
    ]);

    expect(verified.ok).toBe(true);
    expect(verified.metadata.visibleThinkingCaptured).toBe(true);
  });
});
