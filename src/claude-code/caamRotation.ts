import { execFile } from "node:child_process";

/**
 * The two mutating/observing `caam` shell-outs behind rate-limit rotation
 * (caam-ratelimit-rotation-design.md §2.1, §4.3). Mirrors
 * `caamDoctor.ts`'s own DI pattern (`execFileImpl`) so these can be
 * unit-tested without a real subprocess.
 *
 * Both commands were re-verified against the installed caam
 * `v0.1.11-48-ga85cf37-dirty` build (design doc §2.1, Appendix):
 *
 *  - `caam cooldown set claude/<profile> --minutes N --notes TEXT`
 *    (`cmd/caam/cmd/cooldown.go:35-83`): no `--json` flag exists on `set`
 *    (only `cooldown list` has one) — success prints plain text and exits
 *    0; failure is a non-zero exit via cobra's error path. Control flow is
 *    keyed on exit code ONLY, never on parsing stdout text.
 *  - `caam robot next <provider> --strategy smart` (`cmd/caam/cmd/robot.go:
 *    789-965`), deliberately WITHOUT `--include-cooldown` — its absence is
 *    exactly what makes this call skip the profile that was just cooled
 *    down (robot.go:843-846). Output is always a single JSON object on
 *    stdout, success or failure; only the first parseable JSON object is
 *    trusted (some builds append a duplicate human-readable `Error: CODE:
 *    message` + cobra usage text after it on failure, also on stdout).
 *  - `caam robot status <provider>` (`cmd/caam/cmd/robot.go:275-291,
 *    runRobotStatus ~L378-450`): read-only, part of the same always-JSON
 *    "Robot Mode" surface as `robot next` (robot.go's own doc comment:
 *    "Designed for coding agents... All output is JSON."), so it shares the
 *    same version-stability posture — unlike `shallow-profile doctor`
 *    (caamDoctor.ts), which was dropped from caam entirely. Returns
 *    per-profile `RobotHealthInfo` (status/reason/expires_at/expires_in) and
 *    `RobotCooldown` (active/remaining_ms/remaining_str/reason). Parsed with
 *    the same leading-JSON-object tolerance as `robot next`.
 */

/** Opt-in knob: caps how many EXTRA profiles rotation will try (design §3.3). */
export const ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR =
  "ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS";

const DEFAULT_MAX_RATE_LIMIT_ROTATIONS = 2;

/**
 * Resolves the rotation cap, preferring an explicit programmatic override
 * (`runOptions.claudeCode.maxRateLimitRotations`) over the
 * `ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS` env var, same precedence
 * pattern as `resolveClaudeCodeCaamProfile` (`caamCommand.ts`). Falls back
 * to a small positive default (2) when neither is a valid non-negative
 * integer. Callers only invoke this when caam is already active for the
 * original attempt — an absent/invalid value here never re-enables
 * rotation on its own.
 */
export function resolveClaudeCodeMaxRateLimitRotations(
  configured: number | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 0) {
    return configured;
  }
  const fromEnv = env[ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR];
  if (fromEnv !== undefined) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_RATE_LIMIT_ROTATIONS;
}

export class CaamRotationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CaamRotationError";
    this.code = code;
  }
}

export interface CaamRotationExecOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injectable for tests; defaults to `node:child_process`'s `execFile`. */
  execFileImpl?: typeof execFile;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface CaamExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `caam <args>` and resolves with its exit code/stdout/stderr for any
 * outcome where the process actually ran to completion (including a
 * non-zero exit — an ordinary, inspectable CLI failure here). Only rejects
 * when the binary never meaningfully ran at all (spawn failure, timeout).
 */
function execCaamRotation(
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
            new CaamRotationError(
              "exec_failed",
              `caam ${args.join(" ")} failed to run: ${error.message}`,
            ),
          );
          return;
        }
        resolve({ code: 0, stdout, stderr });
      },
    );
  });
}

/**
 * `caam cooldown set <provider>/<profile> --minutes N --notes TEXT`
 * (design §2.1). Throws `CaamRotationError` on a non-zero exit — callers
 * MUST treat this as non-fatal (log a warning, proceed to `robot next`
 * regardless): a cooldown-write failure must never itself abort rotation
 * (design §2.2 step 4).
 */
export async function runCaamCooldownSet(
  caamExecutablePath: string,
  provider: string,
  profile: string,
  minutes: number,
  notes: string,
  options: CaamRotationExecOptions = {},
): Promise<void> {
  const exec = options.execFileImpl ?? execFile;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outcome = await execCaamRotation(
    exec,
    caamExecutablePath,
    ["cooldown", "set", `${provider}/${profile}`, "--minutes", String(minutes), "--notes", notes],
    env,
    timeoutMs,
  );
  if (outcome.code !== 0) {
    throw new CaamRotationError(
      "cooldown_set_failed",
      `caam cooldown set ${provider}/${profile} exited ${outcome.code}: ${
        outcome.stderr.trim() || outcome.stdout.trim() || "no output"
      }`,
    );
  }
}

export interface CaamRobotNextSuccess {
  success: true;
  profile: string;
  raw: unknown;
}

export interface CaamRobotNextFailure {
  success: false;
  /** e.g. `NO_PROFILES`, `ALL_BLOCKED`, or `UNKNOWN` if the envelope had none. */
  code: string;
  message: string;
  raw: unknown;
}

export type CaamRobotNextOutcome = CaamRobotNextSuccess | CaamRobotNextFailure;

/**
 * `caam robot next <provider> --strategy smart` (design §2.1). NEVER passes
 * `--include-cooldown` — omitting it is what makes the call skip a
 * profile currently on cooldown (robot.go:843-846), which is exactly the
 * "respect cooldowns, never re-select a cooling profile" behavior this
 * feature depends on.
 *
 * Throws `CaamRotationError` only when the process itself failed to
 * produce any parseable leading JSON object (spawn failure, garbage
 * stdout). A well-formed `{"success": false, ...}` envelope (e.g.
 * `NO_PROFILES`/`ALL_BLOCKED`) is a normal, expected outcome and is
 * returned, not thrown — callers should treat it as rotation exhaustion.
 */
export async function runCaamRobotNext(
  caamExecutablePath: string,
  provider: string,
  options: CaamRotationExecOptions & { strategy?: "smart" | "lru" | "random" } = {},
): Promise<CaamRobotNextOutcome> {
  const exec = options.execFileImpl ?? execFile;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const strategy = options.strategy ?? "smart";
  const outcome = await execCaamRotation(
    exec,
    caamExecutablePath,
    ["robot", "next", provider, "--strategy", strategy],
    env,
    timeoutMs,
  );
  const parsed = parseLeadingJsonObject(outcome.stdout);
  if (parsed === undefined) {
    throw new CaamRotationError(
      "robot_next_unparseable",
      `caam robot next ${provider} --strategy ${strategy} did not return parseable JSON on stdout (exit ${outcome.code}): ${
        outcome.stderr.trim() || outcome.stdout.trim() || "no output"
      }`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.success === true) {
    const data = record.data as Record<string, unknown> | undefined;
    const profile = typeof data?.profile === "string" ? data.profile : undefined;
    if (!profile) {
      throw new CaamRotationError(
        "robot_next_missing_profile",
        `caam robot next ${provider} --strategy ${strategy} reported success but data.profile was missing/not a string.`,
      );
    }
    return { success: true, profile, raw: parsed };
  }
  const errorField = record.error as Record<string, unknown> | undefined;
  const code = typeof errorField?.code === "string" ? errorField.code : "UNKNOWN";
  const message =
    typeof errorField?.message === "string" ? errorField.message : JSON.stringify(parsed);
  return { success: false, code, message, raw: parsed };
}

export interface CaamRobotHealthInfo {
  status: string;
  reason?: string;
  expires_at?: string;
  expires_in?: string;
  error_count_1h?: number;
}

export interface CaamRobotCooldownInfo {
  active: boolean;
  until?: string;
  remaining_ms?: number;
  remaining_str?: string;
  reason?: string;
}

export interface CaamRobotProfileInfo {
  name: string;
  active: boolean;
  system?: boolean;
  email?: string;
  plan_type?: string;
  health: CaamRobotHealthInfo;
  cooldown?: CaamRobotCooldownInfo;
  recommendation?: string;
}

export interface CaamRobotProviderInfo {
  id: string;
  display_name?: string;
  logged_in?: boolean;
  active_profile?: string;
  profiles: CaamRobotProfileInfo[];
}

export interface CaamRobotStatusSummary {
  total_profiles: number;
  active_profiles: number;
  healthy_profiles: number;
  cooldown_profiles: number;
  expiring_soon: number;
  all_profiles_blocked: boolean;
}

export interface CaamRobotStatusData {
  version?: string;
  providers: CaamRobotProviderInfo[];
  summary: CaamRobotStatusSummary;
}

export interface CaamRobotStatusSuccess {
  success: true;
  data: CaamRobotStatusData;
  raw: unknown;
}

export interface CaamRobotStatusFailure {
  success: false;
  code: string;
  message: string;
  raw: unknown;
}

export type CaamRobotStatusOutcome = CaamRobotStatusSuccess | CaamRobotStatusFailure;

/**
 * `caam robot status <provider>` (design note above). Read-only — never
 * mutates any caam state. Throws `CaamRotationError` only when the process
 * itself failed to produce any parseable leading JSON object (spawn
 * failure, garbage stdout, unrecognized version's output shape entirely);
 * callers (doctor surfaces) should treat that as "caam health is
 * unavailable/unknown", never as a hard failure of the caller itself.
 */
export async function runCaamRobotStatus(
  caamExecutablePath: string,
  provider: string,
  options: CaamRotationExecOptions = {},
): Promise<CaamRobotStatusOutcome> {
  const exec = options.execFileImpl ?? execFile;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outcome = await execCaamRotation(
    exec,
    caamExecutablePath,
    ["robot", "status", provider],
    env,
    timeoutMs,
  );
  const parsed = parseLeadingJsonObject(outcome.stdout);
  if (parsed === undefined) {
    throw new CaamRotationError(
      "robot_status_unparseable",
      `caam robot status ${provider} did not return parseable JSON on stdout (exit ${outcome.code}): ${
        outcome.stderr.trim() || outcome.stdout.trim() || "no output"
      }`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.success === true) {
    const data = record.data as CaamRobotStatusData | undefined;
    if (!data || !Array.isArray(data.providers)) {
      throw new CaamRotationError(
        "robot_status_missing_data",
        `caam robot status ${provider} reported success but data.providers was missing/not an array.`,
      );
    }
    return { success: true, data, raw: parsed };
  }
  const errorField = record.error as Record<string, unknown> | undefined;
  const code = typeof errorField?.code === "string" ? errorField.code : "UNKNOWN";
  const message =
    typeof errorField?.message === "string" ? errorField.message : JSON.stringify(parsed);
  return { success: false, code, message, raw: parsed };
}

/**
 * Only trusts the FIRST top-level JSON object on stdout (design §2.1) —
 * some builds append a duplicate human-readable `Error: CODE: message` +
 * cobra usage text after it on failure, also on stdout. Returns `undefined`
 * when no parseable leading object is found.
 */
function parseLeadingJsonObject(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed[0] !== "{") {
    return undefined;
  }
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const ch = trimmed[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed.slice(0, end + 1));
  } catch {
    return undefined;
  }
}
