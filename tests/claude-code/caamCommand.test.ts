import { describe, expect, test } from "vitest";

import { buildClaudeCodeCommand } from "../../src/claude-code/command.js";
import {
  ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR,
  buildCaamShallowSpawnCommand,
  resolveClaudeCodeCaamProfile,
  validateCaamProfileName,
} from "../../src/claude-code/caamCommand.js";

describe("caam shallow-spawn outer command builder", () => {
  test("wraps the EXISTING buildClaudeCodeCommand() argv unchanged as the tail, per caam-map.md §4a", () => {
    const inner = buildClaudeCodeCommand({ executable: "/opt/claude", model: "fable" });

    const command = buildCaamShallowSpawnCommand({
      caamExecutable: "/opt/caam",
      profile: "beta",
      base: "/home/user/.oracle/claude-code-shallow-homes",
      inner,
    });

    expect(command.file).toBe("/opt/caam");
    expect(command.args).toEqual([
      "shallow-spawn",
      "beta",
      "--base",
      "/home/user/.oracle/claude-code-shallow-homes",
      "--",
      "/opt/claude",
      ...inner.args,
    ]);
    // The inner argv is byte-for-byte the same array contents `command.ts`
    // already produced — this builder never edits it.
    expect(command.args.slice(6)).toEqual(inner.args);
    expect(command.spawnOptions).toBe(inner.spawnOptions);
  });

  test("rejects an unsafe profile name instead of building a path-traversal-capable argv", () => {
    const inner = buildClaudeCodeCommand();
    for (const badProfile of ["../../etc/passwd", "a/b", "", "  ", "profile with spaces", "a\nb"]) {
      expect(() =>
        buildCaamShallowSpawnCommand({
          caamExecutable: "/opt/caam",
          profile: badProfile,
          base: "/base",
          inner,
        }),
      ).toThrow(/not a safe identifier/);
    }
  });

  test("accepts safe profile identifiers (alnum, dash, underscore)", () => {
    for (const goodProfile of ["beta", "oracle-slot-0", "profile_1", "A1"]) {
      expect(validateCaamProfileName(goodProfile)).toBe(goodProfile);
    }
  });
});

describe("resolveClaudeCodeCaamProfile — opt-in activation knob", () => {
  test("returns undefined (opts out) when neither the config key nor the env var is set", () => {
    expect(resolveClaudeCodeCaamProfile(undefined, {})).toBeUndefined();
    expect(resolveClaudeCodeCaamProfile(undefined, { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "" })).toBeUndefined();
  });

  test("reads the env var when no explicit config key is given", () => {
    expect(
      resolveClaudeCodeCaamProfile(undefined, {
        [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
      }),
    ).toBe("beta");
  });

  test("an explicit config-key override wins over the env var", () => {
    expect(
      resolveClaudeCodeCaamProfile("configured-profile", {
        [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "env-profile",
      }),
    ).toBe("configured-profile");
  });
});
