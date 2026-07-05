import type { ClaudeCodeCommand } from "./command.js";

/**
 * `caam shallow-spawn` outer-command builder (caam-map.md §4a). This wraps
 * the EXISTING `buildClaudeCodeCommand()` argv unchanged as the tail of:
 *
 *   caam shallow-spawn <profile> --base <oracleHome>/claude-code-shallow-homes -- <resolved-claude> <inner argv...>
 *
 * `command.ts`'s own dangerous-flag / raw-passthrough rejection continues to
 * run against the INNER claude argv before it ever reaches this builder —
 * this module only prepends the caam wrapper, it never edits the inner argv.
 */

/** Opt-in knob: the caam path activates ONLY when a profile is configured here. */
export const ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR = "ORACLE_CLAUDE_CODE_CAAM_PROFILE";

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
  const configured = configuredProfile?.trim();
  if (configured) {
    return configured;
  }
  const fromEnv = env[ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]?.trim();
  return fromEnv || undefined;
}

export interface BuildCaamShallowSpawnCommandOptions {
  /** Resolved, hardened absolute path to the `caam` binary. */
  caamExecutable: string;
  profile: string;
  /** `<oracleHome>/claude-code-shallow-homes` per caam-map.md §4a. */
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
      options.base,
      "--",
      options.inner.file,
      ...options.inner.args,
    ],
    spawnOptions: options.inner.spawnOptions,
  };
}
