import {
  asOracleUserError,
  OracleTransportError,
  type OracleUserErrorCategory,
  type OracleUserErrorDetails,
} from "../oracle/errors.js";
import {
  classifyOracleErrorClass,
  isRetrySafeErrorClass,
  type OracleErrorClass,
} from "./exitCodes.js";
import type { TransportFailureReason } from "../oracle/types.js";
import { JSON_ENVELOPE_SCHEMA_VERSION, type JsonEnvelope } from "../oracle/v18/contracts.js";

/**
 * The closed set of normalized error codes the top-level `oracle --json` error
 * envelope emits for operational failures, instead of leaking the free-form
 * `OracleUserError.category` / `OracleTransportError.reason` strings (which no
 * documented enum listed). The first four mirror {@link OracleErrorClass} /
 * `ORACLE_EXIT_CODE_DICTIONARY` codes 3–6; the rest cover the remaining
 * transport/input failures. Stable lane/prompt `stage` codes (e.g.
 * `agent_lane_blocked`, `prompt_required`) and commander's `commander.*` codes
 * pass through unchanged — they are already closed, documented sets.
 */
export const TOP_LEVEL_ERROR_CODES = Object.freeze([
  "auth_required",
  "retryable_backoff",
  "timeout",
  "challenge_or_drift",
  "provider_error",
  "cancelled",
  "input_invalid",
  "browser_automation_failed",
  "run_error",
] as const);

const USER_ERROR_CATEGORY_CODES: Readonly<Record<OracleUserErrorCategory, string>> = Object.freeze({
  "file-validation": "input_invalid",
  "prompt-validation": "input_invalid",
  "browser-automation": "browser_automation_failed",
});

function stableTransportCode(reason: TransportFailureReason): string {
  switch (reason) {
    case "client-timeout":
    case "connection-lost":
      return "timeout";
    case "client-abort":
      return "cancelled";
    case "api-error":
    case "model-unavailable":
    case "unsupported-endpoint":
      return "provider_error";
    default:
      return "run_error";
  }
}

export interface TopLevelCliErrorEnvelope extends JsonEnvelope {
  status: "error";
  error: {
    code: string;
    message: string;
    help: string | null;
    details?: Record<string, unknown>;
  };
}

export interface TopLevelCliSuccessEnvelope extends JsonEnvelope {
  status: "success";
  data: {
    answer: string;
    model: string | null;
    session_id: string;
    usage: Record<string, unknown> | null;
    elapsed_ms: number | null;
  };
}

export interface BuildTopLevelCliSuccessEnvelopeInput {
  answer: string;
  model: string | null;
  sessionId: string;
  usage?: Record<string, unknown> | null;
  elapsedMs?: number | null;
  command: string;
  generatedAt?: string;
}

/**
 * Mirrors {@link buildTopLevelCliErrorEnvelope}'s json_envelope.v1 shape for the
 * success path, so `oracle --json` produces a structurally symmetric envelope
 * regardless of whether the run succeeded or failed.
 */
export function buildTopLevelCliSuccessEnvelope({
  answer,
  model,
  sessionId,
  usage = null,
  elapsedMs = null,
  command,
  generatedAt = new Date().toISOString(),
}: BuildTopLevelCliSuccessEnvelopeInput): TopLevelCliSuccessEnvelope {
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: true,
    status: "success",
    data: {
      answer,
      model,
      session_id: sessionId,
      usage,
      elapsed_ms: elapsedMs,
    },
    meta: {
      command,
      generated_at: generatedAt,
    },
    blocked_reason: null,
    next_command: null,
    fix_command: null,
    retry_safe: true,
    errors: [],
    warnings: [],
    commands: {},
  };
}

export interface BuildTopLevelCliErrorEnvelopeInput {
  error: unknown;
  command: string;
  exitCode: number;
  generatedAt?: string;
}

export function isJsonModeRequested(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--json");
}

export function buildTopLevelCliErrorEnvelope({
  error,
  command,
  exitCode,
  generatedAt = new Date().toISOString(),
}: BuildTopLevelCliErrorEnvelopeInput): TopLevelCliErrorEnvelope {
  const normalized = normalizeTopLevelError(error);
  const errorEntry: Record<string, unknown> = {
    error_code: normalized.code,
    message: normalized.message,
  };
  if (normalized.details) {
    errorEntry.details = normalized.details;
  }
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: false,
    status: "error",
    data: null,
    meta: {
      command,
      generated_at: generatedAt,
      exit_code: exitCode,
    },
    blocked_reason: normalized.code,
    next_command: normalized.nextCommand,
    fix_command: normalized.fixCommand,
    retry_safe: normalized.retrySafe,
    errors: [errorEntry],
    warnings: [],
    commands: {},
    error: {
      code: normalized.code,
      message: normalized.message,
      help: normalized.help,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };
}

export function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

interface NormalizedTopLevelError {
  code: string;
  message: string;
  help: string | null;
  details?: Record<string, unknown>;
  nextCommand: string | null;
  fixCommand: string | null;
  retrySafe: boolean;
}

function normalizeTopLevelError(error: unknown): NormalizedTopLevelError {
  const userError = asOracleUserError(error);
  const userDetails = userError?.details ? cleanDetails(userError.details) : undefined;
  const userStage = stringFromRecord(userDetails, "stage");
  const reuseProfileHint = stringFromRecord(userDetails, "reuseProfileHint");
  const detailNextCommand =
    stringFromRecord(userDetails, "next_command") ?? stringFromRecord(userDetails, "nextCommand");
  const detailFixCommand =
    stringFromRecord(userDetails, "fix_command") ?? stringFromRecord(userDetails, "fixCommand");

  if (userError) {
    const nextCommand = detailNextCommand ?? reuseProfileHint;
    const fixCommand = detailFixCommand ?? reuseProfileHint;
    const errorClass = classifyOracleErrorClass(userError);
    // A recognized recovery class (login/usage/challenge/timeout) wins so the
    // envelope code matches the exit code; otherwise keep the error's own
    // stable stage code (lane routes, prompt guards), and only as a last resort
    // fall back to the closed category code — never leak the free-form
    // `category` string as the machine-readable code.
    const code = errorClass ?? userStage ?? USER_ERROR_CATEGORY_CODES[userError.category];
    return {
      code,
      message: userError.message,
      help: fixCommand ?? nextCommand,
      details: withRawReason(userDetails, userError.category),
      nextCommand: nextCommand ?? null,
      fixCommand: fixCommand ?? null,
      retrySafe: errorClass ? isRetrySafeErrorClass(errorClass) : false,
    };
  }

  if (error instanceof OracleTransportError) {
    const errorClass: OracleErrorClass | null = classifyOracleErrorClass(error);
    return {
      code: errorClass ?? stableTransportCode(error.reason),
      message: error.message,
      help: null,
      details: { raw_reason: error.reason },
      nextCommand: null,
      fixCommand: null,
      retrySafe: errorClass
        ? isRetrySafeErrorClass(errorClass)
        : error.reason === "client-timeout" || error.reason === "connection-lost",
    };
  }

  const record = isRecord(error) ? error : undefined;
  const code = stringFromRecord(record, "code") ?? "top_level_error";
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const commanderHelp = code.startsWith("commander.") ? "Run `oracle --help` for usage." : null;
  return {
    code,
    message,
    help: commanderHelp,
    details: record ? { code } : undefined,
    nextCommand: commanderHelp ? "oracle --help" : null,
    fixCommand: null,
    retrySafe: false,
  };
}

/**
 * Preserve the original free-form category as `details.raw_reason` so a caller
 * that wants the pre-normalization value can still read it, while the top-level
 * `error_code` stays drawn from the closed {@link TOP_LEVEL_ERROR_CODES} set.
 */
function withRawReason(
  details: Record<string, unknown> | undefined,
  rawReason: string,
): Record<string, unknown> {
  const base = details ?? {};
  return base.raw_reason === undefined ? { ...base, raw_reason: rawReason } : base;
}

function cleanDetails(details: OracleUserErrorDetails): Record<string, unknown> {
  return Object.entries(details).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function stringFromRecord(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.keys(value)
    .sort(compareStrings)
    .reduce<Record<string, unknown>>((acc, key) => {
      const sortedValue = sortJsonValue(value[key]);
      if (sortedValue !== undefined) {
        acc[key] = sortedValue;
      }
      return acc;
    }, {});
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
