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

function fakeExecFile(
  handler: (file: string, args: readonly string[]) => { stdout: string; stderr?: string; error?: Error },
): typeof execFile {
  return ((file: string, args: readonly string[], _options: unknown, callback: ExecFileCallback) => {
    const result = handler(file, args);
    if (result.error) {
      callback(result.error, result.stdout, result.stderr ?? "");
    } else {
      callback(null, result.stdout, result.stderr ?? "");
    }
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile;
}

describe("caam shallow-profile doctor pre-flight (caam-map.md §4c)", () => {
  test("invokes `caam shallow-profile doctor <profile> --json` and passes on a healthy profile", async () => {
    let capturedArgs: readonly string[] | undefined;
    const execFileImpl = fakeExecFile((file, args) => {
      capturedArgs = args;
      expect(file).toBe("/opt/caam");
      return { stdout: JSON.stringify({ healthy: true, profile: "arthur" }) };
    });

    const result = await runCaamShallowProfileDoctor("/opt/caam", "arthur", { execFileImpl });

    expect(capturedArgs).toEqual(["shallow-profile", "doctor", "arthur", "--json"]);
    expect(result.healthy).toBe(true);
  });

  test("fails closed with a clear error when the profile is reported unhealthy", async () => {
    const execFileImpl = fakeExecFile(() => ({
      stdout: JSON.stringify({ healthy: false, reason: "credentials_missing" }),
    }));

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "broken-profile", { execFileImpl }),
    ).rejects.toThrow(CaamShallowProfileDoctorError);
    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "broken-profile", { execFileImpl }),
    ).rejects.toThrow(/unhealthy/);
  });

  test("fails closed when the doctor command itself fails to run", async () => {
    const execFileImpl = fakeExecFile(() => ({
      stdout: "",
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    }));

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "arthur", { execFileImpl }),
    ).rejects.toThrow(CaamShallowProfileDoctorError);
  });

  test("fails closed when the doctor output is not valid JSON", async () => {
    const execFileImpl = fakeExecFile(() => ({ stdout: "not json" }));

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "arthur", { execFileImpl }),
    ).rejects.toThrow(/did not return valid JSON/);
  });

  test("accepts an `ok` boolean as an alternate healthy-signal shape", async () => {
    const execFileImpl = fakeExecFile(() => ({ stdout: JSON.stringify({ ok: true }) }));

    await expect(
      runCaamShallowProfileDoctor("/opt/caam", "arthur", { execFileImpl }),
    ).resolves.toMatchObject({ healthy: true });
  });
});
