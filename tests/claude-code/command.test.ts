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
});
