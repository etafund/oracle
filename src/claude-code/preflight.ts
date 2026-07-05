import { getOracleHomeDir } from "../oracleHome.js";
import { findBlockedClaudeCodeEnvironmentSources } from "./envGuard.js";
import {
  resolveClaudeExecutable,
  ClaudeCodeExecutableError,
  type ResolveClaudeExecutableOptions,
  type ResolvedClaudeExecutable,
} from "./executableResolver.js";
import { assertClaudeCodeLocalOwner, ClaudeCodeLocalOwnerError } from "./localOwnerGuard.js";

/**
 * Side-effect-free health checks for the Fable (`claude-code`) local lane,
 * shared by `oracle doctor lanes --json` and `oracle --dry-run --lane
 * fable-local` so a broken `claude` executable (unsafe symlink, wrong
 * owner, world-writable path component, blocked auth env, etc.) is
 * reported BEFORE a real run, not only when a live session spawns the
 * child process and fails. Never spawns `claude`, never sends a prompt.
 */

export type ClaudeCodePreflightStatus = "pass" | "fail";

export interface ClaudeCodePreflightCheck {
  code: string;
  status: ClaudeCodePreflightStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ClaudeCodePreflightResult {
  ok: boolean;
  checks: ClaudeCodePreflightCheck[];
}

export interface ClaudeCodePreflightOptions {
  /** Explicit executable override — mirrors `resolveClaudeExecutable`'s option. */
  executable?: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides `getOracleHomeDir()` — mainly for tests. */
  oracleHome?: string;
  fsModule?: ResolveClaudeExecutableOptions["fsModule"];
  uid?: number;
}

export async function runClaudeCodePreflight(
  options: ClaudeCodePreflightOptions = {},
): Promise<ClaudeCodePreflightResult> {
  const env = options.env ?? process.env;
  const checks: ClaudeCodePreflightCheck[] = [];

  checks.push(checkEnvGuard(env));
  checks.push(await checkExecutableResolution(options, env));
  checks.push(await checkLocalOwner(options, env));

  return {
    ok: checks.every((check) => check.status === "pass"),
    checks,
  };
}

function checkEnvGuard(env: NodeJS.ProcessEnv): ClaudeCodePreflightCheck {
  const blockedSources = findBlockedClaudeCodeEnvironmentSources(env);
  if (blockedSources.length === 0) {
    return {
      code: "anthropic_api_key_absent",
      status: "pass",
      message: "No blocked Anthropic API/provider environment variables present.",
    };
  }
  return {
    code: "anthropic_api_key_absent",
    status: "fail",
    message: `Claude Code subscription mode would be refused because ${blockedSources.join(", ")} could route the run through API/provider billing.`,
    details: { blocked_sources: blockedSources },
  };
}

async function checkExecutableResolution(
  options: ClaudeCodePreflightOptions,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeCodePreflightCheck> {
  let resolved: ResolvedClaudeExecutable;
  try {
    resolved = await resolveClaudeExecutable({
      executable: options.executable,
      env,
      uid: options.uid,
      fsModule: options.fsModule,
      // Deliberately no `repoRoot` here: doctor/dry-run preflight is a
      // general health check, not tied to a specific reviewed cwd — the
      // inside-reviewed-repo leg is still enforced at real-run time
      // (sessionRunner.ts passes the live `cwd`).
    });
  } catch (error) {
    const reason = error instanceof ClaudeCodeExecutableError ? error.reason : "unknown_error";
    return {
      code: "claude_executable_resolved",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      details: { reason },
    };
  }
  return {
    code: "claude_executable_resolved",
    status: "pass",
    message: `Resolved \`claude\` executable to ${resolved.path}.`,
    details: { path: resolved.path, requested: resolved.requested },
  };
}

async function checkLocalOwner(
  options: ClaudeCodePreflightOptions,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeCodePreflightCheck> {
  try {
    const result = await assertClaudeCodeLocalOwner({
      oracleHome: options.oracleHome ?? getOracleHomeDir(),
      env,
      uid: options.uid,
      transport: "stdio",
      fsModule: options.fsModule,
    });
    return {
      code: "local_owner_verified",
      status: "pass",
      message: "Oracle home directory passes local-owner hardening (owned, non-world-writable, no unsafe symlink).",
      details: { warnings: result.warnings },
    };
  } catch (error) {
    const reason = error instanceof ClaudeCodeLocalOwnerError ? error.reason : "unknown_error";
    return {
      code: "local_owner_verified",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      details: { reason },
    };
  }
}
