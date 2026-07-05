import { execFile } from "node:child_process";

/**
 * Read-only pre-flight health check (caam-map.md §4c): before ever spawning
 * a shallow-spawned `claude`, verify the profile is healthy and fail closed
 * if it isn't. Never mutates anything and never execs the inner command.
 *
 * `caam shallow-profile doctor <profile> --json` — the original pre-flight
 * this module ran — was dropped from caam entirely; `shallow-profile` now
 * only has `create`/`delete`/`list`. The documented read-only replacement is
 * `caam shallow-spawn <profile> --print-env[--json]`: it runs the exact
 * same pre-exec profile-shape validation `shallow-spawn` would run before
 * exec'ing the inner command, but stops short of exec'ing anything, and
 * exits non-zero on a bad/missing profile.
 *
 * `--json` on `shallow-spawn --print-env` is itself a moving target across
 * caam builds — some reject it outright as an unknown flag — so this is
 * deliberately resilient to that drift rather than hardcoding one shape:
 *
 *  1. Try `--print-env --json`. If the output is the documented
 *     `{"success": true|false, ...}` JSON, trust it directly (this is a
 *     typed verdict, whichever way it comes out).
 *  2. If `--json` itself was rejected as an unknown flag (a cobra
 *     flag-parse failure, not a profile verdict — recognizable because it
 *     fails before any profile is even looked at), degrade to the
 *     plain-text `--print-env` contract that every caam build with
 *     `shallow-spawn` supports: exit 0 with env-assignment lines on stdout
 *     for a healthy profile, non-zero with nothing on stdout otherwise.
 *  3. Any other inability to conclusively verify health (unexpected output
 *     shape, the binary failing to run at all, a timeout, ...) throws
 *     `CaamShallowProfileDoctorError`.
 *
 * That error type is the entire contract with the caller: this function
 * only ever *resolves* when the profile has been positively verified
 * healthy. Every other outcome throws, and `tryActivateCaamShallowSpawn`
 * (sessionRunner.ts) already treats any thrown error here as "skip the caam
 * integration, fall back to direct `claude`" — never a hard user-facing
 * failure. Degrading gracefully here (rather than hard-failing on CLI
 * drift) just means that fallback stays a quiet, expected path instead of a
 * surprise.
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

interface CaamExecOutcome {
  /** Process exit code; only produced for invocations that actually ran (see execCaam). */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `caam <args>` and resolves with its exit code/stdout/stderr for any
 * outcome where the process actually ran to completion — including a
 * non-zero exit, which is an ordinary, inspectable CLI failure here (a bad
 * profile, an unrecognized flag, ...), not an exceptional one. Only rejects
 * when the binary never meaningfully ran at all (spawn failure such as
 * ENOENT, or a timeout): that can't be resolved by retrying with different
 * flags, so it's surfaced immediately as a doctor failure.
 */
function execCaam(
  exec: typeof execFile,
  caamExecutablePath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CaamExecOutcome> {
  return new Promise((resolve, reject) => {
    exec(
      caamExecutablePath,
      args as string[],
      { env, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (typeof code === "number") {
            resolve({ code, stdout, stderr });
            return;
          }
          reject(
            new CaamShallowProfileDoctorError(
              `caam ${args.join(" ")} failed to run: ${error.message}`,
              { stdout, stderr },
            ),
          );
          return;
        }
        resolve({ code: 0, stdout, stderr });
      },
    );
  });
}

interface ShallowSpawnJsonVerdict {
  success: boolean;
  error?: unknown;
  home?: unknown;
  shallow_profile?: unknown;
}

/**
 * Recognizes the documented `--print-env --json` shape
 * (`{"success": true|false, ...}`) and nothing else — any other JSON-looking
 * or non-JSON stdout is treated as "this build didn't give us a typed
 * verdict" rather than guessed at.
 */
function parseShallowSpawnJsonVerdict(stdout: string): ShallowSpawnJsonVerdict | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.success !== "boolean") {
    return undefined;
  }
  return record as unknown as ShallowSpawnJsonVerdict;
}

/**
 * An "unknown flag" rejection is a cobra flag-parse failure that happens
 * before caam ever looks at the profile — distinct from a profile-health
 * verdict. Recognizing it specifically is what lets this degrade to the
 * plain-text path instead of misreporting "this caam build predates
 * `--json`" as "the profile is unhealthy".
 */
function isUnknownJsonFlagRejection(stderr: string): boolean {
  return /unknown (flag|shorthand flag)/i.test(stderr) && /json/i.test(stderr);
}

/**
 * Validates that plain-text `--print-env` stdout actually matches the
 * documented contract — one `KEY=VALUE` env-assignment per non-blank line —
 * rather than being merely non-empty. A caam build that prints any other
 * informational text (a deprecation notice, help text, a garbled partial
 * output, ...) while still exiting 0 must NOT be read as a healthy verdict:
 * the same fail-closed discipline the JSON path applies to an unrecognized
 * `success` shape.
 */
function isEnvAssignmentOutput(stdout: string): boolean {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line));
}

export async function runCaamShallowProfileDoctor(
  caamExecutablePath: string,
  profile: string,
  options: CaamShallowProfileDoctorOptions = {},
): Promise<CaamShallowProfileDoctorResult> {
  const exec = options.execFileImpl ?? execFile;
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const jsonOutcome = await execCaam(
    exec,
    caamExecutablePath,
    ["shallow-spawn", profile, "--print-env", "--json"],
    env,
    timeout,
  );

  const verdict = parseShallowSpawnJsonVerdict(jsonOutcome.stdout);
  if (verdict) {
    // This caam build understands `--print-env --json` and gave us a typed
    // verdict directly — trust it over the raw exit code either way.
    if (verdict.success) {
      return { healthy: true, raw: verdict };
    }
    throw new CaamShallowProfileDoctorError(
      `caam shallow-spawn ${profile} --print-env reports the profile is unhealthy: ${
        typeof verdict.error === "string" ? verdict.error : JSON.stringify(verdict)
      }`,
      verdict,
    );
  }

  if (jsonOutcome.code === 0) {
    // Exited clean but didn't emit the documented JSON shape. An
    // unrecognized "success" shape isn't a verified pass — treat it as
    // inconclusive (fail closed) rather than assume healthy.
    throw new CaamShallowProfileDoctorError(
      `caam shallow-spawn ${profile} --print-env --json exited 0 but did not return the expected {"success": ...} JSON shape.`,
      { stdout: jsonOutcome.stdout },
    );
  }

  if (!isUnknownJsonFlagRejection(jsonOutcome.stderr)) {
    // A real non-zero exit, no parseable verdict JSON, and nothing
    // suggesting this was just an unsupported flag: treat it as a failed
    // verdict rather than CLI drift.
    throw new CaamShallowProfileDoctorError(
      `caam shallow-spawn ${profile} --print-env --json failed: ${
        jsonOutcome.stderr.trim() || `exit code ${jsonOutcome.code}`
      }`,
      { stdout: jsonOutcome.stdout, stderr: jsonOutcome.stderr },
    );
  }

  // CLI drift: this caam build's `shallow-spawn` doesn't recognize `--json`
  // at all (cobra rejected it before any profile was even looked at).
  // Degrade to the plain-text `--print-env` contract, which every caam
  // build with `shallow-spawn` supports: exit 0 with env-assignment lines
  // on stdout for a healthy profile, non-zero with nothing on stdout
  // otherwise.
  const plainOutcome = await execCaam(
    exec,
    caamExecutablePath,
    ["shallow-spawn", profile, "--print-env"],
    env,
    timeout,
  );

  if (plainOutcome.code === 0 && plainOutcome.stdout.trim().length > 0) {
    if (isEnvAssignmentOutput(plainOutcome.stdout)) {
      return { healthy: true, raw: { plainTextOutput: plainOutcome.stdout } };
    }
    // Exited 0 with output, but not the documented env-assignment shape.
    // An unrecognized shape isn't a verified pass — fail closed, same as
    // the JSON path does for an unrecognized "success" shape.
    throw new CaamShallowProfileDoctorError(
      `caam shallow-spawn ${profile} --print-env exited 0 but its stdout does not match the expected KEY=VALUE env-assignment output.`,
      { stdout: plainOutcome.stdout, stderr: plainOutcome.stderr },
    );
  }

  throw new CaamShallowProfileDoctorError(
    `caam shallow-spawn ${profile} --print-env reports profile ${JSON.stringify(profile)} is unhealthy: ${
      plainOutcome.stderr.trim() || "no output on exit code " + plainOutcome.code
    }`,
    { stdout: plainOutcome.stdout, stderr: plainOutcome.stderr },
  );
}
