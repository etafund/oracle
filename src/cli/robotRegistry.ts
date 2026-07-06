// Single typed registry of every robot-facing Oracle CLI surface.
//
// The bead asks for `oracle robot-docs --json` to be "auto-generated
// from existing command definitions, not hand-written". The honest
// shape of that promise in a Commander.js codebase is: keep one typed
// declaration of every command in this file, and have every consumer
// (the CLI envelope emitter, the test suite, README/ROBOTS renderers)
// read from it. That eliminates the README↔ROBOTS↔implementation
// drift the bead is worried about — the prose is the OUTPUT, not the
// source.
//
// Each entry carries the v18 robot metadata the spec requires
// (`name`, `command`, `paid_calls`, `dry_run`, `required_env`,
// `output_schema_version`, `recovery_fields`, optional `mock_command`)
// plus a short non-prose `purpose`. Tests at
// `tests/cli/robotDocs.test.ts` assert every bead-required command is
// present and that the recovery_fields list stays aligned with
// `robot_surface.v1`.

import { CAPABILITY_LEASE_SCHEMA_VERSION } from "../oracle/v18/capability_lease.js";
import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  BROWSER_LEASE_SCHEMA_VERSION,
  JSON_ENVELOPE_SCHEMA_VERSION,
  PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_SCHEMA_VERSION,
  REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
  ROBOT_SURFACE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
} from "../oracle/v18/index.js";
import {
  CORE_RUN_ACTION,
  buildLaneSummaries,
  ORACLE_CAPABILITIES_SCHEMA_VERSION,
  type CapabilityLaneSummary,
  type CapabilityRunAction,
} from "../oracle/capabilities/registry.js";
import { REMOTE_FLEET_SLOTS_SCHEMA_VERSION } from "../remote/types.js";
import { SESSION_ARTIFACT_INDEX_SCHEMA_VERSION } from "../sessionArtifacts.js";
import { ORACLE_SESSION_ACTION_SCHEMA_VERSION } from "./sessionActionJson.js";
import { AGENT_LANE_POLICY_VERSION } from "./laneRegistry.js";
import { ORACLE_EXIT_CODE_DICTIONARY } from "./exitCodes.js";

export const ORACLE_ROBOT_TOOL_NAME = "oracle" as const;

/** v18 recovery fields every failure envelope must surface. */
export const ROBOT_ERROR_FIELDS_REQUIRED: readonly string[] = Object.freeze([
  "blocked_reason",
  "next_command",
  "fix_command",
  "retry_safe",
]);

/** Extended recovery fields surfaced when present. */
export const ROBOT_RECOVERY_FIELDS: readonly string[] = Object.freeze([
  "blocked_reason",
  "next_command",
  "fix_command",
  "retry_safe",
  "required_env",
  "docs_url_or_path",
]);

export interface RobotCommandEntry {
  /** Stable kebab-case identifier; matches the bundle's robots.json convention. */
  readonly name: string;
  /** Exact invocation a robot caller should run. */
  readonly command: string;
  /** Free-form mock invocation; useful for development rehearsal scripts. */
  readonly mock_command?: string;
  /** One-sentence non-prose purpose. */
  readonly purpose: string;
  /** Whether the command can spend money on live providers. */
  readonly paid_calls: boolean;
  /** Whether `--dry-run` is supported (true when no live work happens). */
  readonly dry_run: boolean;
  /** Environment variable NAMES (never values) the command may consult. */
  readonly required_env: readonly string[];
  /** v18 schema version the `data` field of the envelope conforms to. */
  readonly output_schema_version: string;
  /** Recovery fields the failure envelope must surface for this command. */
  readonly recovery_fields: readonly string[];
  /** Whether this surface touches the network. */
  readonly touches_network: boolean;
  /** Whether this surface launches/attaches Chrome. */
  readonly touches_chrome: boolean;
  /** Optional pointer for human-facing docs. */
  readonly docs_path?: string;
}

function entry(input: RobotCommandEntry): RobotCommandEntry {
  return Object.freeze({
    ...input,
    required_env: Object.freeze([...input.required_env]) as readonly string[],
    recovery_fields: Object.freeze([...input.recovery_fields]) as readonly string[],
  });
}

const ORACLE_REMOTE_ENVS: readonly string[] = ["ORACLE_REMOTE_HOST", "ORACLE_REMOTE_TOKEN"];

export const ROBOT_COMMANDS: readonly RobotCommandEntry[] = Object.freeze([
  entry({
    name: "capabilities",
    command: "oracle capabilities --json",
    mock_command: "oracle capabilities --json",
    purpose:
      "Static capability matrix (no live calls); the first command APR/vibe-planning should run.",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: ORACLE_CAPABILITIES_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
    docs_path: "README.md#capabilities",
  }),
  entry({
    name: "doctor",
    command: "oracle doctor --json",
    purpose: "Aggregate Oracle preflight (env, leases, evidence index, remote endpoint).",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: true,
    touches_chrome: false,
  }),
  entry({
    name: "doctor-lanes",
    command: "oracle doctor lanes --json",
    purpose:
      "Static reviewed-lane policy: ChatGPT Pro Extended Reasoning, Fable xHigh, and Gemini 3.1 Deep Think.",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "doctor-chatgpt",
    command: "oracle doctor chatgpt --json",
    purpose:
      "ChatGPT-specific provider doctor: selector manifest, picker labels, evidence readiness.",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "doctor-gemini",
    command: "oracle doctor gemini --json",
    purpose:
      "Gemini-specific provider doctor: Deep Think exposure, high-if-exposed strategy readiness.",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-plan",
    command: "oracle browser leases plan --providers chatgpt,gemini --json",
    mock_command: "oracle browser leases plan --providers chatgpt,gemini --json",
    purpose: "Plan the browser leases a multi-provider run would acquire (no acquisition).",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-status",
    command: "oracle browser leases status --json",
    purpose: "Inspect existing browser provider leases and their TTLs.",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-recover",
    command: "oracle browser leases recover --provider <chatgpt|gemini> --json",
    purpose: "Print safe recovery guidance for a stuck provider lease (advisory only).",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-acquire",
    command: "oracle browser leases acquire --provider <chatgpt|gemini> --json",
    purpose: "Acquire a browser provider lease before running a Pro / Deep Think browser session.",
    paid_calls: false,
    dry_run: false,
    required_env: [],
    output_schema_version: CAPABILITY_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "browser-leases-release",
    command: "oracle browser leases release --lease-id <id> --json",
    purpose: "Release a previously-acquired browser provider lease.",
    paid_calls: false,
    dry_run: false,
    required_env: [],
    output_schema_version: BROWSER_LEASE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "evidence-show",
    command: "oracle evidence show <session> --json",
    purpose:
      "Print the redacted artifact index for a stored session; never includes raw prompt/output.",
    paid_calls: false,
    dry_run: true,
    required_env: ["ORACLE_HOME_DIR"],
    output_schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "evidence-verify",
    command: "oracle evidence verify <session> --json",
    purpose:
      "Verify indexed evidence artifact hashes and trust-critical fields against the v18 contract.",
    paid_calls: false,
    dry_run: true,
    required_env: ["ORACLE_HOME_DIR"],
    output_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "session-artifacts",
    command: "oracle session <sessionId> --artifacts --json",
    purpose:
      "List transcripts, reports, generated/downloaded files, diagnostics, perf traces, and Claude Code artifacts for a stored session.",
    paid_calls: false,
    dry_run: true,
    required_env: ["ORACLE_HOME_DIR"],
    output_schema_version: SESSION_ARTIFACT_INDEX_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "remote-doctor",
    command: "oracle remote doctor --json",
    purpose: "Probe the configured remote Oracle endpoint (TCP + /health).",
    paid_calls: false,
    dry_run: false,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: true,
    touches_chrome: false,
  }),
  entry({
    name: "remote-slots",
    command: "oracle remote slots --json",
    purpose:
      "Show read-only per-lane remote browser slot state from GET /ready + GET /health; never posts /runs.",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: REMOTE_FLEET_SLOTS_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: true,
    touches_chrome: false,
  }),
  entry({
    name: "remote-status",
    command: "oracle remote status --json",
    purpose:
      "Print the resolved remote endpoint config without touching the network (env presence flags only).",
    paid_calls: false,
    dry_run: true,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
  entry({
    name: "remote-attach",
    command: "oracle remote attach --host <host:port> --json",
    purpose: "Probe attach readiness against a caller-supplied remote host without proxying calls.",
    paid_calls: false,
    dry_run: false,
    required_env: ["ORACLE_REMOTE_TOKEN"],
    output_schema_version: REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: true,
    touches_chrome: false,
  }),
  entry({
    name: "robot-docs",
    command: "oracle robot-docs --json",
    purpose:
      "Emit this registry as a robot_surface.v1 envelope — the source of truth for ROBOTS.md.",
    paid_calls: false,
    dry_run: true,
    required_env: [],
    output_schema_version: ROBOT_SURFACE_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: false,
    touches_chrome: false,
  }),
]);

/**
 * Session ACTION commands — lifecycle verbs that start a paid live run
 * (`paid_calls: true`), advertised under a distinct `action_commands`
 * key so the gating-only invariant on `ROBOT_COMMANDS`/`commands`
 * ("no entry currently exposes paid_calls=true") stays intact, mirroring
 * how the paid `lanes` array is kept separate.
 *
 * Both entries carry `--json`: stdout gets exactly one
 * `oracle_session_action.v1` launch receipt (new session id, parent id,
 * engine/mode, lane/model, wait/detach disposition, reattach command)
 * and all progress lines move to stderr. Known remaining gap, noted for
 * honesty: `oracle session <id>` / `oracle status <id>` attach mode
 * (non-`--artifacts`) still emits unstructured human text even with
 * `--json` — only the no-ID list form and `--artifacts` are structured.
 */
export const ROBOT_ACTION_COMMANDS: readonly RobotCommandEntry[] = Object.freeze([
  entry({
    name: "restart",
    command: "oracle restart <sessionId> --json",
    purpose:
      "Re-run a stored session as a new session (paid live run); --json emits one oracle_session_action.v1 launch receipt on stdout.",
    paid_calls: true,
    dry_run: false,
    required_env: ORACLE_REMOTE_ENVS,
    output_schema_version: ORACLE_SESSION_ACTION_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: true,
    touches_chrome: true,
    docs_path: "docs/cli-reference.md",
  }),
  entry({
    name: "follow-up",
    command: "oracle follow-up <parentSessionId> --prompt <text> --json",
    purpose:
      "Continue a stored browser session as a new child session (paid live run); --json emits one oracle_session_action.v1 launch receipt on stdout.",
    paid_calls: true,
    dry_run: false,
    required_env: [],
    output_schema_version: ORACLE_SESSION_ACTION_SCHEMA_VERSION,
    recovery_fields: ROBOT_RECOVERY_FIELDS,
    touches_network: true,
    touches_chrome: true,
    docs_path: "docs/cli-reference.md",
  }),
]);

const COMMAND_BY_NAME: ReadonlyMap<string, RobotCommandEntry> = new Map(
  [...ROBOT_COMMANDS, ...ROBOT_ACTION_COMMANDS].map((c) => [c.name, c]),
);

export function findRobotCommand(name: string): RobotCommandEntry | null {
  return COMMAND_BY_NAME.get(name) ?? null;
}

export function listRobotCommands(): readonly RobotCommandEntry[] {
  return ROBOT_COMMANDS;
}

export function listRobotActionCommands(): readonly RobotCommandEntry[] {
  return ROBOT_ACTION_COMMANDS;
}

/**
 * A reviewed lane, as advertised inside `robot-docs`. Deliberately a
 * SEPARATE array from `commands` (`ROBOT_COMMANDS`/`RobotCommandEntry`),
 * which is asserted elsewhere (`tests/cli/robotDocs.test.ts`, "no entry
 * currently exposes paid_calls=true") to be gating-only — every lane
 * entry here is an honest, real, paid/live call, so it must never be
 * folded into that array.
 */
export interface RobotLaneEntry extends CapabilityLaneSummary {
  readonly paid_calls: true;
}

function buildRobotLanes(): readonly RobotLaneEntry[] {
  return buildLaneSummaries().map((lane) => ({ ...lane, paid_calls: true as const }));
}

export interface RobotSurfacePayload {
  readonly schema_version: typeof ROBOT_SURFACE_SCHEMA_VERSION;
  readonly bundle_version: typeof V18_BUNDLE_VERSION;
  readonly tool: typeof ORACLE_ROBOT_TOOL_NAME;
  readonly json_envelope_required: true;
  readonly error_fields_required: readonly string[];
  readonly robot_recovery_fields: readonly string[];
  readonly first_try_principle: string;
  readonly notes: string;
  /** The core one-shot run action — same literal `oracle capabilities --json` reports. */
  readonly run_action: CapabilityRunAction;
  /** The 3 reviewed lanes an agent should try first, sourced from `laneRegistry.ts`. */
  readonly lanes: readonly RobotLaneEntry[];
  readonly lanes_policy_version: typeof AGENT_LANE_POLICY_VERSION;
  /** Process exit-code dictionary; see `src/cli/exitCodes.ts`. */
  readonly exit_codes: typeof ORACLE_EXIT_CODE_DICTIONARY;
  readonly commands: readonly Record<string, unknown>[];
  /**
   * Paid session lifecycle verbs (`restart`, `follow-up`) — kept out of
   * the gating-only `commands` array, like `lanes`.
   */
  readonly action_commands: readonly Record<string, unknown>[];
}

/**
 * Build the robot-surface payload from the registry. The result conforms
 * to v18 `robot_surface.v1` (typed-core: schema_version, tool, commands)
 * with bundle metadata + a `robot_recovery_fields` extension that
 * matches the canonical bundle's `robots.json` shape.
 */
export function buildRobotSurfacePayload(): RobotSurfacePayload {
  const toCommandRecord = (cmd: RobotCommandEntry): Record<string, unknown> => ({
    name: cmd.name,
    command: cmd.command,
    purpose: cmd.purpose,
    paid_calls: cmd.paid_calls,
    dry_run: cmd.dry_run,
    required_env: [...cmd.required_env],
    output_schema_version: cmd.output_schema_version,
    recovery_fields: [...cmd.recovery_fields],
    touches_network: cmd.touches_network,
    touches_chrome: cmd.touches_chrome,
    ...(cmd.mock_command ? { mock_command: cmd.mock_command } : {}),
    ...(cmd.docs_path ? { docs_path: cmd.docs_path } : {}),
  });
  const commands = ROBOT_COMMANDS.map(toCommandRecord);
  const actionCommands = ROBOT_ACTION_COMMANDS.map(toCommandRecord);
  return {
    schema_version: ROBOT_SURFACE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    tool: ORACLE_ROBOT_TOOL_NAME,
    json_envelope_required: true,
    error_fields_required: ROBOT_ERROR_FIELDS_REQUIRED,
    robot_recovery_fields: ROBOT_RECOVERY_FIELDS,
    first_try_principle:
      "The first command a coding agent guesses should work or redirect with a precise next command.",
    notes:
      "Oracle does not own the DeepSeek official API adapter for this workflow; APR does. Oracle continues to own browser routes and evidence.",
    run_action: CORE_RUN_ACTION,
    lanes: buildRobotLanes(),
    lanes_policy_version: AGENT_LANE_POLICY_VERSION,
    exit_codes: ORACLE_EXIT_CODE_DICTIONARY,
    commands,
    action_commands: actionCommands,
  };
}

/** Cross-reference the provider_access_policy version so callers can grep one constant for compatibility. */
export const ROBOT_REGISTRY_COMPATIBLE_POLICY_VERSION = PROVIDER_ACCESS_POLICY_SCHEMA_VERSION;
