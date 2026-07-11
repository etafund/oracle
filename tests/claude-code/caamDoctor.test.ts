import { describe, expect, test } from "vitest";
import type { execFile } from "node:child_process";

import {
  CaamShallowProfileDoctorError,
  runCaamShallowProfileDoctor,
} from "../../src/claude-code/caamDoctor.js";

type ExecFileCallback = (
  error: (Error & { code?: number | string }) | null,
  stdout: string,
  stderr: string,
) => void;

interface FakeResponse {
  stdout?: string;
  stderr?: string;
  /** Exit code for a "the process ran but failed" outcome (mutually exclusive with `spawnError`). */
  exitCode?: number;
  /** A spawn-level failure (e.g. ENOENT) — the process never ran at all. */
  spawnError?: Error & { code?: string };
}

/**
 * Fake `execFile` that serves canned responses in call order and records
 * every invocation's argv, so tests can assert both what got called and
 * (for the CLI-drift path) that a second, different call happened.
 */
function fakeExecFileSequence(responses: FakeResponse[]): { impl: typeof execFile; calls: string[][] } {
  const calls: string[][] = [];
  let callIndex = 0;
  const impl = ((file: string, args: readonly string[], _options: unknown, callback: ExecFileCallback) => {
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

const UNKNOWN_JSON_FLAG_STDERR =
  'Error: unknown flag: --json\nUsage:\n  caam shallow-spawn <name> -- <cmd> [args...] [flags]\n';

describe("caam shallow-spawn --print-env pre-flight (caam-map.md §4c)", () => {
  test("modern caam: invokes `shallow-spawn <profile> --print-env --json` and passes on a healthy profile", async () => {
    const { impl, calls } = fakeExecFileSequence([
      {
        stdout: JSON.stringify({ success: true, home: "/orch-homes/beta", shallow_profile: "beta" }),
      },
    ]);

    const result = await runCaamShallowProfileDoctor("/opt/caam", "beta", { execFileImpl: impl });

    expect(calls).toEqual([["/opt/caam", "shallow-spawn", "beta", "--print-env", "--json"]]);
    expect(result.healthy).toBe(true);
  });

  test("modern caam: fails closed with a clear error when the JSON verdict reports the profile unhealthy", async () => {
    const { impl } = fakeExecFileSequence([
      {
        exitCode: 1,
        stdout: JSON.stringify({
          success: false,
          error: 'shallow profile "broken-profile" does not exist (try `caam shallow-profile create broken-profile`)',
        }),
      },
    ]);

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "broken-profile", { execFileImpl: impl }),
    ).rejects.toThrow(CaamShallowProfileDoctorError);
    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "broken-profile", { execFileImpl: impl }),
    ).rejects.toThrow(/unhealthy/);
  });

  test("CLI drift: degrades to plain-text `--print-env` when `--json` is an unknown flag, and passes on a healthy profile", async () => {
    const { impl, calls } = fakeExecFileSequence([
      { exitCode: 1, stdout: "", stderr: UNKNOWN_JSON_FLAG_STDERR },
      { stdout: "HOME=/orch-homes/beta\nSHALLOW_PROFILE=beta\n" },
    ]);

    const result = await runCaamShallowProfileDoctor("/opt/caam", "beta", { execFileImpl: impl });

    expect(calls).toEqual([
      ["/opt/caam", "shallow-spawn", "beta", "--print-env", "--json"],
      ["/opt/caam", "shallow-spawn", "beta", "--print-env"],
    ]);
    expect(result.healthy).toBe(true);
  });

  test("CLI drift: degrades to plain-text `--print-env` and fails closed when the profile is unhealthy there too", async () => {
    const { impl, calls } = fakeExecFileSequence([
      { exitCode: 1, stdout: "", stderr: UNKNOWN_JSON_FLAG_STDERR },
      {
        exitCode: 1,
        stdout: "",
        stderr: 'Error: shallow profile "broken-profile" does not exist (try `caam shallow-profile create broken-profile`)\n',
      },
    ]);

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "broken-profile", { execFileImpl: impl }),
    ).rejects.toThrow(CaamShallowProfileDoctorError);
    expect(calls).toHaveLength(2);
  });

  test("CLI drift: fails closed (not assumed healthy) when plain-text `--print-env` exits 0 with non-env-assignment stdout", async () => {
    const { impl, calls } = fakeExecFileSequence([
      { exitCode: 1, stdout: "", stderr: UNKNOWN_JSON_FLAG_STDERR },
      // Exit 0 with non-empty stdout, but it's an informational notice, not
      // the documented KEY=VALUE env-assignment output.
      { stdout: "warning: shallow-spawn is deprecated; see caam docs\n" },
    ]);

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "beta", { execFileImpl: impl }),
    ).rejects.toThrow(/does not match the expected KEY=VALUE/);
    expect(calls).toHaveLength(2);
  });

  test("CLI drift: fails closed when plain-text stdout mixes env assignments with unexpected non-assignment lines", async () => {
    const { impl } = fakeExecFileSequence([
      { exitCode: 1, stdout: "", stderr: UNKNOWN_JSON_FLAG_STDERR },
      { stdout: "note: profile schema will change in v3\nHOME=/orch-homes/beta\nSHALLOW_PROFILE=beta\n" },
    ]);

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "beta", { execFileImpl: impl }),
    ).rejects.toThrow(CaamShallowProfileDoctorError);
  });

  test("fails closed when the command itself fails to run (binary missing / ENOENT) — no retry", async () => {
    const { impl, calls } = fakeExecFileSequence([
      { spawnError: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) },
    ]);

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "beta", { execFileImpl: impl }),
    ).rejects.toThrow(CaamShallowProfileDoctorError);
    // A spawn-level failure can't be fixed by retrying with different flags.
    expect(calls).toHaveLength(1);
  });

  test("fails closed (inconclusive, not assumed healthy) when `--json` exits 0 without the documented JSON shape", async () => {
    const { impl } = fakeExecFileSequence([{ stdout: "not json" }]);

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "beta", { execFileImpl: impl }),
    ).rejects.toThrow(/did not return the expected/);
  });

  test("fails closed when `--json` fails non-zero for a reason other than an unknown flag (no silent retry-as-healthy)", async () => {
    const { impl, calls } = fakeExecFileSequence([
      { exitCode: 1, stdout: "", stderr: "Error: something else entirely went wrong\n" },
    ]);

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "beta", { execFileImpl: impl }),
    ).rejects.toThrow(CaamShallowProfileDoctorError);
    expect(calls).toHaveLength(1);
  });
});
