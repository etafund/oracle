import { execFile } from "node:child_process";
import {
  ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR,
  resolveClaudeCodeCaamProfile,
} from "../../../claude-code/caamCommand.js";
import { resolveCaamExecutable } from "../../../claude-code/caamResolver.js";
import {
  runCaamRobotStatus,
  type CaamRobotProfileInfo,
  type CaamRobotStatusData,
} from "../../../claude-code/caamRotation.js";
import type { AggregateDoctorCheck } from "./aggregate.js";

/**
 * `oracle doctor`: surface caam account health + cooldown/rate-limit
 * visibility for the claude-code/Fable lane (etafund backlog R8,
 * oracle-router-oracle-doctor-caam-health-cooldown-4he).
 *
 * Deliberately opt-in, gated behind the SAME knob that already gates the
 * caam shallow-spawn integration itself
 * (`ORACLE_CLAUDE_CODE_CAAM_PROFILE`/`caamCommand.ts`): when no profile is
 * configured, this check returns `undefined` and `oracle doctor` behaves
 * exactly as it did before this module existed — no new field, no new
 * probe, no behavior change.
 *
 * Uses ONLY the version-stable "Robot Mode" surface (`caam robot status
 * <provider>`, `cmd/caam/cmd/robot.go`) that `caamRotation.ts` already
 * shells out to for `caam robot next` — never the removed
 * `shallow-profile doctor` verb, and no invented subcommands. Same
 * defensive posture as `caamDoctor.ts`: a caam CLI that can't produce a
 * parseable verdict (version skew, binary missing, timeout, ...) degrades
 * this check to `unknown`/`warn`, never `fail` — an optional visibility
 * surface must never flip `oracle doctor`'s overall `ok` to false on its
 * own, and must never block/replace the existing shallow-spawn pre-flight
 * or its silent-fallback behavior in `sessionRunner.ts`.
 */

export interface CaamDoctorCheckOptions {
  env?: NodeJS.ProcessEnv;
  /** The provider name caam tracks the claude-code lane under. */
  provider?: string;
  /** Injectable for tests; defaults to the real `caam` executable resolver. */
  resolveCaamExecutableImpl?: typeof resolveCaamExecutable;
  /** Injectable for tests; defaults to `node:child_process`'s `execFile`. */
  execFileImpl?: typeof execFile;
  timeoutMs?: number;
}

const DEFAULT_CAAM_DOCTOR_PROVIDER = "claude";

/**
 * Builds the `caam` component of `oracle doctor`'s aggregate check list.
 * Returns `undefined` (meaning "omit this check entirely") when
 * `ORACLE_CLAUDE_CODE_CAAM_PROFILE` is not configured — the opt-in gate.
 */
export async function runCaamDoctorCheck(
  options: CaamDoctorCheckOptions = {},
): Promise<AggregateDoctorCheck | undefined> {
  const env = options.env ?? process.env;
  const profile = resolveClaudeCodeCaamProfile(undefined, env);
  if (!profile) {
    return undefined;
  }
  const provider = options.provider ?? DEFAULT_CAAM_DOCTOR_PROVIDER;

  let executablePath: string;
  try {
    const resolveExecutable = options.resolveCaamExecutableImpl ?? resolveCaamExecutable;
    const resolved = await resolveExecutable({ env });
    executablePath = resolved.path;
  } catch (error) {
    return {
      component: "caam",
      status: "warn",
      code: "caam_executable_unresolved",
      message: `caam profile ${JSON.stringify(profile)} is configured (${ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR}) but the caam executable could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      details: { profile, provider },
      next_command: "oracle doctor --json",
      fix_command: "Install caam and ensure it is on PATH (or set ORACLE_CAAM_EXECUTABLE).",
      retry_safe: true,
    };
  }

  let outcome: Awaited<ReturnType<typeof runCaamRobotStatus>>;
  try {
    outcome = await runCaamRobotStatus(executablePath, provider, {
      env,
      execFileImpl: options.execFileImpl,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    return {
      component: "caam",
      status: "unknown",
      code: "caam_robot_status_unavailable",
      message: `caam robot status ${provider} did not return a readable verdict (caam version skew or the binary is unavailable): ${
        error instanceof Error ? error.message : String(error)
      }`,
      details: { profile, provider },
      next_command: `oracle doctor --json`,
      fix_command: null,
      retry_safe: true,
    };
  }

  if (!outcome.success) {
    return {
      component: "caam",
      status: "warn",
      code: "caam_robot_status_error",
      message: `caam robot status ${provider} reported ${outcome.code}: ${outcome.message}`,
      details: { profile, provider, raw: outcome.raw },
      next_command: `oracle doctor --json`,
      fix_command: null,
      retry_safe: true,
    };
  }

  return buildCaamHealthCheck(profile, provider, outcome.data);
}

function buildCaamHealthCheck(
  profile: string,
  provider: string,
  data: CaamRobotStatusData,
): AggregateDoctorCheck {
  const allProfiles = data.providers.flatMap((providerInfo) => providerInfo.profiles);
  const profiles = allProfiles.map(summarizeProfile);
  const configuredProfile = allProfiles.find((entry) => entry.name === profile);

  const details = {
    profile,
    provider,
    summary: data.summary,
    profiles,
  };

  if (!configuredProfile) {
    return {
      component: "caam",
      status: "warn",
      code: "caam_profile_not_found",
      message: `Configured caam profile ${JSON.stringify(profile)} (${ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR}) was not found in \`caam robot status ${provider}\`.`,
      details,
      next_command: `oracle doctor --json`,
      fix_command: `caam ls ${provider} --json`,
      retry_safe: true,
    };
  }

  const cooldownActive = configuredProfile.cooldown?.active === true;
  const healthStatus = configuredProfile.health.status;
  const unhealthy = healthStatus !== "healthy";

  if (cooldownActive) {
    return {
      component: "caam",
      status: "warn",
      code: "caam_profile_cooling_down",
      message: `caam profile ${JSON.stringify(profile)} is on cooldown${
        configuredProfile.cooldown?.remaining_str
          ? ` (${configuredProfile.cooldown.remaining_str} remaining)`
          : ""
      }${configuredProfile.cooldown?.reason ? `: ${configuredProfile.cooldown.reason}` : "."}`,
      details,
      next_command: `oracle doctor --json`,
      fix_command: null,
      retry_safe: true,
    };
  }

  if (unhealthy) {
    return {
      component: "caam",
      status: healthStatus === "critical" ? "warn" : "unknown",
      code: "caam_profile_unhealthy",
      message: `caam profile ${JSON.stringify(profile)} health status is ${JSON.stringify(healthStatus)}${
        configuredProfile.health.reason ? `: ${configuredProfile.health.reason}` : "."
      }`,
      details,
      next_command: `oracle doctor --json`,
      fix_command: null,
      retry_safe: true,
    };
  }

  return {
    component: "caam",
    status: "pass",
    code: "caam_profile_healthy",
    message: `caam profile ${JSON.stringify(profile)} is healthy and not on cooldown.`,
    details,
    retry_safe: true,
  };
}

function summarizeProfile(profileInfo: CaamRobotProfileInfo): Record<string, unknown> {
  return {
    name: profileInfo.name,
    active: profileInfo.active,
    health_status: profileInfo.health.status,
    health_reason: profileInfo.health.reason ?? null,
    expires_in: profileInfo.health.expires_in ?? null,
    error_count_1h: profileInfo.health.error_count_1h ?? null,
    cooldown_active: profileInfo.cooldown?.active ?? false,
    cooldown_remaining_str: profileInfo.cooldown?.remaining_str ?? null,
    cooldown_reason: profileInfo.cooldown?.reason ?? null,
  };
}
