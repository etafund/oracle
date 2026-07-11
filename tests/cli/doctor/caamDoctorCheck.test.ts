import { describe, expect, test } from "vitest";
import type { execFile } from "node:child_process";

import { runCaamDoctorCheck } from "../../../src/cli/commands/doctor/caam.js";
import { ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR } from "../../../src/claude-code/caamCommand.js";
import { CaamExecutableError } from "../../../src/claude-code/caamResolver.js";

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

function fakeResolveCaamExecutable(path = "/opt/caam") {
  return async () => ({ path, requested: path, mode: 0o755 });
}

describe("runCaamDoctorCheck (oracle doctor caam health/cooldown visibility)", () => {
  test("returns undefined (no behavior change) when ORACLE_CLAUDE_CODE_CAAM_PROFILE is not configured", async () => {
    const { impl, calls } = fakeExecFileSequence([{ stdout: "" }]);

    const result = await runCaamDoctorCheck({
      env: {},
      execFileImpl: impl,
      resolveCaamExecutableImpl: fakeResolveCaamExecutable(),
    });

    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("reports a healthy, non-cooling profile as pass", async () => {
    const { impl, calls } = fakeExecFileSequence([
      {
        stdout: JSON.stringify({
          success: true,
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
                ],
              },
            ],
            summary: {
              total_profiles: 1,
              active_profiles: 1,
              healthy_profiles: 1,
              cooldown_profiles: 0,
              expiring_soon: 0,
              all_profiles_blocked: false,
            },
          },
        }),
      },
    ]);

    const result = await runCaamDoctorCheck({
      env: { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta" },
      execFileImpl: impl,
      resolveCaamExecutableImpl: fakeResolveCaamExecutable(),
    });

    expect(calls).toEqual([["/opt/caam", "robot", "status", "claude"]]);
    expect(result).toMatchObject({ component: "caam", status: "pass", code: "caam_profile_healthy" });
  });

  test("surfaces an active cooldown as a warn with remaining time in the message", async () => {
    const { impl } = fakeExecFileSequence([
      {
        stdout: JSON.stringify({
          success: true,
          data: {
            providers: [
              {
                id: "claude",
                profiles: [
                  {
                    name: "beta",
                    active: true,
                    health: { status: "healthy" },
                    cooldown: {
                      active: true,
                      remaining_str: "4m30s",
                      reason: "429 rate_limit",
                    },
                  },
                ],
              },
            ],
            summary: {
              total_profiles: 1,
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

    const result = await runCaamDoctorCheck({
      env: { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta" },
      execFileImpl: impl,
      resolveCaamExecutableImpl: fakeResolveCaamExecutable(),
    });

    expect(result?.status).toBe("warn");
    expect(result?.code).toBe("caam_profile_cooling_down");
    expect(result?.message).toContain("4m30s");
    expect(result?.message).toContain("429 rate_limit");
  });

  test("surfaces an unhealthy (non-cooling) profile with its last-error reason", async () => {
    const { impl } = fakeExecFileSequence([
      {
        stdout: JSON.stringify({
          success: true,
          data: {
            providers: [
              {
                id: "claude",
                profiles: [
                  {
                    name: "beta",
                    active: true,
                    health: { status: "critical", reason: "token expired", error_count_1h: 3 },
                    cooldown: { active: false },
                  },
                ],
              },
            ],
            summary: {
              total_profiles: 1,
              active_profiles: 1,
              healthy_profiles: 0,
              cooldown_profiles: 0,
              expiring_soon: 0,
              all_profiles_blocked: false,
            },
          },
        }),
      },
    ]);

    const result = await runCaamDoctorCheck({
      env: { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta" },
      execFileImpl: impl,
      resolveCaamExecutableImpl: fakeResolveCaamExecutable(),
    });

    expect(result?.code).toBe("caam_profile_unhealthy");
    expect(result?.message).toContain("token expired");
    expect(result?.status).not.toBe("fail");
  });

  test("warns when the configured profile is absent from `caam robot status` output", async () => {
    const { impl } = fakeExecFileSequence([
      {
        stdout: JSON.stringify({
          success: true,
          data: {
            providers: [{ id: "claude", profiles: [] }],
            summary: {
              total_profiles: 0,
              active_profiles: 0,
              healthy_profiles: 0,
              cooldown_profiles: 0,
              expiring_soon: 0,
              all_profiles_blocked: false,
            },
          },
        }),
      },
    ]);

    const result = await runCaamDoctorCheck({
      env: { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta" },
      execFileImpl: impl,
      resolveCaamExecutableImpl: fakeResolveCaamExecutable(),
    });

    expect(result?.status).toBe("warn");
    expect(result?.code).toBe("caam_profile_not_found");
  });

  test("degrades to warn (never fail) when caam robot status reports a structured error", async () => {
    const { impl } = fakeExecFileSequence([
      {
        exitCode: 1,
        stdout: JSON.stringify({
          success: false,
          error: { code: "PROVIDER_NOT_CONFIGURED", message: "claude is not configured" },
        }),
      },
    ]);

    const result = await runCaamDoctorCheck({
      env: { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta" },
      execFileImpl: impl,
      resolveCaamExecutableImpl: fakeResolveCaamExecutable(),
    });

    expect(result?.status).toBe("warn");
    expect(result?.code).toBe("caam_robot_status_error");
    expect(result?.status).not.toBe("fail");
  });

  test("degrades to unknown (never fail) on caam CLI version skew / unparseable output", async () => {
    const { impl } = fakeExecFileSequence([{ exitCode: 1, stdout: "", stderr: "unknown command" }]);

    const result = await runCaamDoctorCheck({
      env: { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta" },
      execFileImpl: impl,
      resolveCaamExecutableImpl: fakeResolveCaamExecutable(),
    });

    expect(result?.status).toBe("unknown");
    expect(result?.code).toBe("caam_robot_status_unavailable");
  });

  test("degrades to warn (never fail) when the caam executable itself cannot be resolved", async () => {
    const result = await runCaamDoctorCheck({
      env: { [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta" },
      resolveCaamExecutableImpl: async () => {
        throw new CaamExecutableError("not_found");
      },
    });

    expect(result?.status).toBe("warn");
    expect(result?.code).toBe("caam_executable_unresolved");
  });
});
