import { describe, expect, test } from "vitest";

import {
  DEFAULT_CLAUDE_CODE_SYSTEM_PROMPT,
  buildClaudeCodeCommand,
} from "../../src/claude-code/command.js";

describe("Claude Code command builder", () => {
  test("builds the hidden-alpha argv shape without shell execution", () => {
    const command = buildClaudeCodeCommand();

    expect(command.file).toBe("claude");
    expect(command.spawnOptions.shell).toBe(false);
    expect(command.args).toEqual([
      "-p",
      "--system-prompt",
      DEFAULT_CLAUDE_CODE_SYSTEM_PROMPT,
      "--model",
      "fable",
      "--effort",
      "xhigh",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--include-hook-events",
      "--permission-mode",
      "plan",
      "--safe-mode",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disallowedTools",
      "mcp__*",
      "--no-chrome",
      "--no-session-persistence",
      "--tools",
      "",
    ]);
  });

  test("does not emit dangerous or out-of-scope flags", () => {
    const { args } = buildClaudeCodeCommand();

    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
    expect(args).not.toContain("--input-format");
    expect(args).not.toContain("--continue");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("bypassPermissions");
    expect(args.join(" ")).not.toContain("Read");
    expect(args.join(" ")).not.toContain("Bash");
  });

  test("allows reviewed model/executable inputs but rejects raw pass-through args", () => {
    expect(
      buildClaudeCodeCommand({ executable: "/opt/claude", model: "claude-fable-5" }),
    ).toMatchObject({
      file: "/opt/claude",
      args: expect.arrayContaining(["claude-fable-5"]),
    });

    expect(() =>
      buildClaudeCodeCommand({ extraArgs: ["--bare"] } as unknown as Parameters<
        typeof buildClaudeCodeCommand
      >[0]),
    ).toThrow(/raw pass-through/);
  });

  test("one-shot (no resumeSessionId) still has no persistence — unchanged default behavior", () => {
    const { args } = buildClaudeCodeCommand();

    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--session-id");
  });

  test("a followup builds the correct --session-id argv instead of --no-session-persistence", () => {
    const resumeSessionId = "5b1a2c3d-4e5f-6789-abcd-ef0123456789";
    const { args } = buildClaudeCodeCommand({ resumeSessionId });

    expect(args).not.toContain("--no-session-persistence");
    const sessionIdIndex = args.indexOf("--session-id");
    expect(sessionIdIndex).toBeGreaterThan(-1);
    expect(args[sessionIdIndex + 1]).toBe(resumeSessionId);
    // Placed exactly where `--no-session-persistence` used to sit, tools
    // untouched either side, so the rest of the argv shape is unaffected.
    expect(args).toEqual([
      "-p",
      "--system-prompt",
      DEFAULT_CLAUDE_CODE_SYSTEM_PROMPT,
      "--model",
      "fable",
      "--effort",
      "xhigh",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--include-hook-events",
      "--permission-mode",
      "plan",
      "--safe-mode",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disallowedTools",
      "mcp__*",
      "--no-chrome",
      "--session-id",
      resumeSessionId,
      "--tools",
      "",
    ]);
  });

  test("rejects a non-UUID resumeSessionId instead of embedding it in argv", () => {
    expect(() => buildClaudeCodeCommand({ resumeSessionId: "not-a-uuid" })).toThrow(
      /not a valid UUID/,
    );
    expect(() => buildClaudeCodeCommand({ resumeSessionId: "; rm -rf ~" })).toThrow(
      /not a valid UUID/,
    );
  });

  test("resumeSessionId never smuggles a raw --resume/--continue/--fork-session passthrough", () => {
    // The dangerous-flag blocklist stays intact regardless of the new
    // resume option: it is impossible to make buildClaudeCodeCommand emit
    // any of these, whether or not a followup is in play.
    const oneShot = buildClaudeCodeCommand();
    const resumed = buildClaudeCodeCommand({
      resumeSessionId: "5b1a2c3d-4e5f-6789-abcd-ef0123456789",
    });
    for (const { args } of [oneShot, resumed]) {
      expect(args).not.toContain("--resume");
      expect(args).not.toContain("--continue");
      expect(args).not.toContain("--fork-session");
    }
    // And the raw pass-through rejection still fires even when a caller
    // tries to combine it with a legitimate resumeSessionId.
    expect(() =>
      buildClaudeCodeCommand({
        resumeSessionId: "5b1a2c3d-4e5f-6789-abcd-ef0123456789",
        args: ["--resume", "some-id"],
      } as unknown as Parameters<typeof buildClaudeCodeCommand>[0]),
    ).toThrow(/raw pass-through/);
  });

  test("error-teaches: raw pass-through rejection names the exact reviewed-lane fix", () => {
    expect(() =>
      buildClaudeCodeCommand({ extraArgs: ["--bare"] } as unknown as Parameters<
        typeof buildClaudeCodeCommand
      >[0]),
    ).toThrow(/oracle -p "<prompt>" --lane fable-local/);
  });
});
