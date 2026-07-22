import { execFile } from "node:child_process";
import { Command } from "commander";

import {
  ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR,
  CaamCommandError,
  resolveClaudeCodeCaamBase,
  resolveClaudeCodeCaamProfile,
  validateCaamBasePath,
  validateCaamProfileName,
  type ClaudeCodeCaamBaseSource,
} from "../../../claude-code/caamCommand.js";
import {
  runCaamShallowProfileDoctor,
  type CaamShallowProfileDoctorResult,
} from "../../../claude-code/caamDoctor.js";
import {
  CaamExecutableError,
  resolveCaamExecutable,
  type ResolvedCaamExecutable,
} from "../../../claude-code/caamResolver.js";
import {
  ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR,
  resolveClaudeCodeMaxRateLimitRotations,
} from "../../../claude-code/caamRotation.js";
import {
  runClaudeCodePreflight,
  type ClaudeCodePreflightResult,
} from "../../../claude-code/preflight.js";
import type { ClaudeCodeSingleFlightLockPeek } from "../../sessionRunner.js";

export const FABLE_DOCTOR_SCHEMA_VERSION = "fable_doctor.v1" as const;

export type FableDoctorStatus = "ready" | "degraded" | "blocked";
export type FableDoctorCheckStatus = "pass" | "warn" | "fail";

export interface FableDoctorCheck {
  name: string;
  status: FableDoctorCheckStatus;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  next_command?: string | null;
  fix_command?: string | null;
}

export interface FableAuthStatus {
  logged_in: boolean;
  auth_method: string | null;
  api_provider: string | null;
  subscription_type: string | null;
}

export interface FableDoctorAccount {
  mode: "caam";
  profile: string | null;
  profile_source: "config" | "oracle_env" | null;
  base: string | null;
  base_source: ClaudeCodeCaamBaseSource | null;
  caam_executable: string | null;
  claude_executable: string | null;
  fail_closed: true;
}

export interface FableDoctorReport {
  schema_version: typeof FABLE_DOCTOR_SCHEMA_VERSION;
  status: FableDoctorStatus;
  lane: "fable-local";
  model: "fable";
  effort: "xhigh";
  access_path: "claude_code_subscription_cli";
  account: FableDoctorAccount;
  auth: FableAuthStatus | null;
  checks: FableDoctorCheck[];
  blockers: FableDoctorCheck[];
  warnings: FableDoctorCheck[];
  single_flight_lock: {
    selected_profile_busy: boolean;
    live_holders: number;
  };
  effective_run_contract: {
    model: "fable";
    effort: "xhigh";
    permission_mode: "plan";
    allowed_tools: readonly [];
    unsafe_flags_allowed: false;
    max_rate_limit_rotations: number;
  };
}

export interface FableDoctorEnvelope {
  schema_version: "json_envelope.v1";
  ok: boolean;
  data: FableDoctorReport;
  meta: Record<string, unknown>;
  blocked_reason: string | null;
  next_command: string | null;
  fix_command: string | null;
  retry_safe: boolean;
  errors: Array<Record<string, unknown>>;
  warnings: string[];
  commands: Record<string, string>;
}

export interface FableAuthProbeInput {
  caamExecutable: string;
  profile: string;
  base: string;
  claudeExecutable: string;
}

export interface FableAuthProbeOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injectable for tests; defaults to `node:child_process`'s `execFile`. */
  execFileImpl?: typeof execFile;
}

export interface FableDoctorOptions {
  json?: boolean;
  caamProfile?: string;
  caamBase?: string;
  claudeCodeExecutable?: string;
  maxRateLimitRotations?: number;
  env?: NodeJS.ProcessEnv;
  oracleHome?: string;
  timeoutMs?: number;
  now?: () => Date;
  claudeCodePreflight?: (
    ...args: Parameters<typeof runClaudeCodePreflight>
  ) => Promise<ClaudeCodePreflightResult>;
  resolveCaamExecutable?: (
    ...args: Parameters<typeof resolveCaamExecutable>
  ) => Promise<ResolvedCaamExecutable>;
  caamProfileDoctor?: (
    caamExecutablePath: string,
    profile: string,
    base: string,
    options?: Parameters<typeof runCaamShallowProfileDoctor>[3],
  ) => Promise<CaamShallowProfileDoctorResult>;
  authProbe?: (input: FableAuthProbeInput) => Promise<FableAuthStatus>;
  peekLock?: () => Promise<ClaudeCodeSingleFlightLockPeek>;
}

export interface FableDoctorIo {
  stdout?: (text: string) => void;
}

export class FableAuthStatusError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FableAuthStatusError";
    this.code = code;
  }
}

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

/**
 * Read only the public subscription-routing fields from `claude auth status`.
 * The command may return email and organization identifiers; those are
 * intentionally never copied into this result or into an error.
 */
export async function runFableAuthStatusProbe(
  input: FableAuthProbeInput,
  options: FableAuthProbeOptions = {},
): Promise<FableAuthStatus> {
  const profile = validateCaamProfileName(input.profile);
  const base = validateCaamBasePath(input.base);
  const exec = options.execFileImpl ?? execFile;
  const args = [
    "shallow-spawn",
    profile,
    "--base",
    base,
    "--",
    input.claudeExecutable,
    "auth",
    "status",
    "--json",
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    exec(
      input.caamExecutable,
      args,
      {
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 128 * 1024,
      },
      (error, childStdout) => {
        if (error) {
          reject(
            new FableAuthStatusError(
              "fable_auth_status_failed",
              `Claude subscription auth status could not be read for caam profile ${JSON.stringify(profile)}.`,
            ),
          );
          return;
        }
        resolve(childStdout);
      },
    );
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new FableAuthStatusError(
      "fable_auth_status_malformed",
      `Claude subscription auth status returned malformed JSON for caam profile ${JSON.stringify(profile)}.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FableAuthStatusError(
      "fable_auth_status_malformed",
      `Claude subscription auth status returned an unexpected shape for caam profile ${JSON.stringify(profile)}.`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.loggedIn !== "boolean") {
    throw new FableAuthStatusError(
      "fable_auth_status_malformed",
      `Claude subscription auth status omitted loggedIn for caam profile ${JSON.stringify(profile)}.`,
    );
  }
  return {
    logged_in: record.loggedIn,
    auth_method: publicLabel(record.authMethod),
    api_provider: publicLabel(record.apiProvider),
    subscription_type: publicLabel(record.subscriptionType),
  };
}

export function registerFableDoctorCommand(
  doctorCommand: Command,
  deps: Partial<FableDoctorOptions> = {},
): Command {
  return doctorCommand
    .command("fable")
    .alias("fable-local")
    .description("Check the Fable xHigh Claude Code subscription lane without submitting a prompt.")
    .option(
      "--caam-profile <name>",
      "Select the CAAM shallow profile whose Claude subscription will be verified.",
    )
    .option(
      "--caam-base <path>",
      "Use this absolute CAAM shallow-profile base for both verification and launch.",
    )
    .option(
      "--claude-code-executable <path>",
      "Override the hardened Claude Code executable resolved inside the selected profile.",
    )
    .option("--json", "Print structured JSON.", false)
    .action(async function (this: Command) {
      const options = this.optsWithGlobals() as FableDoctorOptions;
      const envelope = await runFableDoctor({ ...deps, ...options });
      if (!envelope.ok) {
        process.exitCode = 1;
      }
    });
}

export async function runFableDoctor(
  options: FableDoctorOptions = {},
  io: FableDoctorIo = {},
): Promise<FableDoctorEnvelope> {
  const env = options.env ?? process.env;
  const checks: FableDoctorCheck[] = [];
  const maxRateLimitRotations = resolveClaudeCodeMaxRateLimitRotations(
    options.maxRateLimitRotations,
    env,
    { lane: "fable-local" },
  );
  const profileSource = options.caamProfile?.trim()
    ? "config"
    : env[ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]?.trim()
      ? "oracle_env"
      : null;
  let profile: string | null = null;
  let base: string | null = null;
  let baseSource: ClaudeCodeCaamBaseSource | null = null;
  let caamExecutable: string | null = null;
  let claudeExecutable: string | null = null;
  let auth: FableAuthStatus | null = null;
  let lockBusy = false;
  let liveLockHolders = 0;

  try {
    const configuredProfile = resolveClaudeCodeCaamProfile(options.caamProfile, env);
    if (!configuredProfile) {
      checks.push({
        name: "caam_profile",
        status: "fail",
        code: "caam_profile_not_configured",
        message:
          "Fable account identity is not pinned to a CAAM shallow profile, so Oracle cannot prove which Claude subscription would be used.",
        fix_command: "oracle doctor fable --caam-profile <name> --caam-base <absolute-path> --json",
        next_command: "caam shallow-profile list --json",
      });
    } else {
      profile = validateCaamProfileName(configuredProfile);
      checks.push({
        name: "caam_profile",
        status: "pass",
        code: "caam_profile_configured",
        message: `CAAM shallow profile ${JSON.stringify(profile)} is explicitly selected.`,
      });
    }
  } catch (error) {
    const code = error instanceof CaamCommandError ? error.code : "invalid_caam_profile_name";
    checks.push({
      name: "caam_profile",
      status: "fail",
      code,
      message: error instanceof Error ? error.message : "The CAAM profile name is invalid.",
      fix_command:
        "oracle doctor fable --caam-profile <safe-name> --caam-base <absolute-path> --json",
      next_command: "caam shallow-profile list --json",
    });
  }

  try {
    const resolution = resolveClaudeCodeCaamBase(options.caamBase, env);
    base = resolution.base;
    baseSource = resolution.source;
    checks.push({
      name: "caam_base",
      status: "pass",
      code: "caam_base_resolved",
      message: `Resolved the CAAM shallow-profile base to ${base}.`,
      details: { source: baseSource },
    });
  } catch (error) {
    const code = error instanceof CaamCommandError ? error.code : "caam_base_unresolved";
    checks.push({
      name: "caam_base",
      status: "fail",
      code,
      message: error instanceof Error ? error.message : "The CAAM base could not be resolved.",
      fix_command: `oracle doctor fable --caam-profile ${profile ? shellQuote(profile) : "<name>"} --caam-base <absolute-path> --json`,
      next_command: "caam shallow-profile list --json",
    });
  }

  const missingProfileCheck = checks.find((check) => check.code === "caam_profile_not_configured");
  if (missingProfileCheck && base) {
    missingProfileCheck.fix_command = `oracle doctor fable --caam-profile <name> --caam-base ${shellQuote(base)} --json`;
    missingProfileCheck.next_command = `caam shallow-profile list --base ${shellQuote(base)} --json`;
  }

  const preflightImpl = options.claudeCodePreflight ?? runClaudeCodePreflight;
  let preflight: ClaudeCodePreflightResult | null = null;
  try {
    preflight = await preflightImpl({
      executable: options.claudeCodeExecutable,
      env,
      oracleHome: options.oracleHome,
    });
    for (const check of preflight.checks) {
      const recovery =
        check.status === "fail"
          ? preflightRecovery(check.code, check.details, profile, base)
          : undefined;
      checks.push({
        name: `claude_code.${check.code}`,
        status: check.status,
        code: check.code,
        message: check.message,
        ...(check.details ? { details: publicPreflightDetails(check.details) } : {}),
        ...(recovery ?? {}),
      });
    }
    claudeExecutable = resolvedClaudePath(preflight);
    if (preflight.ok && !claudeExecutable) {
      checks.push({
        name: "claude_code.executable_path",
        status: "fail",
        code: "claude_executable_path_unavailable",
        message: "Claude executable preflight passed without returning a resolved executable path.",
        fix_command: "oracle doctor fable --json",
        next_command: "oracle doctor fable --json",
      });
    }
  } catch {
    checks.push({
      name: "claude_code.preflight",
      status: "fail",
      code: "claude_code_preflight_failed",
      message: "Claude Code preflight could not be completed.",
      fix_command: "oracle doctor fable --json",
      next_command: "oracle doctor fable --json",
    });
  }

  let resolvedCaam: ResolvedCaamExecutable | null = null;
  if (profile && base) {
    try {
      const resolveCaam = options.resolveCaamExecutable ?? resolveCaamExecutable;
      resolvedCaam = await resolveCaam({ env });
      caamExecutable = resolvedCaam.path;
      checks.push({
        name: "caam_executable",
        status: "pass",
        code: "caam_executable_resolved",
        message: `Resolved the CAAM executable to ${caamExecutable}.`,
      });
    } catch (error) {
      checks.push({
        name: "caam_executable",
        status: "fail",
        code:
          error instanceof CaamExecutableError
            ? `caam_executable_${error.reason}`
            : "caam_executable_unavailable",
        message: "The hardened CAAM executable could not be resolved.",
        fix_command: "Set ORACLE_CAAM_EXECUTABLE to a trusted caam executable on PATH.",
        next_command: buildDoctorCommand(profile, base),
      });
    }
  }

  let profileHealthy = false;
  if (resolvedCaam && profile && base) {
    try {
      const doctor = options.caamProfileDoctor ?? runCaamShallowProfileDoctor;
      await doctor(resolvedCaam.path, profile, base, { env, timeoutMs: options.timeoutMs });
      profileHealthy = true;
      checks.push({
        name: "caam_shallow_profile",
        status: "pass",
        code: "caam_shallow_profile_healthy",
        message: `CAAM verified shallow profile ${JSON.stringify(profile)} under ${base}.`,
      });
    } catch {
      checks.push({
        name: "caam_shallow_profile",
        status: "fail",
        code: "caam_shallow_profile_unavailable",
        message: `CAAM could not verify shallow profile ${JSON.stringify(profile)} under ${base}.`,
        fix_command: `caam shallow-profile create ${shellQuote(profile)} --base ${shellQuote(base)}`,
        next_command: `caam shallow-profile list --base ${shellQuote(base)} --json`,
      });
    }
  }

  if (profileHealthy && resolvedCaam && profile && base && claudeExecutable) {
    try {
      const authProbe =
        options.authProbe ??
        ((input: FableAuthProbeInput) =>
          runFableAuthStatusProbe(input, { env, timeoutMs: options.timeoutMs }));
      const probed = await authProbe({
        caamExecutable: resolvedCaam.path,
        profile,
        base,
        claudeExecutable,
      });
      // Copy only the four allowlisted public routing fields even when an
      // injected probe returns extra properties at runtime.
      auth = {
        logged_in: probed.logged_in === true,
        auth_method: publicLabel(probed.auth_method),
        api_provider: publicLabel(probed.api_provider),
        subscription_type: publicLabel(probed.subscription_type),
      };
      if (!auth.logged_in) {
        checks.push({
          name: "claude_subscription_auth",
          status: "fail",
          code: "fable_auth_required",
          message: `Claude is not logged in inside CAAM shallow profile ${JSON.stringify(profile)}.`,
          fix_command: buildAuthLoginCommand(resolvedCaam.path, profile, base, claudeExecutable),
          next_command: buildDoctorCommand(profile, base),
        });
      } else if (
        auth.auth_method !== "claude.ai" ||
        auth.api_provider !== "firstParty" ||
        !auth.subscription_type
      ) {
        checks.push({
          name: "claude_subscription_auth",
          status: "fail",
          code: "fable_subscription_auth_unverified",
          message:
            "Claude auth is present, but doctor could not verify first-party Claude subscription routing and a subscription plan.",
          fix_command: buildAuthLoginCommand(resolvedCaam.path, profile, base, claudeExecutable),
          next_command: buildDoctorCommand(profile, base),
        });
      } else {
        checks.push({
          name: "claude_subscription_auth",
          status: "pass",
          code: "fable_subscription_auth_verified",
          message: `Verified first-party Claude subscription auth (${auth.subscription_type}) inside CAAM shallow profile ${JSON.stringify(profile)}.`,
        });
      }
    } catch (error) {
      checks.push({
        name: "claude_subscription_auth",
        status: "fail",
        code: error instanceof FableAuthStatusError ? error.code : "fable_auth_status_failed",
        message:
          error instanceof FableAuthStatusError
            ? error.message
            : `Claude subscription auth could not be verified for CAAM shallow profile ${JSON.stringify(profile)}.`,
        fix_command: buildAuthLoginCommand(resolvedCaam.path, profile, base, claudeExecutable),
        next_command: buildDoctorCommand(profile, base),
      });
    }
  }

  if (profile) {
    try {
      const peekLock =
        options.peekLock ??
        (async () => {
          const { peekClaudeCodeSingleFlightLocks } = await import("../../sessionRunner.js");
          return peekClaudeCodeSingleFlightLocks();
        });
      const lock = await peekLock();
      const holders = lock.holders.filter(
        (holder) => holder.pid_alive && holder.caam_profile === profile,
      );
      liveLockHolders = holders.length;
      lockBusy = liveLockHolders > 0;
      checks.push({
        name: "selected_profile_lock",
        status: lockBusy ? "warn" : "pass",
        code: lockBusy ? "fable_profile_busy" : "fable_profile_idle",
        message: lockBusy
          ? `CAAM shallow profile ${JSON.stringify(profile)} already has ${liveLockHolders} live Fable run(s).`
          : `CAAM shallow profile ${JSON.stringify(profile)} has no live Fable single-flight lock.`,
        ...(lockBusy
          ? {
              next_command: `${buildRunCommand(profile, base)} --wait-for-lock 5m`,
            }
          : {}),
      });
    } catch {
      checks.push({
        name: "selected_profile_lock",
        status: "warn",
        code: "fable_profile_lock_unknown",
        message: "The selected profile's single-flight lock state could not be inspected.",
        next_command: buildDoctorCommand(profile, base),
      });
    }
  }

  checks.push({
    name: "effective_run_contract",
    status: maxRateLimitRotations > 0 ? "warn" : "pass",
    code:
      maxRateLimitRotations > 0
        ? "fable_account_rotation_enabled"
        : "fable_xhigh_read_only_contract",
    message:
      maxRateLimitRotations > 0
        ? `Fable remains read-only and xhigh, but up to ${maxRateLimitRotations} automatic CAAM account rotation(s) are enabled; strict subscription pinning is not guaranteed after a rate limit.`
        : "Fable runs use model fable, xhigh effort, plan permission mode, no tools, and zero automatic account rotations.",
    ...(maxRateLimitRotations > 0
      ? {
          fix_command: `${ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR}=0 ${buildDoctorCommand(profile, base)}`,
          next_command: `${ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR}=0 ${buildDoctorCommand(profile, base)}`,
        }
      : {}),
  });

  const blockers = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const ok = blockers.length === 0;
  const status: FableDoctorStatus = !ok ? "blocked" : warnings.length > 0 ? "degraded" : "ready";
  const doctorCommand = buildDoctorCommand(profile, base);
  const runCommand = buildRunCommand(profile, base);
  const firstBlocker = blockers[0];
  const firstWarning = warnings[0];
  const report: FableDoctorReport = {
    schema_version: FABLE_DOCTOR_SCHEMA_VERSION,
    status,
    lane: "fable-local",
    model: "fable",
    effort: "xhigh",
    access_path: "claude_code_subscription_cli",
    account: {
      mode: "caam",
      profile,
      profile_source: profileSource,
      base,
      base_source: baseSource,
      caam_executable: caamExecutable,
      claude_executable: claudeExecutable,
      fail_closed: true,
    },
    auth,
    checks,
    blockers,
    warnings,
    single_flight_lock: {
      selected_profile_busy: lockBusy,
      live_holders: liveLockHolders,
    },
    effective_run_contract: {
      model: "fable",
      effort: "xhigh",
      permission_mode: "plan",
      allowed_tools: [],
      unsafe_flags_allowed: false,
      max_rate_limit_rotations: maxRateLimitRotations,
    },
  };
  const envelope: FableDoctorEnvelope = {
    schema_version: "json_envelope.v1",
    ok,
    data: report,
    meta: {
      command: doctorCommand,
      generated_at: (options.now?.() ?? new Date()).toISOString(),
      schema_version: FABLE_DOCTOR_SCHEMA_VERSION,
      lane: "fable-local",
      status,
    },
    blocked_reason: firstBlocker?.code ?? null,
    next_command:
      firstBlocker?.next_command ?? firstWarning?.next_command ?? (ok ? runCommand : doctorCommand),
    fix_command: firstBlocker?.fix_command ?? firstWarning?.fix_command ?? null,
    retry_safe: ok,
    errors: blockers.map((check) => ({
      error_code: check.code,
      message: check.message,
      details: { check: check.name },
    })),
    warnings: warnings.map((check) => `${check.name}:${check.code}`),
    commands: {
      doctor: doctorCommand,
      run: runCommand,
      list_caam_profiles: base
        ? `caam shallow-profile list --base ${shellQuote(base)} --json`
        : "caam shallow-profile list --json",
      ...(resolvedCaam && profile && base && claudeExecutable
        ? {
            auth_status: buildAuthStatusCommand(resolvedCaam.path, profile, base, claudeExecutable),
          }
        : {}),
    },
  };

  const writer = io.stdout ?? ((text: string) => console.log(text));
  writer(options.json ? JSON.stringify(envelope, null, 2) : formatFableDoctor(envelope));
  return envelope;
}

function resolvedClaudePath(preflight: ClaudeCodePreflightResult): string | null {
  const check = preflight.checks.find((entry) => entry.code === "claude_executable_resolved");
  return typeof check?.details?.path === "string" ? check.details.path : null;
}

function publicPreflightDetails(details: Record<string, unknown>): Record<string, unknown> {
  const publicDetails: Record<string, unknown> = {};
  for (const key of ["reason", "path", "requested", "blocked_sources", "warnings"]) {
    if (key in details) {
      publicDetails[key] = details[key];
    }
  }
  return publicDetails;
}

function publicLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 80);
}

function preflightRecovery(
  code: string,
  details: Record<string, unknown> | undefined,
  profile: string | null,
  base: string | null,
): Pick<FableDoctorCheck, "fix_command" | "next_command"> {
  const doctor = buildDoctorCommand(profile, base);
  if (code === "anthropic_api_key_absent") {
    const blockedSources = Array.isArray(details?.blocked_sources)
      ? details.blocked_sources.filter((value): value is string => typeof value === "string")
      : [];
    return {
      fix_command:
        blockedSources.length > 0
          ? `unset ${blockedSources.map(shellQuote).join(" ")} && ${doctor}`
          : `Remove blocked Anthropic API/provider environment variables, then run: ${doctor}`,
      next_command: doctor,
    };
  }
  if (code === "claude_executable_resolved") {
    return {
      fix_command: `${doctor.replace(/ --json$/, "")} --claude-code-executable <trusted-absolute-path> --json`,
      next_command: doctor,
    };
  }
  if (code === "local_owner_verified") {
    return {
      fix_command: `ORACLE_HOME_DIR=<real-owned-non-symlink-directory> ${doctor}`,
      next_command: doctor,
    };
  }
  return { fix_command: doctor, next_command: doctor };
}

function buildDoctorCommand(profile: string | null, base: string | null): string {
  const account = profile ? ` --caam-profile ${shellQuote(profile)}` : "";
  const baseFlag = base ? ` --caam-base ${shellQuote(base)}` : "";
  return `oracle doctor fable${account}${baseFlag} --json`;
}

function buildRunCommand(profile: string | null, base: string | null): string {
  const account = profile ? ` --caam-profile ${shellQuote(profile)}` : "";
  const baseFlag = base ? ` --caam-base ${shellQuote(base)}` : "";
  return `oracle --lane fable-local${account}${baseFlag} --prompt <prompt> --file <path>`;
}

function buildAuthStatusCommand(
  caamExecutable: string,
  profile: string,
  base: string,
  claudeExecutable: string,
): string {
  return `${shellQuote(caamExecutable)} shallow-spawn ${shellQuote(profile)} --base ${shellQuote(base)} -- ${shellQuote(claudeExecutable)} auth status --json`;
}

function buildAuthLoginCommand(
  caamExecutable: string,
  profile: string,
  base: string,
  claudeExecutable: string,
): string {
  return `${shellQuote(caamExecutable)} shallow-spawn ${shellQuote(profile)} --base ${shellQuote(base)} -- ${shellQuote(claudeExecutable)} auth login`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function formatFableDoctor(envelope: FableDoctorEnvelope): string {
  const account = envelope.data.account;
  return [
    "oracle doctor fable",
    `status: ${envelope.data.status}`,
    `account: ${account.profile ?? "not configured"}${account.base ? ` (${account.base})` : ""}`,
    ...envelope.data.checks.map((check) => `- ${check.status} ${check.code}: ${check.message}`),
    envelope.fix_command ? `Fix: ${envelope.fix_command}` : null,
    envelope.next_command ? `Next: ${envelope.next_command}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
