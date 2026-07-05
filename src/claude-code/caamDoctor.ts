import { execFile } from "node:child_process";

/**
 * Read-only pre-flight health check (caam-map.md §4c): before ever spawning
 * a shallow-spawned `claude`, run `caam shallow-profile doctor <profile>
 * --json` and fail closed if it reports the profile unhealthy. Never
 * mutates anything — `shallow-profile doctor` is documented as read-only.
 */

export interface CaamShallowProfileDoctorOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injectable for tests; defaults to `node:child_process`'s `execFile`. */
  execFileImpl?: typeof execFile;
}

export interface CaamShallowProfileDoctorResult {
  healthy: true;
  raw: unknown;
}

export class CaamShallowProfileDoctorError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "CaamShallowProfileDoctorError";
    this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runCaamShallowProfileDoctor(
  caamExecutablePath: string,
  profile: string,
  options: CaamShallowProfileDoctorOptions = {},
): Promise<CaamShallowProfileDoctorResult> {
  const exec = options.execFileImpl ?? execFile;
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(
      caamExecutablePath,
      ["shallow-profile", "doctor", profile, "--json"],
      { env, timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new CaamShallowProfileDoctorError(
              `caam shallow-profile doctor ${profile} failed to run: ${error.message}`,
              { stdout, stderr },
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CaamShallowProfileDoctorError(
      `caam shallow-profile doctor ${profile} did not return valid JSON output.`,
      { stdout },
    );
  }

  if (!isHealthy(parsed)) {
    throw new CaamShallowProfileDoctorError(
      `caam shallow-profile doctor reports profile ${JSON.stringify(profile)} is unhealthy.`,
      parsed,
    );
  }

  return { healthy: true, raw: parsed };
}

function isHealthy(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.healthy === "boolean") {
    return record.healthy;
  }
  if (typeof record.ok === "boolean") {
    return record.ok;
  }
  return false;
}
