import { describe, expect, test } from "vitest";
import type { execFile } from "node:child_process";

import {
  CaamRotationError,
  runCaamCooldownSet,
  runCaamRobotNext,
  resolveClaudeCodeMaxRateLimitRotations,
  ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR,
} from "../../src/claude-code/caamRotation.js";

type ExecFileCallback = (
  error: (Error & { code?: number | string }) | null,
  stdout: string,
  stderr: string,
) => void;

interface FakeResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: Error & { code?: string };
}

function fakeExecFileSequence(responses: FakeResponse[]): {
  impl: typeof execFile;
  calls: string[][];
} {
  const calls: string[][] = [];
  let callIndex = 0;
  const impl = ((
    file: string,
    args: readonly string[],
    _options: unknown,
    callback: ExecFileCallback,
  ) => {
    calls.push([file, ...args]);
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex += 1;
    if (response.spawnError) {
      callback(response.spawnError, response.stdout ?? "", response.stderr ?? "");
      return {} as ReturnType<typeof execFile>;
    }
    if (response.exitCode && response.exitCode !== 0) {
      const error = Object.assign(new Error(`Command failed with exit code ${response.exitCode}`), {
        code: response.exitCode,
      });
      callback(error, response.stdout ?? "", response.stderr ?? "");
      return {} as ReturnType<typeof execFile>;
    }
    callback(null, response.stdout ?? "", response.stderr ?? "");
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
  return { impl, calls };
}

describe("runCaamCooldownSet (caam cooldown set claude/<profile>)", () => {
  test("succeeds on exit 0 and never parses stdout text for its verdict", async () => {
    const { impl, calls } = fakeExecFileSequence([{ stdout: "Recorded cooldown for claude/arthur until ...\n" }]);

    await expect(
      runCaamCooldownSet("/opt/caam", "claude", "arthur", 60, "session sess-1: rate_limit pattern 'rate limit'", {
        execFileImpl: impl,
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      [
        "/opt/caam",
        "cooldown",
        "set",
        "claude/arthur",
        "--minutes",
        "60",
        "--notes",
        "session sess-1: rate_limit pattern 'rate limit'",
      ],
    ]);
  });

  test("throws CaamRotationError on a non-zero exit (callers must treat this as non-fatal)", async () => {
    const { impl } = fakeExecFileSequence([
      { exitCode: 1, stderr: "Error: db unavailable\n" },
    ]);

    await expect(
      runCaamCooldownSet("/opt/caam", "claude", "arthur", 60, "note", { execFileImpl: impl }),
    ).rejects.toThrow(CaamRotationError);
    await expect(
      runCaamCooldownSet("/opt/caam", "claude", "arthur", 60, "note", { execFileImpl: impl }),
    ).rejects.toThrow(/db unavailable/);
  });
});

describe("runCaamRobotNext (caam robot next claude --strategy smart)", () => {
  test("returns the candidate profile on a well-formed success envelope, never passing --include-cooldown", async () => {
    const { impl, calls } = fakeExecFileSequence([
      {
        stdout: JSON.stringify({
          success: true,
          command: "next",
          data: { provider: "claude", profile: "beth", score: 123 },
        }),
      },
    ]);

    const outcome = await runCaamRobotNext("/opt/caam", "claude", { execFileImpl: impl });

    expect(calls).toEqual([["/opt/caam", "robot", "next", "claude", "--strategy", "smart"]]);
    expect(calls[0]).not.toContain("--include-cooldown");
    expect(outcome).toEqual({ success: true, profile: "beth", raw: expect.any(Object) });
  });

  test("only trusts the FIRST JSON object on stdout, ignoring trailing human-readable error text", async () => {
    const { impl } = fakeExecFileSequence([
      {
        stdout: `${JSON.stringify({
          success: false,
          error: { code: "NO_PROFILES", message: "no profiles found for claude" },
        })}\nError: NO_PROFILES: no profiles found for claude\nUsage:\n  caam robot next\n`,
        exitCode: 1,
      },
    ]);

    const outcome = await runCaamRobotNext("/opt/caam", "claude", { execFileImpl: impl });

    expect(outcome).toEqual({
      success: false,
      code: "NO_PROFILES",
      message: "no profiles found for claude",
      raw: expect.any(Object),
    });
  });

  test("NO_PROFILES / ALL_BLOCKED envelopes are returned, not thrown — this is rotation exhaustion, not a crash", async () => {
    const { impl } = fakeExecFileSequence([
      {
        exitCode: 1,
        stdout: JSON.stringify({
          success: false,
          error: { code: "ALL_BLOCKED", message: "all profiles are blocked or in cooldown" },
        }),
      },
    ]);

    const outcome = await runCaamRobotNext("/opt/caam", "claude", { execFileImpl: impl });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.code).toBe("ALL_BLOCKED");
    }
  });

  test("throws CaamRotationError when stdout has no parseable JSON at all", async () => {
    const { impl } = fakeExecFileSequence([{ exitCode: 1, stdout: "", stderr: "boom\n" }]);

    await expect(runCaamRobotNext("/opt/caam", "claude", { execFileImpl: impl })).rejects.toThrow(
      CaamRotationError,
    );
  });

  test("throws CaamRotationError when success:true but data.profile is missing", async () => {
    const { impl } = fakeExecFileSequence([
      { stdout: JSON.stringify({ success: true, data: { provider: "claude" } }) },
    ]);

    await expect(runCaamRobotNext("/opt/caam", "claude", { execFileImpl: impl })).rejects.toThrow(
      /data\.profile/,
    );
  });
});

describe("resolveClaudeCodeMaxRateLimitRotations", () => {
  test("prefers the explicit programmatic override over the env var", () => {
    expect(
      resolveClaudeCodeMaxRateLimitRotations(3, {
        [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "9",
      }),
    ).toBe(3);
  });

  test("falls back to the env var when unset", () => {
    expect(
      resolveClaudeCodeMaxRateLimitRotations(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "5",
      }),
    ).toBe(5);
  });

  test("defaults to 2 when neither is set", () => {
    expect(resolveClaudeCodeMaxRateLimitRotations(undefined, {})).toBe(2);
  });

  test("0 is a valid override (fully disables rotation)", () => {
    expect(resolveClaudeCodeMaxRateLimitRotations(0, {})).toBe(0);
    expect(
      resolveClaudeCodeMaxRateLimitRotations(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "0",
      }),
    ).toBe(0);
  });

  test("ignores a negative/garbage env var and falls back to the default", () => {
    expect(
      resolveClaudeCodeMaxRateLimitRotations(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "not-a-number",
      }),
    ).toBe(2);
    expect(
      resolveClaudeCodeMaxRateLimitRotations(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "-1",
      }),
    ).toBe(2);
  });
});
