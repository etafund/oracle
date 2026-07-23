// `oracle session <id> --json` / `oracle status <id> --json` /
// `oracle wait <id> --json` — the single-session machine-readable status
// surface.
//
// Follows the Axiom-8 pattern established by `sessionListJson.ts`
// (`oracle_session_list.v1`): a stable, documented JSON contract
// (`oracle_session.v1`) wrapped in a `json_envelope.v1`, with a pinned key
// set backed by a schema-pin regression test (see
// tests/cli/sessionJson.test.ts).
//
// This closes machine-output finding #4 (attach mode silently ignored
// `--json` and streamed human markdown; the only per-session JSON,
// `--artifacts --json`, omitted run status/usage/elapsed). Unlike the
// list surface, this describes exactly ONE session: its terminal-or-not
// status from the closed enum, the exit code an agent waiting on it would
// receive, usage, timestamps, artifact/output paths, and a structured
// error when the run failed. Metadata-only imports use `status=imported`
// and `output_file=null`, never a completed-run representation. `oracle
// wait` re-uses `resolveSessionExitCode`
// so the process exit code and the emitted `data.exit_code` never disagree.

import path from "node:path";

import {
  hasImportedChatgptConversationClaim,
  parsePureImportedChatgptConversationSession,
} from "../browser/importedConversation.js";
import { V18_BUNDLE_VERSION, createEnvelope, type JsonEnvelope } from "../oracle/v18/index.js";
import type { SessionMetadata, SessionStatus } from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";
import {
  ORACLE_ERROR_CLASS_EXIT_CODES,
  classifyOracleErrorClass,
  isRetrySafeErrorClass,
  type OracleErrorClass,
} from "./exitCodes.js";
import {
  coerceValidatedSessionStatus,
  isSuccessTerminalStatus,
  isTerminalSessionStatus,
} from "./sessionStatus.js";

export const ORACLE_SESSION_SCHEMA_VERSION = "oracle_session.v1" as const;
export const INVALID_IMPORTED_SESSION_ERROR_CODE = "invalid_imported_session" as const;

/** Token usage summary; each field is a number so the JSON shape is stable. */
export interface SessionUsageSummary {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number | null;
}

/** Structured error present only when the session failed or was cancelled. */
export interface SessionErrorSummary {
  readonly code: string;
  readonly message: string;
}

/** The pinned `oracle_session.v1` payload shape. */
export interface SessionJsonPayload {
  readonly schema_version: typeof ORACLE_SESSION_SCHEMA_VERSION;
  readonly id: string;
  readonly lane: string | null;
  readonly model: string | null;
  readonly mode: string | null;
  /** Closed enum — see SESSION_STATUS_VALUES in sessionStatus.ts. */
  readonly status: SessionStatus;
  readonly terminal: boolean;
  /**
   * The process exit code an agent would receive by waiting on this
   * session: 0 for completed/partial, 3–6 for a classified failure, 1 for
   * a generic failure or cancellation, 0 for a valid imported reference,
   * and `null` while still in flight.
   */
  readonly exit_code: number | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
  readonly elapsed_ms: number | null;
  readonly usage: SessionUsageSummary | null;
  /** Directory holding this session's artifacts (meta.json, logs, downloads). */
  readonly artifacts_path: string;
  /** The saved run transcript path. */
  readonly output_file: string | null;
  /** Final-answer artifact path when the lane produces one (Claude Code), else null. */
  readonly final_answer_path: string | null;
  readonly error: SessionErrorSummary | null;
}

export interface BuildSessionJsonOptions {
  /** Override the session directory (defaults to the sessions-dir convention). */
  readonly sessionDir?: string;
  /** Override the transcript path (defaults to `<sessionDir>/output.log`). */
  readonly outputFile?: string;
}

export interface SessionJsonEnvelopeResult {
  readonly envelope: JsonEnvelope;
  readonly payload: SessionJsonPayload;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Classify a terminal error session into one of the normalized
 * {@link OracleErrorClass} buckets using the same duck-typed matcher the
 * top-level `--json` envelope and exit-code taxonomy use, fed the stored
 * transport reason + user-error details.
 */
export function classifySessionErrorClass(metadata: SessionMetadata): OracleErrorClass | null {
  return classifyOracleErrorClass({
    reason: metadata.transport?.reason,
    details: {
      ...(metadata.error?.details ?? {}),
      reason: metadata.transport?.reason,
    },
  });
}

/**
 * Resolve the status exposed by trusted CLI surfaces. Manual imports retain
 * `imported` only after the entire record passes the exact pure-shape parser;
 * a bare or mixed status claim is presented as an error.
 */
export function resolveValidatedSessionStatus(metadata: SessionMetadata): SessionStatus {
  const hasImportedClaim = hasImportedChatgptConversationClaim(metadata);
  const importedSessionIsPure =
    hasImportedClaim && parsePureImportedChatgptConversationSession(metadata, metadata.id) !== null;
  if (hasImportedClaim && !importedSessionIsPure) {
    return "error";
  }
  return coerceValidatedSessionStatus(metadata.status, importedSessionIsPure);
}

/**
 * The process exit code a caller waiting on this session would receive.
 * `null` while the session is still in flight (non-terminal).
 */
export function resolveSessionExitCode(metadata: SessionMetadata): number | null {
  const status = resolveValidatedSessionStatus(metadata);
  if (!isTerminalSessionStatus(status)) {
    return null;
  }
  if (isSuccessTerminalStatus(status)) {
    return 0;
  }
  if (status === "imported") {
    return 0;
  }
  if (status === "cancelled") {
    return 1;
  }
  const errorClass = classifySessionErrorClass(metadata);
  return errorClass ? ORACLE_ERROR_CLASS_EXIT_CODES[errorClass] : 1;
}

function buildUsageSummary(metadata: SessionMetadata): SessionUsageSummary | null {
  const usage = metadata.usage;
  if (!usage) {
    return null;
  }
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    reasoning_tokens: usage.reasoningTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
    cost_usd: usage.cost ?? null,
  };
}

function buildErrorSummary(metadata: SessionMetadata): SessionErrorSummary | null {
  if (
    hasImportedChatgptConversationClaim(metadata) &&
    resolveValidatedSessionStatus(metadata) === "error"
  ) {
    return {
      code: INVALID_IMPORTED_SESSION_ERROR_CODE,
      message:
        "Session claims imported ChatGPT metadata but does not match Oracle's exact metadata-only import shape.",
    };
  }
  if (metadata.status === "cancelled") {
    return {
      code: "cancelled",
      message:
        metadata.errorMessage ??
        metadata.error?.message ??
        "Session was cancelled before it finished.",
    };
  }
  if (metadata.status !== "error") {
    return null;
  }
  const errorClass = classifySessionErrorClass(metadata);
  const code = errorClass ?? readString(metadata.error?.details, "error_code") ?? "run_error";
  const message = metadata.errorMessage ?? metadata.error?.message ?? "Session failed.";
  return { code, message };
}

/** Build the pinned `oracle_session.v1` payload. Pure — no I/O, no clock. */
export function buildSessionJsonPayload(
  metadata: SessionMetadata,
  options: BuildSessionJsonOptions = {},
): SessionJsonPayload {
  const status = resolveValidatedSessionStatus(metadata);
  const sessionDir = options.sessionDir ?? path.join(sessionStore.sessionsDir(), metadata.id);
  const outputFile =
    status === "imported" ? null : (options.outputFile ?? path.join(sessionDir, "output.log"));
  const finalAnswerPath =
    metadata.claudeCode?.artifact_paths?.finalAnswerPath ??
    metadata.claudeCode?.final_answer_path ??
    null;
  return {
    schema_version: ORACLE_SESSION_SCHEMA_VERSION,
    id: metadata.id,
    lane: metadata.lane ?? null,
    model: metadata.model ?? null,
    mode: metadata.mode ?? null,
    status,
    terminal: isTerminalSessionStatus(status),
    exit_code: resolveSessionExitCode(metadata),
    created_at: metadata.createdAt,
    started_at: metadata.startedAt ?? null,
    completed_at: metadata.completedAt ?? null,
    updated_at: metadata.completedAt ?? metadata.startedAt ?? metadata.createdAt,
    elapsed_ms: metadata.elapsedMs ?? null,
    usage: buildUsageSummary(metadata),
    artifacts_path: sessionDir,
    output_file: outputFile,
    final_answer_path: finalAnswerPath,
    error: buildErrorSummary(metadata),
  };
}

/** Wrap the single-session payload in a `json_envelope.v1`. Pure — no I/O. */
export function buildSessionJsonEnvelope(
  metadata: SessionMetadata,
  options: BuildSessionJsonOptions & { generatedAt?: string } = {},
): SessionJsonEnvelopeResult {
  const payload = buildSessionJsonPayload(metadata, options);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const invalidImportedSession =
    hasImportedChatgptConversationClaim(metadata) && payload.status === "error";
  const errorClass = payload.status === "error" ? classifySessionErrorClass(metadata) : null;
  const nextCommand =
    payload.status === "imported"
      ? `oracle --engine browser --remote-browser off --browser-model-strategy current --followup ${payload.id} -p "..."`
      : payload.terminal
        ? `oracle session ${payload.id} --artifacts --json`
        : `oracle wait ${payload.id} --json`;
  const commands =
    payload.status === "imported"
      ? {
          session_json: `oracle session ${payload.id} --json`,
          followup_compatibility: nextCommand,
        }
      : {
          session_json: `oracle session ${payload.id} --json`,
          wait_json: `oracle wait ${payload.id} --json`,
          artifacts_json: `oracle session ${payload.id} --artifacts --json`,
          cancel: `oracle cancel ${payload.id}`,
        };
  const envelope = createEnvelope({
    ok: true,
    data: payload as unknown as Record<string, unknown>,
    meta: {
      bundle_version: V18_BUNDLE_VERSION,
      schema_version: payload.schema_version,
      generated_at: generatedAt,
      session_id: payload.id,
      status: payload.status,
      terminal: payload.terminal,
    },
    next_command: nextCommand,
    fix_command: null,
    // Reading a session's status is always safe to repeat; when the run
    // itself failed transiently, advertise that via the class.
    retry_safe: invalidImportedSession
      ? false
      : errorClass
        ? isRetrySafeErrorClass(errorClass)
        : true,
    commands,
  });
  return { envelope, payload };
}

/** Build the ok:false envelope emitted when the requested session id is unknown. */
export function buildSessionNotFoundEnvelope(
  sessionId: string,
  generatedAt: string = new Date().toISOString(),
): JsonEnvelope {
  return createEnvelope({
    ok: false,
    data: null,
    meta: {
      bundle_version: V18_BUNDLE_VERSION,
      schema_version: ORACLE_SESSION_SCHEMA_VERSION,
      generated_at: generatedAt,
      session_id: sessionId,
    },
    blocked_reason: "session_not_found",
    next_command: "oracle status --json",
    fix_command: null,
    retry_safe: false,
    warnings: [`No session found with ID ${sessionId}.`],
  });
}

export interface RunSessionJsonIo {
  readonly stdout?: (text: string) => void;
}

export interface RunSessionJsonResult {
  readonly found: boolean;
  readonly metadata?: SessionMetadata;
  readonly envelope: JsonEnvelope;
  readonly payload?: SessionJsonPayload;
}

/**
 * Read one session and print its `oracle_session.v1` envelope to stdout.
 * Emits a structured ok:false envelope (never a stack trace / human line)
 * when the session id is unknown, so a `--json` caller always parses a
 * single envelope. Returns `found: false` so the caller can set exit 1.
 */
export async function runSessionJson(
  sessionId: string,
  io: RunSessionJsonIo = {},
): Promise<RunSessionJsonResult> {
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  const metadata = await sessionStore.readSession(sessionId);
  if (!metadata) {
    const envelope = buildSessionNotFoundEnvelope(sessionId);
    write(`${JSON.stringify(envelope, null, 2)}\n`);
    return { found: false, envelope };
  }
  const paths = await sessionStore.getPaths(sessionId).catch(() => null);
  const { envelope, payload } = buildSessionJsonEnvelope(metadata, {
    sessionDir: paths?.dir,
    outputFile: paths?.log,
  });
  write(`${JSON.stringify(envelope, null, 2)}\n`);
  return { found: true, metadata, envelope, payload };
}
