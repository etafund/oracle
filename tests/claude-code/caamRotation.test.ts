import { describe, expect, test } from "vitest";
import type { execFile } from "node:child_process";

import {
  CaamRotationError,
  runCaamCooldownSet,
  runCaamRobotNext,
  runCaamRobotStatus,
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
    const { impl, calls } = fakeExecFileSequence([
      { stdout: "Recorded cooldown for claude/beta until ...\n" },
    ]);

    await expect(
      runCaamCooldownSet(
        "/opt/caam",
        "claude",
        "beta",
        60,
        "session sess-1: rate_limit pattern 'rate limit'",
        {
          execFileImpl: impl,
        },
      ),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      [
        "/opt/caam",
        "cooldown",
        "set",
        "claude/beta",
        "--minutes",
        "60",
        "--notes",
        "session sess-1: rate_limit pattern 'rate limit'",
      ],
    ]);
  });

  test("throws CaamRotationError on a non-zero exit (callers must treat this as non-fatal)", async () => {
    const { impl } = fakeExecFileSequence([{ exitCode: 1, stderr: "Error: db unavailable\n" }]);

    await expect(
      runCaamCooldownSet("/opt/caam", "claude", "beta", 60, "note", { execFileImpl: impl }),
    ).rejects.toThrow(CaamRotationError);
    await expect(
      runCaamCooldownSet("/opt/caam", "claude", "beta", 60, "note", { execFileImpl: impl }),
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

describe("runCaamRobotStatus (caam robot status claude)", () => {
  test("returns per-profile health + cooldown data on a well-formed success envelope", async () => {
    const { impl, calls } = fakeExecFileSequence([
      {
        stdout: JSON.stringify({
          success: true,
          command: "status",
          data: {
            providers: [
              {
                id: "claude",
                profiles: [
                  {
                    name: "beta",
                    active: true,
                    health: { status: "healthy", expires_in: "23h" },
                    cooldown: { active: false },
                  },
                  {
                    name: "beth",
                    active: false,
                    health: { status: "critical", reason: "token expired", error_count_1h: 4 },
                    cooldown: {
                      active: true,
                      remaining_ms: 60000,
                      remaining_str: "1m0s",
                      reason: "429 rate_limit",
                    },
                  },
                ],
              },
            ],
            summary: {
              total_profiles: 2,
              active_profiles: 1,
              healthy_profiles: 1,
              cooldown_profiles: 1,
              expiring_soon: 0,
              all_profiles_blocked: false,
            },
          },
        }),
      },
    ]);

    const outcome = await runCaamRobotStatus("/opt/caam", "claude", { execFileImpl: impl });

    expect(calls).toEqual([["/opt/caam", "robot", "status", "claude"]]);
    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.data.providers[0].profiles.map((profile) => profile.name)).toEqual([
        "beta",
        "beth",
      ]);
      expect(outcome.data.providers[0].profiles[1].cooldown).toMatchObject({
        active: true,
        remaining_str: "1m0s",
      });
    }
  });

  test("returns a well-formed failure envelope (not thrown) when caam reports one", async () => {
    const { impl } = fakeExecFileSequence([
      {
        stdout: JSON.stringify({
          success: false,
          error: { code: "PROVIDER_NOT_CONFIGURED", message: "claude is not configured" },
        }),
        exitCode: 1,
      },
    ]);

    const outcome = await runCaamRobotStatus("/opt/caam", "claude", { execFileImpl: impl });

    expect(outcome).toEqual({
      success: false,
      code: "PROVIDER_NOT_CONFIGURED",
      message: "claude is not configured",
      raw: expect.any(Object),
    });
  });

  test("throws CaamRotationError when stdout has no parseable JSON at all (caam version skew / missing binary)", async () => {
    const { impl } = fakeExecFileSequence([{ exitCode: 1, stdout: "", stderr: "boom\n" }]);

    await expect(runCaamRobotStatus("/opt/caam", "claude", { execFileImpl: impl })).rejects.toThrow(
      CaamRotationError,
    );
  });

  test("throws CaamRotationError when success:true but data.providers is missing", async () => {
    const { impl } = fakeExecFileSequence([
      { stdout: JSON.stringify({ success: true, data: {} }) },
    ]);

    await expect(runCaamRobotStatus("/opt/caam", "claude", { execFileImpl: impl })).rejects.toThrow(
      /data\.providers/,
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

  test("forces fable-local rotations to 0 despite explicit and inherited positive values", () => {
    expect(
      resolveClaudeCodeMaxRateLimitRotations(
        3,
        {
          [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "9",
        },
        { lane: "fable-local" },
      ),
    ).toBe(0);
    expect(
      resolveClaudeCodeMaxRateLimitRotations(
        undefined,
        {
          [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "9",
        },
        { lane: " FABLE-LOCAL " },
      ),
    ).toBe(0);
  });

  test("defaults to 0 so an explicitly selected shallow profile stays pinned", () => {
    expect(resolveClaudeCodeMaxRateLimitRotations(undefined, {})).toBe(0);
  });

  test("0 is a valid override (fully disables rotation)", () => {
    expect(resolveClaudeCodeMaxRateLimitRotations(0, {})).toBe(0);
    expect(
      resolveClaudeCodeMaxRateLimitRotations(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "0",
      }),
    ).toBe(0);
  });

  test("ignores a negative/garbage env var and falls back to the pinned default", () => {
    expect(
      resolveClaudeCodeMaxRateLimitRotations(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "not-a-number",
      }),
    ).toBe(0);
    expect(
      resolveClaudeCodeMaxRateLimitRotations(undefined, {
        [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "-1",
      }),
    ).toBe(0);
  });
});
