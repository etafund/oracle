import path from "node:path";
import type { ClaudeCodeCommand } from "./command.js";

/**
 * `caam shallow-spawn` outer-command builder (caam-map.md §4a). This wraps
 * the EXISTING `buildClaudeCodeCommand()` argv unchanged as the tail of:
 *
 *   caam shallow-spawn <profile> --base <resolved-shallow-homes> -- <resolved-claude> <inner argv...>
 *
 * `command.ts`'s own dangerous-flag / raw-passthrough rejection continues to
 * run against the INNER claude argv before it ever reaches this builder —
 * this module only prepends the caam wrapper, it never edits the inner argv.
 */

/** Opt-in knob: the caam path activates ONLY when a profile is configured here. */
export const ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR = "ORACLE_CLAUDE_CODE_CAAM_PROFILE";
/** Oracle-specific override for caam's shallow-profile base directory. */
export const ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR = "ORACLE_CLAUDE_CODE_CAAM_BASE";
/** Native caam override for the same shallow-profile base directory. */
export const CAAM_SHALLOW_HOMES_DIR_ENV_VAR = "CAAM_SHALLOW_HOMES_DIR";

const CAAM_PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class CaamCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CaamCommandError";
    this.code = code;
  }
}

/**
 * Validates a caam shallow profile name before it is used as an argv value
 * AND before it is embedded in the per-profile single-flight lock filename
 * (`claude-code-subscription-<profile>.lock`, caam-map.md §4b). The lock
 * filename is built with `path.join`, so a profile name containing `/` or
 * `..` must be rejected here rather than only relying on `execFile`'s
 * argv-not-shell safety.
 */
export function validateCaamProfileName(profile: string): string {
  const trimmed = profile.trim();
  if (!CAAM_PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new CaamCommandError(
      "invalid_caam_profile_name",
      `caam shallow-spawn profile name ${JSON.stringify(profile)} is not a safe identifier (expected to match ${CAAM_PROFILE_NAME_PATTERN}).`,
    );
  }
  return trimmed;
}

/**
 * Resolves the configured caam profile name (the opt-in knob), preferring an
 * explicit programmatic override (`runOptions.claudeCode.caamProfile`, the
 * "config key" form) over `ORACLE_CLAUDE_CODE_CAAM_PROFILE` (the "env"
 * form). Returns `undefined` when neither is set — the caller must then take
 * today's exact direct-claude fallback path.
 */
export function resolveClaudeCodeCaamProfile(
  configuredProfile: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (configuredProfile !== undefined) {
    const configured = configuredProfile.trim();
    if (!configured) {
      throw new CaamCommandError(
        "invalid_caam_profile_name",
        `An explicitly configured caam shallow-spawn profile cannot be empty. Pass --caam-profile <name> with a safe identifier or omit the option entirely.`,
      );
    }
    return validateCaamProfileName(configured);
  }
  const fromEnv = env[ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]?.trim();
  return fromEnv ? validateCaamProfileName(fromEnv) : undefined;
}

export type ClaudeCodeCaamBaseSource =
  | "config"
  | "oracle_env"
  | "caam_env"
  | "shallow_home_parent"
  | "home_default";

export interface ClaudeCodeCaamBaseResolution {
  base: string;
  source: ClaudeCodeCaamBaseSource;
}

/**
 * Resolve the exact base passed to BOTH `shallow-spawn --print-env` and the
 * eventual `shallow-spawn -- <command>` call. caam normally defaults to
 * `$HOME/orch-homes`; when Oracle itself is already running inside a shallow
 * HOME that would incorrectly become `<base>/<current-profile>/orch-homes`.
 * Prefer explicit overrides, then caam's native env, and finally recognize
 * the documented `<base>/<profile>` shallow-HOME layout.
 */
export function resolveClaudeCodeCaamBase(
  configuredBase: string | undefined,
  env: NodeJS.ProcessEnv,
): ClaudeCodeCaamBaseResolution {
  if (configuredBase !== undefined) {
    return { base: validateCaamBasePath(configuredBase), source: "config" };
  }

  const oracleEnv = env[ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR]?.trim();
  if (oracleEnv) {
    return { base: validateCaamBasePath(oracleEnv), source: "oracle_env" };
  }

  const caamEnv = env[CAAM_SHALLOW_HOMES_DIR_ENV_VAR]?.trim();
  if (caamEnv) {
    return { base: validateCaamBasePath(caamEnv), source: "caam_env" };
  }

  const home = env.HOME?.trim();
  if (!home) {
    throw new CaamCommandError(
      "caam_base_unresolved",
      `Cannot resolve the caam shallow-profile base because HOME is unset. Pass --caam-base <absolute-path> or set ${ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR}.`,
    );
  }
  const validatedHome = validateCaamBasePath(home);
  const parent = path.dirname(validatedHome);
  const currentProfile = env.SHALLOW_PROFILE?.trim();
  if (
    (currentProfile && path.basename(validatedHome) === currentProfile) ||
    path.basename(parent) === "orch-homes"
  ) {
    return { base: parent, source: "shallow_home_parent" };
  }
  return {
    base: path.join(validatedHome, "orch-homes"),
    source: "home_default",
  };
}

export function validateCaamBasePath(base: string): string {
  const trimmed = base.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || trimmed.includes("\0")) {
    throw new CaamCommandError(
      "invalid_caam_base_path",
      `caam shallow-profile base ${JSON.stringify(base)} must be an absolute path. Pass --caam-base <absolute-path> or set ${ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR}.`,
    );
  }
  // `path.normalize()` preserves a trailing separator on some platforms;
  // `path.resolve()` gives profile/base identity comparisons one canonical
  // lexical form while preserving the already-proven absolute root.
  return path.resolve(trimmed);
}

export interface BuildCaamShallowSpawnCommandOptions {
  /** Resolved, hardened absolute path to the `caam` binary. */
  caamExecutable: string;
  profile: string;
  /** Exact shallow-profile base used by the matching read-only doctor probe. */
  base: string;
  /** The EXISTING, unmodified `buildClaudeCodeCommand()` output. */
  inner: ClaudeCodeCommand;
}

export function buildCaamShallowSpawnCommand(
  options: BuildCaamShallowSpawnCommandOptions,
): ClaudeCodeCommand {
  const profile = validateCaamProfileName(options.profile);
  return {
    file: options.caamExecutable,
    args: [
      "shallow-spawn",
      profile,
      "--base",
      validateCaamBasePath(options.base),
      "--",
      options.inner.file,
      ...options.inner.args,
    ],
    spawnOptions: options.inner.spawnOptions,
  };
}
