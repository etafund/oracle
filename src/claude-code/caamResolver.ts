import {
  resolveHardenedExecutable,
  type ResolvedClaudeExecutable,
  type ResolveHardenedExecutableOptions,
} from "./executableResolver.js";

/**
 * Resolves the `caam` (Coding Agent Account Manager) binary that fronts the
 * `caam shallow-spawn` multi-account-parallelism path (caam-map.md §4a).
 * Deliberately reuses `resolveHardenedExecutable` — the exact same
 * symlink-chain / world-writable / ownership / inside-reviewed-repo
 * hardening already applied to the `claude` executable — because `caam` is
 * just as security-relevant a binary: it is about to `exec` into a
 * repointed `$HOME`.
 */

export interface ResolveCaamExecutableOptions {
  executable?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  fsModule?: ResolveHardenedExecutableOptions["fsModule"];
}

export type ResolvedCaamExecutable = ResolvedClaudeExecutable;

export class CaamExecutableError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(
      message ??
        `Claude Code caam shallow-spawn integration refused because the resolved \`caam\` executable is unsafe: ${reason}.`,
    );
    this.name = "CaamExecutableError";
    this.reason = reason;
  }
}

/**
 * Explicit override for the resolved `caam` executable path. Mirrors
 * `ORACLE_CLAUDE_CODE_EXECUTABLE_ENV_VAR` — still fully hardened, never a
 * bypass of the safety checks themselves.
 */
export const ORACLE_CAAM_EXECUTABLE_ENV_VAR = "ORACLE_CAAM_EXECUTABLE";

export async function resolveCaamExecutable(
  options: ResolveCaamExecutableOptions = {},
): Promise<ResolvedCaamExecutable> {
  return resolveHardenedExecutable({
    executable: options.executable,
    envVarName: ORACLE_CAAM_EXECUTABLE_ENV_VAR,
    defaultCommand: "caam",
    repoRoot: options.repoRoot,
    env: options.env,
    uid: options.uid,
    fsModule: options.fsModule,
    makeError: (reason, message) => new CaamExecutableError(reason, message),
    notFoundMessage:
      "Claude Code caam shallow-spawn integration requires the `caam` command on PATH.",
    label: "caam_executable",
  });
}
