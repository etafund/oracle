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

  test("compatibility one-shot (no session id) retains no persistence", () => {
    const { args } = buildClaudeCodeCommand();

    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--session-id");
  });

  test("a reviewed one-shot persists under the exact builder-owned --session-id", () => {
    const sessionId = "6c2b3d4e-5f60-4789-abcd-ef0123456789";
    const { args } = buildClaudeCodeCommand({ sessionId });

    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    expect(args[args.indexOf("--session-id") + 1]).toBe(sessionId);
  });

  test("a followup builds the real --resume argv instead of starting a new session", () => {
    const resumeSessionId = "5b1a2c3d-4e5f-6789-abcd-ef0123456789";
    const { args } = buildClaudeCodeCommand({ resumeSessionId });

    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--session-id");
    const resumeIndex = args.indexOf("--resume");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(args[resumeIndex + 1]).toBe(resumeSessionId);
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
      "--resume",
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

  test("rejects invalid/conflicting new-session ids", () => {
    expect(() => buildClaudeCodeCommand({ sessionId: "not-a-uuid" })).toThrow(/not a valid UUID/);
    expect(() =>
      buildClaudeCodeCommand({
        sessionId: "6c2b3d4e-5f60-4789-abcd-ef0123456789",
        resumeSessionId: "5b1a2c3d-4e5f-6789-abcd-ef0123456789",
      }),
    ).toThrow(/cannot start a new --session-id and --resume/i);
  });

  test("only the validated builder-owned --resume path bypasses the dangerous-flag guard", () => {
    const oneShot = buildClaudeCodeCommand();
    const resumed = buildClaudeCodeCommand({
      resumeSessionId: "5b1a2c3d-4e5f-6789-abcd-ef0123456789",
    });
    expect(oneShot.args).not.toContain("--resume");
    expect(resumed.args).toContain("--resume");
    for (const { args } of [oneShot, resumed]) {
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
    ).toThrow(/oracle -p "<prompt>" --lane fable-local --caam-profile <name>/);
  });

  describe("stream-json input transport flag (bead oracle-router-8fa)", () => {
    test("flag OFF (default / explicit false) is byte-identical to the legacy argv", () => {
      const legacy = buildClaudeCodeCommand();
      const explicitOff = buildClaudeCodeCommand({ streamJsonInput: false });
      expect(explicitOff.args).toEqual(legacy.args);
      expect(legacy.args).not.toContain("--input-format");
    });

    test("flag ON inserts exactly `--input-format stream-json` and nothing else changes", () => {
      const off = buildClaudeCodeCommand();
      const on = buildClaudeCodeCommand({ streamJsonInput: true });

      const inputFormatIndex = on.args.indexOf("--input-format");
      expect(inputFormatIndex).toBeGreaterThan(-1);
      expect(on.args[inputFormatIndex + 1]).toBe("stream-json");
      // Paired immediately before the (already present) output-format pair,
      // both required by claude for stream-json input.
      expect(on.args[inputFormatIndex + 2]).toBe("--output-format");
      expect(on.args[inputFormatIndex + 3]).toBe("stream-json");

      // Removing just the two inserted tokens reproduces the legacy argv.
      const withoutInputFormat = [...on.args];
      withoutInputFormat.splice(inputFormatIndex, 2);
      expect(withoutInputFormat).toEqual(off.args);
    });

    test("stream-json input still keeps the read-only output/permission flags", () => {
      const { args } = buildClaudeCodeCommand({ streamJsonInput: true });
      expect(args).toContain("-p");
      expect(args).toContain("--verbose");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
      expect(args[args.indexOf("--tools") + 1]).toBe("");
      // --input-format is no longer blocklisted, but nothing dangerous leaked in.
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--continue");
      expect(args).not.toContain("--resume");
    });
  });
});
