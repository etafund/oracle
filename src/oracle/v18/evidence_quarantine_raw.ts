// Raw-capture quarantine for provider_result normalizer failures
// (oracle-v18-evidence-schema-parse-no-raw-quarantine-y00).
//
// When the chatgpt / gemini result normalizers throw during the
// `providerResultSchema.parse(draft)` step — typically because a
// DOM-shape drift made the draft inconsistent with the schema — the
// raw capture bundle is otherwise lost: callers only see a thrown
// ZodError, and the post-mortem path documented in AGENTS.md
// ("inspect the captured assistant turn via browser-tools.ts eval")
// only works if the browser is still open.
//
// This module persists the raw input bundle (evidence + capture +
// effort + access path + ids) to
// `<homeDir>/sessions/<sessionId>/quarantine/raw_capture/<id>.json`
// along with a `failure envelope` that records the zod issue paths
// (or any thrown error) so post-mortem auditors can reconstruct what
// the browser actually returned even when the run has ended.
//
// The write path is intentionally SYNCHRONOUS: the caller is about to
// re-throw, and async I/O could lose the race with process exit.

import fs from "node:fs";
import path from "node:path";

import { getOracleHomeDir } from "../../oracleHome.js";

const SESSIONS_DIRNAME = "sessions";
const EVIDENCE_DIRNAME = "evidence";
const QUARANTINE_DIRNAME = "quarantine";
const RAW_CAPTURE_DIRNAME = "raw_capture";

const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const TIMESTAMP_SANITIZE = /[^0-9a-zA-Z]+/g;

export interface QuarantineRawCaptureInput {
  /** Session id the run was executing under. Required for path scoping. */
  readonly sessionId: string;
  /** Oracle home directory; defaults to `getOracleHomeDir()`. */
  readonly homeDir?: string;
  /** Symbolic source — used in the failure envelope + filename prefix. */
  readonly source: "chatgpt-normalizer" | "gemini-normalizer";
  /** The error caught from buildXProviderResult (typically ZodError). */
  readonly error: unknown;
  /**
   * The original input bundle that failed normalization. Persisted
   * verbatim under `raw_input` in the envelope — auditors get the
   * literal capture bytes the normalizer was handed.
   */
  readonly rawInput: unknown;
  /**
   * Optional evidence id, used in the filename when available so the
   * quarantine record correlates with the rest of the evidence
   * ledger. When absent (or unsafe), the filename falls back to a
   * timestamp-only prefix.
   */
  readonly evidenceId?: string | null;
  /**
   * Optional ISO timestamp; injected by tests. Defaults to `new Date()`.
   */
  readonly now?: Date;
}

export interface QuarantineRawCaptureResult {
  /** Absolute path of the quarantine file written. */
  readonly path: string;
  /** The failure envelope persisted at `path` (for callers that want to log it). */
  readonly envelope: RawCaptureFailureEnvelope;
}

export interface RawCaptureFailureEnvelope {
  readonly schema_version: "browser_evidence_raw_capture_quarantine.v1";
  readonly captured_at: string;
  readonly source: QuarantineRawCaptureInput["source"];
  readonly session_id: string;
  readonly evidence_id: string | null;
  readonly failure: {
    readonly name: string;
    readonly message: string;
    readonly zod_issues: readonly { path: readonly (string | number)[]; message: string; code?: string }[] | null;
    readonly stack: string | null;
  };
  readonly raw_input: unknown;
}

function safeId(value: string | null | undefined): string | null {
  if (!value) return null;
  return SAFE_ID_PATTERN.test(value) && !value.includes("..") ? value : null;
}

function assertSafeSessionId(id: string): void {
  if (
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error(`Invalid session id: "${id}"`);
  }
}

function describeError(error: unknown): RawCaptureFailureEnvelope["failure"] {
  if (error && typeof error === "object") {
    const err = error as { name?: unknown; message?: unknown; issues?: unknown; stack?: unknown };
    const name = typeof err.name === "string" ? err.name : "Error";
    const message = typeof err.message === "string" ? err.message : String(error);
    const stack = typeof err.stack === "string" ? err.stack : null;
    const issues = Array.isArray(err.issues)
      ? (err.issues as unknown[]).map((entry) => {
          const issue = entry as { path?: unknown; message?: unknown; code?: unknown };
          return {
            path: Array.isArray(issue.path) ? (issue.path as (string | number)[]) : [],
            message: typeof issue.message === "string" ? issue.message : String(entry),
            ...(typeof issue.code === "string" ? { code: issue.code } : {}),
          };
        })
      : null;
    return { name, message, zod_issues: issues, stack };
  }
  return { name: "Error", message: String(error), zod_issues: null, stack: null };
}

/**
 * Write the raw capture bundle that failed normalization to the
 * session's quarantine area. SYNCHRONOUS — the caller is about to
 * re-throw, so we cannot wait on an event-loop turn.
 *
 * Returns the absolute path written and the envelope persisted.
 * Throws only if path inputs are malformed (e.g. unsafe sessionId);
 * filesystem errors are surfaced so the caller can surface them in
 * a structured way. Callers in error paths SHOULD wrap this in
 * their own try/catch (see `tryQuarantineRawCaptureSync`) to ensure
 * the original parse error is never masked by a write failure.
 */
export function quarantineRawCaptureSync(
  input: QuarantineRawCaptureInput,
): QuarantineRawCaptureResult {
  assertSafeSessionId(input.sessionId);
  const homeDir = input.homeDir ?? getOracleHomeDir();
  const now = input.now ?? new Date();
  const dir = path.join(
    homeDir,
    SESSIONS_DIRNAME,
    input.sessionId,
    EVIDENCE_DIRNAME,
    QUARANTINE_DIRNAME,
    RAW_CAPTURE_DIRNAME,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const evidenceId = safeId(input.evidenceId);
  const stamp = now.toISOString().replace(TIMESTAMP_SANITIZE, "");
  const baseName = evidenceId ? `${evidenceId}-${stamp}` : `${input.source}-${stamp}`;
  const filePath = path.join(dir, `${baseName}.json`);

  const envelope: RawCaptureFailureEnvelope = {
    schema_version: "browser_evidence_raw_capture_quarantine.v1",
    captured_at: now.toISOString(),
    source: input.source,
    session_id: input.sessionId,
    evidence_id: evidenceId,
    failure: describeError(input.error),
    raw_input: input.rawInput,
  };

  fs.writeFileSync(filePath, `${JSON.stringify(envelope, makeReplacer(), 2)}\n`, "utf8");
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best-effort */
    }
  }
  return { path: filePath, envelope };
}

/**
 * Best-effort wrapper that swallows filesystem errors so the caller's
 * original parse error is never masked. Returns null on quarantine
 * failure (caller should still re-throw the original error).
 */
export function tryQuarantineRawCaptureSync(
  input: QuarantineRawCaptureInput,
): QuarantineRawCaptureResult | null {
  try {
    return quarantineRawCaptureSync(input);
  } catch {
    return null;
  }
}

function makeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function replace(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") {
      return `[function ${(value as { name?: string }).name || "anonymous"}]`;
    }
    if (value && typeof value === "object") {
      if (seen.has(value as object)) return "[circular]";
      seen.add(value as object);
    }
    return value;
  };
}

