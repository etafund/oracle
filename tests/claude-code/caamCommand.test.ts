import { describe, expect, test } from "vitest";

import { buildClaudeCodeCommand } from "../../src/claude-code/command.js";
import {
  CAAM_SHALLOW_HOMES_DIR_ENV_VAR,
  ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR,
  ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR,
  buildCaamShallowSpawnCommand,
  resolveClaudeCodeCaamBase,
  resolveClaudeCodeCaamProfile,
  validateCaamBasePath,
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

  test("rejects a relative shallow-profile base before building the command", () => {
    expect(() =>
      buildCaamShallowSpawnCommand({
        caamExecutable: "/opt/caam",
        profile: "beta",
        base: "orch-homes",
        inner: buildClaudeCodeCommand(),
      }),
    ).toThrow(/must be an absolute path/);
  });
});

describe("resolveClaudeCodeCaamProfile — opt-in activation knob", () => {
  test("returns undefined (opts out) when neither the config key nor the env var is set", () => {
    expect(resolveClaudeCodeCaamProfile(undefined, {})).toBeUndefined();
    expect(
      resolveClaudeCodeCaamProfile(undefined, { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "" }),
    ).toBeUndefined();
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

  test("rejects an explicitly empty config value instead of silently selecting direct Claude", () => {
    expect(() => resolveClaudeCodeCaamProfile("", {})).toThrow(
      /explicitly configured.*cannot be empty/i,
    );
    expect(() =>
      resolveClaudeCodeCaamProfile("   ", {
        [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "env-profile",
      }),
    ).toThrow(/cannot be empty/i);
  });

  test("rejects unsafe profile names from both explicit config and the environment", () => {
    expect(() => resolveClaudeCodeCaamProfile("../evil", {})).toThrow(/not a safe identifier/);
    expect(() =>
      resolveClaudeCodeCaamProfile(undefined, {
        [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "nested/evil",
      }),
    ).toThrow(/not a safe identifier/);
  });
});

describe("resolveClaudeCodeCaamBase — one base for doctor and launch", () => {
  test("prefers the explicit config value over both environment forms", () => {
    expect(
      resolveClaudeCodeCaamBase("/profiles/config", {
        [ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR]: "/profiles/oracle-env",
        [CAAM_SHALLOW_HOMES_DIR_ENV_VAR]: "/profiles/caam-env",
        HOME: "/home/user",
      }),
    ).toEqual({ base: "/profiles/config", source: "config" });
  });

  test("prefers Oracle's env override over caam's native env override", () => {
    expect(
      resolveClaudeCodeCaamBase(undefined, {
        [ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR]: "/profiles/oracle-env",
        [CAAM_SHALLOW_HOMES_DIR_ENV_VAR]: "/profiles/caam-env",
        HOME: "/home/user",
      }),
    ).toEqual({ base: "/profiles/oracle-env", source: "oracle_env" });
  });

  test("honors caam's native shallow-homes environment override", () => {
    expect(
      resolveClaudeCodeCaamBase(undefined, {
        [CAAM_SHALLOW_HOMES_DIR_ENV_VAR]: "/profiles/caam-env",
        HOME: "/home/user",
      }),
    ).toEqual({ base: "/profiles/caam-env", source: "caam_env" });
  });

  test("recognizes an existing shallow HOME and resolves its sibling-profile base", () => {
    expect(
      resolveClaudeCodeCaamBase(undefined, {
        HOME: "/home/ubuntu/orch-homes/cod-arthur",
        SHALLOW_PROFILE: "cod-arthur",
      }),
    ).toEqual({
      base: "/home/ubuntu/orch-homes",
      source: "shallow_home_parent",
    });
  });

  test("uses HOME/orch-homes outside a shallow profile", () => {
    expect(resolveClaudeCodeCaamBase(undefined, { HOME: "/home/ubuntu" })).toEqual({
      base: "/home/ubuntu/orch-homes",
      source: "home_default",
    });
  });

  test("fails closed when neither an absolute base nor HOME is available", () => {
    expect(() => resolveClaudeCodeCaamBase(undefined, {})).toThrow(/HOME is unset/);
    expect(() => validateCaamBasePath("relative/orch-homes")).toThrow(/must be an absolute path/);
  });

  test("rejects an explicitly empty base instead of falling through to HOME", () => {
    expect(() => resolveClaudeCodeCaamBase("", { HOME: "/home/ubuntu" })).toThrow(
      /must be an absolute path/i,
    );
    expect(() => resolveClaudeCodeCaamBase("   ", { HOME: "/home/ubuntu" })).toThrow(
      /must be an absolute path/i,
    );
  });

  test("canonicalizes a trailing separator for stable account identity comparisons", () => {
    expect(validateCaamBasePath("/home/ubuntu/orch-homes/")).toBe("/home/ubuntu/orch-homes");
  });
});
