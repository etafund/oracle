// Static capability registry — produces a CapabilityReport from local
// environment state with ZERO network calls. APR / vibe-planning will use
// this as the first Oracle preflight command, so it must be fast, free,
// boring, and deterministic.
//
// Each capability advertises:
//   * `supported`: the code path exists in this build of Oracle.
//   * `status`: ready | available | blocked | unsupported. `ready` means
//     the surface can be used right now; `available` means the code path
//     exists but local config is incomplete; `blocked` means we know it
//     will fail; `unsupported` means Oracle does not ship that adapter.
//   * `next_command` / `fix_command`: machine-readable recovery hints.
//
// Tokens, account identifiers, cookie values, raw DOM, screenshots, and
// auth headers are NEVER emitted. We only report ENV VAR NAMES + presence
// flags, plus the typed contract metadata that lives in this repo.

import {
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  BROWSER_LEASE_SCHEMA_VERSION,
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
} from "../v18/index.js";
import {
  AGENT_LANE_POLICY_VERSION,
  LANE_TEMPLATES,
  type LaneAttachmentCapability,
  type LaneContinuabilityCapability,
} from "../../cli/laneRegistry.js";
import { ORACLE_EXIT_CODE_DICTIONARY } from "../../cli/exitCodes.js";
import { CORE_READ_COMMANDS } from "../../cli/coreReadCommands.js";
import {
  IN_FLIGHT_SESSION_STATUSES,
  SESSION_STATUS_VALUES,
  TERMINAL_SESSION_STATUSES,
} from "../../cli/sessionStatus.js";
import {
  CAAM_SHALLOW_HOMES_DIR_ENV_VAR,
  ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR,
  ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR,
} from "../../claude-code/caamCommand.js";
import { ORACLE_CAAM_EXECUTABLE_ENV_VAR } from "../../claude-code/caamResolver.js";
import { ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR } from "../../claude-code/caamRotation.js";

export const ORACLE_CAPABILITIES_SCHEMA_VERSION = "oracle_capabilities.v1" as const;

/**
 * Session status/JSON contracts, advertised in the capability report so a
 * robot caller can discover the finite `SessionMetadata.status` set — and
 * which values are terminal vs still in flight — plus the single-session
 * (`oracle_session.v1`) and list (`oracle_session_list.v1`) JSON schema
 * versions, without scraping. The status enum's single source of truth is
 * `src/cli/sessionStatus.ts`; the two schema-version literals are pinned
 * against their contract modules by tests/cli/capabilities.test.ts (kept as
 * literals here so the cold-path registry never imports the session store).
 */
export const ORACLE_SESSION_CONTRACTS = Object.freeze({
  session_schema_version: "oracle_session.v1",
  session_list_schema_version: "oracle_session_list.v1",
  status_values: SESSION_STATUS_VALUES,
  terminal_statuses: TERMINAL_SESSION_STATUSES,
  in_flight_statuses: IN_FLIGHT_SESSION_STATUSES,
  commands: Object.freeze({
    session_json: "oracle session <id> --json",
    status_json: "oracle status <id> --json",
    list_json: "oracle status --json",
    wait_json: "oracle wait <id> --json",
    cancel: "oracle cancel <id>",
  }),
} as const);

export type CapabilityId =
  | "chatgpt_pro_browser"
  | "gemini_deep_think_browser"
  | "fable_xhigh_cli"
  | "remote_browser"
  | "browser_leases"
  | "redacted_evidence"
  | "provider_access_policy"
  | "prompt_payload_format_passthrough"
  | "toon_prompt_blocks_passthrough"
  | "deepseek_adapter";

export type CapabilityStatus = "ready" | "available" | "blocked" | "unsupported";

export interface CapabilityEntry {
  readonly id: CapabilityId;
  readonly supported: boolean;
  readonly status: CapabilityStatus;
  readonly description: string;
  readonly next_command: string | null;
  readonly fix_command: string | null;
  /** Non-secret metadata (schema versions, env var NAMES, flags, etc.). */
  readonly notes: Record<string, unknown>;
}

/** The core one-shot run action every agent eventually needs, regardless of lane. */
export interface CapabilityRunAction {
  readonly command: string;
  readonly description: string;
  /** Flags every invocation must pass; Oracle refuses to run without them. */
  readonly required_flags: readonly string[];
  /** Flags an agent commonly reaches for beyond the required pair. */
  readonly key_flags: readonly string[];
}

/** One of the 3 reviewed lanes, summarized for agent self-doc consumption. */
export interface CapabilityLaneSummary {
  readonly lane: string;
  readonly command: string;
  readonly doctor_command: string;
  readonly readiness: string;
  /** The flag(s) on top of `--lane <id>` that select this exact route. */
  readonly key_flags: readonly string[];
  /** File-attachment support/mechanism for this lane. */
  readonly attachments: LaneAttachmentCapability;
  /** Follow-up/multi-turn support for this lane. */
  readonly continuability: LaneContinuabilityCapability;
  /** Whether reasoning depth can be dialed up/down for this lane. */
  readonly reasoning_depth_adjustable: boolean;
  /** Fixed reasoning effort imposed by this lane, or null when not applicable. */
  readonly fixed_reasoning_effort: "xhigh" | null;
  /** Whether explicit account/profile selection refuses fallback to another account. */
  readonly explicit_profile_selection_fail_closed: boolean;
}

export interface CapabilityReport {
  readonly [key: string]: unknown;
  readonly schema_version: typeof ORACLE_CAPABILITIES_SCHEMA_VERSION;
  readonly bundle_version: typeof V18_BUNDLE_VERSION;
  readonly generated_at: string;
  readonly tty: boolean;
  readonly ci: boolean;
  readonly capabilities: readonly CapabilityEntry[];
  readonly counts: {
    readonly total: number;
    readonly ready: number;
    readonly available: number;
    readonly blocked: number;
    readonly unsupported: number;
  };
  /** The core run action — sourced once here, reused by `oracle robot-docs`. */
  readonly run_action: CapabilityRunAction;
  /** The 3 reviewed lanes, sourced from `laneRegistry.ts` (single source of truth). */
  readonly lanes: readonly CapabilityLaneSummary[];
  readonly lanes_policy_version: typeof AGENT_LANE_POLICY_VERSION;
  /** Process exit-code dictionary; see `src/cli/exitCodes.ts` for the full contract. */
  readonly exit_codes: typeof ORACLE_EXIT_CODE_DICTIONARY;
  /** Core read-only commands beyond `capabilities` itself. */
  readonly read_commands: typeof CORE_READ_COMMANDS;
  /** Closed session status enum + single-session/list JSON schema versions. */
  readonly session_contracts: typeof ORACLE_SESSION_CONTRACTS;
}

export interface BuildCapabilityReportInput {
  /** Subset of process.env to consult. Pass an empty object for CI/fixtures. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  /** When provided, overrides the TTY auto-detect (tests set this to a fixed value). */
  readonly tty?: boolean;
}

const REMOTE_HOST_ENV = "ORACLE_REMOTE_HOST";
const REMOTE_TOKEN_ENV = "ORACLE_REMOTE_TOKEN";
const OPENAI_KEY_ENV = "OPENAI_API_KEY";
const GEMINI_KEY_ENV = "GEMINI_API_KEY";

function detectCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const ci = env.CI?.toLowerCase();
  return ci === "1" || ci === "true" || ci === "yes";
}

function envPresent(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function chatgptCapability(env: Readonly<Record<string, string | undefined>>): CapabilityEntry {
  const remotePreferred = envPresent(env, REMOTE_HOST_ENV) && envPresent(env, REMOTE_TOKEN_ENV);
  return {
    id: "chatgpt_pro_browser",
    supported: true,
    status: "available",
    description:
      "Core lane: ChatGPT GPT-5.6 Sol + Pro through browser automation with redacted evidence.",
    next_command: remotePreferred
      ? "oracle --lane chatgpt-pro --prompt '...'"
      : "oracle doctor chatgpt --json",
    fix_command: remotePreferred
      ? null
      : "set ORACLE_REMOTE_HOST and ORACLE_REMOTE_TOKEN to prefer remote browser",
    notes: {
      evidence_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      requires_same_session_evidence: true,
      never_clicks_answer_now: true,
      remote_browser_preferred: remotePreferred,
    },
  };
}

function geminiCapability(env: Readonly<Record<string, string | undefined>>): CapabilityEntry {
  const remotePreferred = envPresent(env, REMOTE_HOST_ENV) && envPresent(env, REMOTE_TOKEN_ENV);
  return {
    id: "gemini_deep_think_browser",
    supported: true,
    status: "available",
    description:
      "Core lane: Gemini 3.1 Deep Think through browser automation with API-substitution guardrails.",
    next_command: remotePreferred
      ? "oracle --engine browser --provider gemini --gemini-deep-think --prompt '...'"
      : "oracle doctor gemini --json",
    fix_command: remotePreferred
      ? null
      : "set ORACLE_REMOTE_HOST and ORACLE_REMOTE_TOKEN to prefer remote browser",
    notes: {
      evidence_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      strategy: "high_if_exposed",
      never_substitutes_gemini_api: true,
      remote_browser_preferred: remotePreferred,
    },
  };
}

function fableCapability(): CapabilityEntry {
  return {
    id: "fable_xhigh_cli",
    supported: true,
    status: "available",
    description:
      "Core lane: Fable xHigh through the local Claude Code subscription CLI, isolated from browser/router transports.",
    next_command: "oracle doctor fable --caam-profile <profile> --json",
    fix_command: null,
    notes: {
      lane: "fable-local",
      effort: "xhigh",
      effort_adjustable: false,
      access_path: "claude_code_subscription_cli",
      local_only: true,
      remote_browser_allowed: false,
      api_substitution_guard: true,
      doctor_command: "oracle doctor fable --caam-profile <profile> --json",
      caam_profile_flag: "--caam-profile <profile>",
      caam_base_flag: "--caam-base <absolute-path>",
      caam_profile_env: ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR,
      caam_base_env: ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR,
      caam_native_base_env: CAAM_SHALLOW_HOMES_DIR_ENV_VAR,
      caam_executable_env: ORACLE_CAAM_EXECUTABLE_ENV_VAR,
      caam_profile_required_for_reviewed_lane: true,
      explicit_profile_selection_fail_closed: true,
      direct_claude_fallback_compatibility_engine_only: true,
    },
  };
}

function remoteBrowserCapability(
  env: Readonly<Record<string, string | undefined>>,
): CapabilityEntry {
  const hostPresent = envPresent(env, REMOTE_HOST_ENV);
  const tokenPresent = envPresent(env, REMOTE_TOKEN_ENV);
  if (hostPresent && tokenPresent) {
    return {
      id: "remote_browser",
      supported: true,
      status: "ready",
      description: "Remote browser endpoint configured; preferred over local Chrome.",
      next_command: "oracle remote doctor --json",
      fix_command: null,
      notes: {
        host_env: REMOTE_HOST_ENV,
        token_env: REMOTE_TOKEN_ENV,
        host_present: true,
        token_present: true,
        endpoint_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
      },
    };
  }
  const missing = [
    hostPresent ? null : REMOTE_HOST_ENV,
    tokenPresent ? null : REMOTE_TOKEN_ENV,
  ].filter((value): value is string => value !== null);
  return {
    id: "remote_browser",
    supported: true,
    status: "available",
    description: "Remote browser code path exists but no remote endpoint is configured locally.",
    next_command: `set ${missing.join(" and ")} to enable remote browser`,
    fix_command: `set ${missing.join(" and ")} to enable remote browser`,
    notes: {
      host_env: REMOTE_HOST_ENV,
      token_env: REMOTE_TOKEN_ENV,
      host_present: hostPresent,
      token_present: tokenPresent,
      missing_env_vars: missing,
      endpoint_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    },
  };
}

function browserLeasesCapability(): CapabilityEntry {
  return {
    id: "browser_leases",
    supported: true,
    status: "ready",
    description: "Typed browser leases with TTL, status, and same-session policy.",
    next_command: "oracle browser leases status --json",
    fix_command: null,
    notes: {
      lease_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
      enforces_provider_locks: true,
    },
  };
}

function redactedEvidenceCapability(): CapabilityEntry {
  return {
    id: "redacted_evidence",
    supported: true,
    status: "ready",
    description: "Redacted browser evidence is the default; unsafe payloads are quarantined.",
    next_command: "oracle evidence show <session> --json",
    fix_command: null,
    notes: {
      evidence_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      default_redaction_policy: "redacted",
      quarantine_excluded_from_normal_index: true,
    },
  };
}

function providerAccessPolicyCapability(): CapabilityEntry {
  return {
    id: "provider_access_policy",
    supported: true,
    status: "ready",
    description: "Typed protected-slot metadata and API-substitution guard surface.",
    next_command: "oracle capabilities --json",
    fix_command: null,
    notes: {
      policy_schema_version: PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
      api_substitution_guard: true,
    },
  };
}

function promptPayloadPassthroughCapability(): CapabilityEntry {
  return {
    id: "prompt_payload_format_passthrough",
    supported: true,
    status: "ready",
    description:
      "Prompt payload bytes pass through Oracle unchanged with prompt_sha256 provenance.",
    next_command: null,
    fix_command: null,
    notes: {
      preserves_byte_order: true,
      records_prompt_sha256: true,
    },
  };
}

function toonPassthroughCapability(): CapabilityEntry {
  return {
    id: "toon_prompt_blocks_passthrough",
    supported: true,
    status: "available",
    description:
      "TOON-encoded prompt blocks are passed through; canonical storage remains JSON until legal review opts in.",
    next_command: null,
    fix_command:
      "context_serialization_policy.policy_status=gated_optional; enable per project after legal review",
    notes: {
      context_serialization_policy_schema_version: CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
      canonical_storage_format: "json",
      policy_status: "gated_optional",
      toon_rust_enabled_by_default: false,
    },
  };
}

function deepseekAdapterCapability(): CapabilityEntry {
  return {
    id: "deepseek_adapter",
    supported: false,
    status: "unsupported",
    description: "Oracle does not ship a DeepSeek adapter; APR routes DeepSeek directly.",
    next_command: null,
    fix_command: null,
    notes: {
      ownership: "apr",
      reason: "no DeepSeek adapter ownership for this workflow",
    },
  };
}

/**
 * The core one-shot run action — the thing every agent eventually runs
 * regardless of lane. Static (no env/clock dependency); a single literal
 * so `oracle capabilities --json` and `oracle robot-docs` can never
 * describe the required flags differently. Exported so `robotRegistry.ts`
 * reuses this literal instead of hand-copying it.
 */
export const CORE_RUN_ACTION: CapabilityRunAction = Object.freeze({
  command: 'oracle --lane <chatgpt-pro|gemini-deep-think|fable-local> --prompt "..." --file <path>',
  description:
    "One-shot run against a reviewed lane. --prompt and --file are both required — Oracle starts empty and cannot see a project without --file.",
  required_flags: Object.freeze(["--prompt", "--file"]),
  key_flags: Object.freeze([
    "--lane",
    "--dry-run",
    "--slug",
    "--render",
    "--copy-markdown",
    "--followup",
  ]),
}) as CapabilityRunAction;

/**
 * Summarize the 3 reviewed lanes from `laneRegistry.ts`'s `LANE_TEMPLATES`
 * — the same registry `oracle doctor lanes --json` reads — so this
 * contract can't drift from the runtime lane policy. Exported for reuse
 * by `robotRegistry.ts`.
 */
export function buildLaneSummaries(): readonly CapabilityLaneSummary[] {
  return LANE_TEMPLATES.map((entry) => ({
    lane: entry.lane,
    command: entry.command,
    doctor_command: entry.doctorCommand,
    readiness: entry.readiness,
    key_flags: entry.keyFlags,
    attachments: entry.attachments,
    continuability: entry.continuability,
    reasoning_depth_adjustable: entry.reasoning_depth_adjustable,
    fixed_reasoning_effort: entry.fixedReasoningEffort,
    explicit_profile_selection_fail_closed: entry.explicitProfileSelectionFailClosed,
  }));
}

/**
 * Build a `CapabilityReport` from the supplied env + clock. Pure — no
 * filesystem reads, no network calls, no `process.env` access. Pass an
 * empty `env` object for fully deterministic CI/doc snapshots.
 */
export function buildCapabilityReport(input: BuildCapabilityReportInput): CapabilityReport {
  const capabilities: CapabilityEntry[] = [
    chatgptCapability(input.env),
    geminiCapability(input.env),
    fableCapability(),
    remoteBrowserCapability(input.env),
    browserLeasesCapability(),
    redactedEvidenceCapability(),
    providerAccessPolicyCapability(),
    promptPayloadPassthroughCapability(),
    toonPassthroughCapability(),
    deepseekAdapterCapability(),
  ];
  // Stable ordering: caller already constructed in declaration order;
  // alphabetize by id for deterministic snapshot tests.
  capabilities.sort((a, b) => a.id.localeCompare(b.id));

  const counts = capabilities.reduce(
    (acc, entry) => {
      acc.total += 1;
      acc[entry.status] = (acc[entry.status] ?? 0) + 1;
      return acc;
    },
    { total: 0, ready: 0, available: 0, blocked: 0, unsupported: 0 } as {
      total: number;
      ready: number;
      available: number;
      blocked: number;
      unsupported: number;
    },
  );

  return {
    schema_version: ORACLE_CAPABILITIES_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    generated_at: input.now.toISOString(),
    tty: input.tty ?? false,
    ci: detectCi(input.env),
    capabilities,
    counts,
    run_action: CORE_RUN_ACTION,
    lanes: buildLaneSummaries(),
    lanes_policy_version: AGENT_LANE_POLICY_VERSION,
    exit_codes: ORACLE_EXIT_CODE_DICTIONARY,
    read_commands: CORE_READ_COMMANDS,
    session_contracts: ORACLE_SESSION_CONTRACTS,
    // Reference: env var names callers can hand off for credentials.
    // Listed here for the benefit of robot callers; never the values.
    ...({
      env_var_names: {
        remote_host: REMOTE_HOST_ENV,
        remote_token: REMOTE_TOKEN_ENV,
        openai_api_key: OPENAI_KEY_ENV,
        gemini_api_key: GEMINI_KEY_ENV,
        claude_code_caam_profile: ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR,
        claude_code_caam_base: ORACLE_CLAUDE_CODE_CAAM_BASE_ENV_VAR,
        caam_shallow_homes_dir: CAAM_SHALLOW_HOMES_DIR_ENV_VAR,
        caam_executable: ORACLE_CAAM_EXECUTABLE_ENV_VAR,
        claude_code_max_rate_limit_rotations: ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR,
      },
    } as Record<string, unknown>),
  };
}

export function capabilityById(
  report: CapabilityReport,
  id: CapabilityId,
): CapabilityEntry | undefined {
  return report.capabilities.find((entry) => entry.id === id);
}
