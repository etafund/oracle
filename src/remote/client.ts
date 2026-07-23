import http from "node:http";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import type { BrowserRunOptions } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment, SavedBrowserFile } from "../browser/types.js";
import type { BrowserSubmissionProvenance } from "../browser/types.js";
import {
  appendArtifacts,
  resolveSessionArtifactsDir,
  resolveUniqueArtifactPath,
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS,
  REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH,
  REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER,
  REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE,
  REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA,
  REMOTE_BROWSER_RECOVERY_PATH,
  REMOTE_BROWSER_RECOVERY_PROTOCOL,
  REMOTE_BROWSER_RUN_SCHEMA,
  REMOTE_BROWSER_RUN_PATH,
  REMOTE_SESSION_RECOVERY_STAGES,
  type RemoteBrowserRecoveryRequest,
  type RemoteBrowserRecoveryClaimLookupResponse,
  type RemoteArtifactDescriptor,
  type RemoteRunPayload,
  type RemoteRunEvent,
  type RemoteAttachmentPayload,
} from "./types.js";
import { parseHostPort } from "../bridge/connection.js";
import { computePromptSha256 } from "../browser/actions/captureBinding.js";
import {
  buildPromptRecoveryOwnershipPreview,
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../browser/promptDomMatch.js";
import { isGpt56SolModelLabel } from "../browser/actions/thinkingTime.js";
import {
  serializeRemoteBrowserRecoveryRequestForWire,
  serializeRemoteRunPayloadForWire,
} from "./payload_sanitize.js";
import { sanitizeRemoteRunRecoveryHint } from "./recovery.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { extractConversationIdFromUrl } from "../browser/conversationIdentity.js";
import type { BrowserRemoteRunProvenance } from "../sessionManager.js";
import { checkRemoteHealth } from "./health.js";
import {
  verifyAutoInlineToUploadFallback,
  verifyAutoUploadToInlineFallback,
} from "../browser/prompt.js";
import {
  MAX_DATA_TRANSFER_BYTES,
  readBoundedRegularFile,
} from "../browser/actions/attachmentDataTransfer.js";

const EXECUTABLE_RECOVERY_STAGE_SET: ReadonlySet<string> = new Set(REMOTE_SESSION_RECOVERY_STAGES);

interface RemoteExecutorOptions {
  host: string;
  token?: string;
  /**
   * Injectable HTTP request function — defaults to `http.request`.
   * Tests pass a stub here to avoid mocking the standard library,
   * which is brittle under ESM (`import http from "node:http"`
   * resolves to the default export, but `vi.mock` factories that
   * spread `actual` typically forget the `default` slot, leaving
   * `http.request` un-mocked at the call site).
   */
  requestFn?: typeof http.request;
  /**
   * Stream-inactivity deadline for the `/runs` NDJSON response: if no bytes
   * at all arrive for this long, the run is aborted with a typed,
   * non-retryable error instead of hanging forever on a silently-wedged
   * worker. Reset on every received chunk — this is an INACTIVITY deadline,
   * not a cap on total run duration, so a legitimate long Pro wait that
   * keeps emitting progress (heartbeat "still thinking" log lines,
   * artifact-progress events, ...) never trips it. Defaults to
   * `DEFAULT_STREAM_IDLE_TIMEOUT_MS` (or the `ORACLE_REMOTE_STREAM_IDLE_MS`
   * env override), which mirrors the server's own no-progress notion
   * (`wedgeAfterMs` / `ORACLE_SERVE_WEDGE_AFTER_MS`, see
   * src/remote/server.ts) so client and worker agree on what "wedged" means.
   */
  streamIdleTimeoutMs?: number;
  /**
   * Hard ceiling on a single buffered NDJSON line. The response stream is
   * newline-delimited; without a cap, a worker (or a corrupted/adversarial
   * intermediary) that never emits a newline would grow the line buffer
   * without bound. Defaults to `MAX_NDJSON_LINE_BYTES`, comfortably above
   * the largest legitimate single event (a `done` event carrying the full
   * answer text/markdown/html) while still bounded.
   */
  maxLineBytes?: number;
  /** Bounded out-of-band wait for a post-submit durable recovery claim. */
  recoveryClaimLookupTimeoutMs?: number;
  /** Poll interval for a claim that is authenticated but not bound yet. */
  recoveryClaimPollIntervalMs?: number;
}

/**
 * Default stream-inactivity deadline (see `RemoteExecutorOptions.streamIdleTimeoutMs`).
 * Mirrors the server's default `wedgeAfterMs` (src/remote/server.ts) so the
 * client's notion of "the worker went silent" agrees with the worker's own.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Default per-line NDJSON buffer cap (see `RemoteExecutorOptions.maxLineBytes`). */
export const MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RECOVERY_CLAIM_LOOKUP_TIMEOUT_MS = 90_000;
export const DEFAULT_RECOVERY_CLAIM_POLL_INTERVAL_MS = 500;
const MAX_RECOVERY_CLAIM_RESPONSE_BYTES = 64 * 1024;
const RECOVERY_CLAIM_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isCanonicalRecoveryClaimKey(value: unknown): value is string {
  if (typeof value !== "string" || !RECOVERY_CLAIM_KEY_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

function resolveDefaultStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.ORACLE_REMOTE_STREAM_IDLE_MS ?? "", 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * Typed terminal failure for a remote run. `errorClass` is one of the fleet's
 * typed retry classes; `retryable` states whether an AUTOMATIC retry is
 * permissible. Post-submit interruptions, integrity failures, and account
 * quarantine are never auto-retried (and never retried into another account):
 * the prompt may already have reached the account, so blind resubmission
 * risks duplicate submissions and cross-account contamination.
 */
export class RemoteRunFailedError extends Error {
  readonly errorClass: string | null;
  readonly retryable: boolean | null;

  constructor(
    message: string,
    options: { errorClass?: string | null; retryable?: boolean | null } = {},
  ) {
    super(message);
    this.name = "RemoteRunFailedError";
    this.errorClass = options.errorClass ?? null;
    this.retryable = options.retryable ?? null;
  }
}

/**
 * Internal marker for a bridge artifact download that stalled and was aborted
 * by its inactivity/overall deadline (see `downloadArtifactToFile`). Distinct
 * from ordinary content-transfer failures (size/sha/validation mismatches),
 * which remain non-fatal warnings: a STALLED transfer is a transport-level
 * hang and, once the answer has already been submitted, fails the run with a
 * typed post-submit error rather than resolving with a partial-artifact
 * warning or hanging forever.
 */
class ArtifactDownloadTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactDownloadTimeoutError";
  }
}

/**
 * Send-confirmation marker mirrored from the worker (src/remote/server.ts):
 * both submission paths (send-button click and Enter fallback) emit a
 * "Submitted prompt via ..." log line at dispatch time; "clicked send button"
 * is a defensive alias for older browser layers. The client tracks this so a
 * caller-gone abort can be classified before/after the account-safety
 * boundary (the ChatGPT submit moment, not /runs acceptance).
 */
const SUBMIT_CONFIRMATION_LOG_PATTERN = /submitted prompt|prompt submitted|clicked send button/i;

interface RemoteRouteIdentity {
  runId: string | null;
  accountId: string | null;
  laneId: string | null;
}

export interface RemoteBrowserRecoveryCarrier {
  recovery: RemoteBrowserRecoveryRequest["recovery"];
  accountId: string;
  laneId: string | null;
  /** Exact capability-bound submitted composer prefix; never render/log. */
  promptPreview: string;
  /** Opaque browser-derived full committed-turn digest; never derive from raw Markdown. */
  promptDomSha256: string;
}

export interface RemoteBrowserPendingRecoveryClaim {
  /** Opaque one-time authority minted before the worker touches the browser. */
  claimKey: string;
  originRunId: string;
  accountId: string;
  originLaneId: string;
  /** Exact canonical one-shot branches owned by the originating request. */
  promptCandidates: Array<{
    promptPreview: string;
    promptPreviewSha256: string;
  }>;
}

/** Nonsecret proof that a remote account accepted a run which did not finish. */
export interface RemoteBrowserFailedRoute {
  runId: string;
  accountId: string;
  laneId: string | null;
  terminalDoneOk: false;
  provenance: null;
}

const remoteRecoveryByError = new WeakMap<Error, RemoteBrowserRecoveryCarrier>();
const remoteFailedRouteByError = new WeakMap<Error, RemoteBrowserFailedRoute>();
const remotePendingRecoveryClaimByError = new WeakMap<Error, RemoteBrowserPendingRecoveryClaim>();

function walkErrorCauses<T>(error: unknown, read: (candidate: Error) => T | null): T | null {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    const value = read(current);
    if (value) return value;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

/** Capability-bearing recovery state is intentionally non-enumerable. */
export function getRemoteBrowserRecoveryFromError(
  error: unknown,
): RemoteBrowserRecoveryCarrier | null {
  return walkErrorCauses(error, (candidate) => remoteRecoveryByError.get(candidate) ?? null);
}

/**
 * Return only compact, nonsecret route evidence. This deliberately follows
 * Error.cause so a fail-closed submitted-session wrapper cannot erase the
 * originating account marker.
 */
export function getRemoteBrowserFailedRouteFromError(
  error: unknown,
): RemoteBrowserFailedRoute | null {
  return walkErrorCauses(error, (candidate) => remoteFailedRouteByError.get(candidate) ?? null);
}

/** Private pending authority is non-enumerable and never included in error text. */
export function getRemoteBrowserPendingRecoveryClaimFromError(
  error: unknown,
): RemoteBrowserPendingRecoveryClaim | null {
  return walkErrorCauses(
    error,
    (candidate) => remotePendingRecoveryClaimByError.get(candidate) ?? null,
  );
}

function failedRouteFromIdentity(
  route: RemoteRouteIdentity | null,
): RemoteBrowserFailedRoute | null {
  if (!route?.runId || !route.accountId) return null;
  return {
    runId: route.runId,
    accountId: route.accountId,
    laneId: route.laneId,
    terminalDoneOk: false,
    provenance: null,
  };
}

function sanitizeStrongRemoteSuccessProvenance(
  value: unknown,
  options: { requireModelProof?: boolean } = {},
): BrowserRemoteRunProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "modelVerified",
    "modelRequested",
    "modelResolved",
    "requestedModelLabel",
    "resolvedModelLabel",
    "modelLabelVerified",
    "requestedMode",
    "resolvedModeLabel",
    "modeVerified",
    "verifiedBeforePromptSubmit",
    "captureBindingVerified",
    "captureBindingQuality",
    "challengeClean",
    "submission",
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return null;
  // Both ordinary completion and capture-only recovery are accepted only with
  // the strongest structural proof: the captured assistant turn was paired to
  // the exact submitted user-message handle on the exact target Runtime, and
  // the account quarantine latch was authoritatively clean at finalization.
  if (
    raw.captureBindingVerified !== true ||
    raw.captureBindingQuality !== "message-handle" ||
    raw.challengeClean !== true
  ) {
    return null;
  }
  if (
    options.requireModelProof &&
    (raw.modelVerified !== true ||
      raw.modelLabelVerified !== true ||
      raw.modeVerified !== true ||
      raw.verifiedBeforePromptSubmit !== true ||
      typeof raw.requestedModelLabel !== "string" ||
      !isGpt56SolModelLabel(raw.requestedModelLabel) ||
      typeof raw.resolvedModelLabel !== "string" ||
      !isGpt56SolModelLabel(raw.resolvedModelLabel) ||
      typeof raw.requestedMode !== "string" ||
      raw.requestedMode.trim().toLowerCase() !== "pro" ||
      typeof raw.resolvedModeLabel !== "string" ||
      raw.resolvedModeLabel.trim().toLowerCase() !== "pro")
  ) {
    return null;
  }
  const nullableBoolean = (candidate: unknown): boolean | null =>
    typeof candidate === "boolean" ? candidate : null;
  const nullableString = (candidate: unknown): string | null =>
    typeof candidate === "string" && candidate.length <= 512 ? candidate : null;
  const quality = raw.captureBindingQuality;
  const submission = sanitizeBrowserSubmissionProvenance(raw.submission);
  if (submission === undefined) return null;
  return {
    modelVerified: nullableBoolean(raw.modelVerified),
    modelRequested: nullableString(raw.modelRequested),
    modelResolved: nullableString(raw.modelResolved),
    requestedModelLabel: nullableString(raw.requestedModelLabel),
    resolvedModelLabel: nullableString(raw.resolvedModelLabel),
    modelLabelVerified: nullableBoolean(raw.modelLabelVerified),
    requestedMode: nullableString(raw.requestedMode),
    resolvedModeLabel: nullableString(raw.resolvedModeLabel),
    modeVerified: nullableBoolean(raw.modeVerified),
    verifiedBeforePromptSubmit: nullableBoolean(raw.verifiedBeforePromptSubmit),
    captureBindingVerified: true,
    captureBindingQuality: quality,
    challengeClean: true,
    submission,
  };
}

function sanitizeBrowserSubmissionProvenance(
  value: unknown,
): BrowserSubmissionProvenance | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "primaryPromptSha256",
    "submittedPromptSha256",
    "primaryTransport",
    "submittedTransport",
    "fallbackUsed",
    "fallbackReason",
    "equivalenceAlgorithm",
    "equivalenceVerified",
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return undefined;
  const hash = (candidate: unknown): string | null =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate) ? candidate : null;
  const primaryPromptSha256 = hash(raw.primaryPromptSha256);
  const submittedPromptSha256 = hash(raw.submittedPromptSha256);
  const primaryTransport =
    raw.primaryTransport === "inline" || raw.primaryTransport === "upload"
      ? raw.primaryTransport
      : null;
  const submittedTransport =
    raw.submittedTransport === "inline" || raw.submittedTransport === "upload"
      ? raw.submittedTransport
      : null;
  const fallbackUsed = typeof raw.fallbackUsed === "boolean" ? raw.fallbackUsed : null;
  const fallbackReason =
    raw.fallbackReason === "auto-inline-too-large-to-upload" ||
    raw.fallbackReason === "auto-upload-timeout-to-inline"
      ? raw.fallbackReason
      : raw.fallbackReason === null
        ? null
        : undefined;
  if (
    !primaryPromptSha256 ||
    !submittedPromptSha256 ||
    !primaryTransport ||
    !submittedTransport ||
    fallbackUsed === null ||
    fallbackReason === undefined
  ) {
    return undefined;
  }
  if (!fallbackUsed) {
    if (
      fallbackReason !== null ||
      raw.equivalenceAlgorithm !== null ||
      raw.equivalenceVerified !== null ||
      primaryPromptSha256 !== submittedPromptSha256 ||
      primaryTransport !== submittedTransport
    ) {
      return undefined;
    }
  } else {
    const directionMatches =
      (fallbackReason === "auto-inline-too-large-to-upload" &&
        primaryTransport === "inline" &&
        submittedTransport === "upload") ||
      (fallbackReason === "auto-upload-timeout-to-inline" &&
        primaryTransport === "upload" &&
        submittedTransport === "inline");
    if (
      !directionMatches ||
      raw.equivalenceAlgorithm !== "oracle.browser-auto-fallback-exact.v2" ||
      raw.equivalenceVerified !== true
    ) {
      return undefined;
    }
  }
  return {
    primaryPromptSha256,
    submittedPromptSha256,
    primaryTransport,
    submittedTransport,
    fallbackUsed,
    fallbackReason,
    equivalenceAlgorithm: fallbackUsed ? "oracle.browser-auto-fallback-exact.v2" : null,
    equivalenceVerified: fallbackUsed ? true : null,
  };
}

function validateRemoteUploadIntegrity(
  value: unknown,
  submission: BrowserSubmissionProvenance,
  primary: RemoteAttachmentPayload[],
  fallback: RemoteAttachmentPayload[],
  exactFallbackArmed: boolean,
): boolean {
  if (!value) return primary.length === 0 && fallback.length === 0;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "attachments",
    "fallbackAttachments",
    "submittedBranch",
    "submittedTransport",
    "fallbackUsed",
    "fallbackReason",
    "preSendDomCheck",
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return false;

  const validateManifest = (candidate: unknown, expected: RemoteAttachmentPayload[]): boolean => {
    if (!Array.isArray(candidate) || candidate.length !== expected.length) return false;
    const storedNames = new Set<string>();
    return candidate.every((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      if (
        Object.keys(record).some(
          (key) => !["index", "originalName", "storedName", "bytes", "sha256"].includes(key),
        )
      ) {
        return false;
      }
      const expectedEntry = expected[index];
      if (!expectedEntry || typeof record.storedName !== "string" || !record.storedName) {
        return false;
      }
      if (storedNames.has(record.storedName)) return false;
      storedNames.add(record.storedName);
      const safeOriginalName =
        expectedEntry.fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "attachment";
      const expectedStoredName = `${String(index).padStart(3, "0")}-${expectedEntry.sha256.slice(0, 12)}-${safeOriginalName}`;
      return (
        record.index === index &&
        record.originalName === expectedEntry.fileName &&
        record.bytes === expectedEntry.sizeBytes &&
        record.sha256 === expectedEntry.sha256 &&
        record.storedName === (exactFallbackArmed ? expectedEntry.fileName : expectedStoredName)
      );
    });
  };

  if (!validateManifest(raw.attachments, primary)) return false;
  if (exactFallbackArmed) {
    if (!validateManifest(raw.fallbackAttachments, fallback)) return false;
  } else if (raw.fallbackAttachments !== undefined) {
    return false;
  }
  const expectedBranch = submission.fallbackUsed ? "fallback" : "primary";
  const selected = submission.fallbackUsed ? fallback : primary;
  if (submission.submittedTransport === "upload" && selected.length === 0) return false;
  if (submission.submittedTransport === "inline" && selected.length !== 0) return false;
  return (
    raw.submittedBranch === expectedBranch &&
    raw.submittedTransport === submission.submittedTransport &&
    raw.fallbackUsed === submission.fallbackUsed &&
    raw.fallbackReason === submission.fallbackReason &&
    raw.preSendDomCheck ===
      (submission.submittedTransport === "upload"
        ? "composer-chips-by-stored-name"
        : "not-applicable")
  );
}

/**
 * Read the neutral route labels stamped by `oracle serve` and preserved by the
 * router. Treat them as untrusted HTTP input: accept only the same compact
 * token alphabet as the worker and ignore duplicate/combined values.
 */
function readRemoteRouteIdentity(headers: http.IncomingHttpHeaders): RemoteRouteIdentity {
  const read = (name: string, maxLength: number): string | null => {
    const raw = headers[name];
    if (typeof raw !== "string" || raw.length > maxLength) return null;
    return /^[A-Za-z0-9._-]+$/.test(raw) ? raw : null;
  };
  return {
    runId: read("x-oracle-run-id", 128),
    accountId: read("x-oracle-account-id", 64),
    laneId: read("x-oracle-lane-id", 64),
  };
}

function hasCompatibleRemoteRecoveryResponseHeaders(headers: http.IncomingHttpHeaders): boolean {
  return Object.entries(REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES).every(
    ([name, expected]) => headers[name] === expected,
  );
}

function hasAuthenticatedVersionedRefusalIdentity(
  res: http.IncomingMessage,
  expectedAccountId?: string,
): boolean {
  if (!hasCompatibleRemoteRecoveryResponseHeaders(res.headers)) return false;
  const route = readRemoteRouteIdentity(res.headers);
  return Boolean(
    route.runId &&
    route.accountId &&
    route.laneId &&
    (expectedAccountId === undefined || route.accountId === expectedAccountId),
  );
}

function isCoherentRetryableRefusal(
  statusCode: number | undefined,
  refusal: { errorClass: string | null; retryable: boolean | null },
): boolean {
  return (
    refusal.retryable === true &&
    refusal.errorClass === "capacity_busy" &&
    (statusCode === 409 || statusCode === 503)
  );
}

function resolveRecoveryPromptOwnership(
  options: BrowserRunOptions,
  recovery: RemoteBrowserRecoveryRequest["recovery"],
): { promptPreview: string; promptDomSha256: string } | null {
  // The DOM digest is an opaque browser-worker proof. Raw Markdown cannot
  // reproduce rendered user-turn text reliably, so the client only requires
  // the signed v2 digest to be present and well formed; the destination
  // worker uses it for exact DOM ownership during capture-only reattach.
  if (!/^[a-f0-9]{64}$/.test(recovery.promptDomSha256)) return null;
  const candidates = [
    options.prompt,
    options.fallbackSubmission?.prompt,
    ...(options.followUpPrompts ?? []),
  ].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    const preview = buildPromptRecoveryOwnershipPreview(candidate);
    if (computePromptSha256(preview) === recovery.promptPreviewSha256) {
      return { promptPreview: preview, promptDomSha256: recovery.promptDomSha256 };
    }
  }
  return null;
}

function recoveryPromptPreviewCandidates(
  options: BrowserRunOptions,
): RemoteBrowserPendingRecoveryClaim["promptCandidates"] {
  const byHash = new Map<string, string>();
  for (const prompt of [options.prompt, options.fallbackSubmission?.prompt]) {
    if (typeof prompt !== "string") continue;
    const promptPreview = buildPromptRecoveryOwnershipPreview(prompt);
    byHash.set(computePromptSha256(promptPreview), promptPreview);
  }
  return [...byHash.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([promptPreviewSha256, promptPreview]) => ({
      promptPreview,
      promptPreviewSha256,
    }));
}

function resolveRecoveryPromptOwnershipFromCandidates(
  recovery: RemoteBrowserRecoveryRequest["recovery"],
  candidates: RemoteBrowserPendingRecoveryClaim["promptCandidates"],
): { promptPreview: string; promptDomSha256: string } | null {
  if (!/^[a-f0-9]{64}$/.test(recovery.promptDomSha256)) return null;
  const candidate = candidates.find(
    (entry) => entry.promptPreviewSha256 === recovery.promptPreviewSha256,
  );
  return candidate
    ? { promptPreview: candidate.promptPreview, promptDomSha256: recovery.promptDomSha256 }
    : null;
}

type RecoveryClaimLookupAttempt =
  | { status: "pending" }
  | { status: "not_found" }
  | { status: "ready"; carrier: RemoteBrowserRecoveryCarrier };

function lookupRemoteRecoveryClaimOnce(params: {
  hostname: string;
  port: number;
  token?: string;
  requestFn: typeof http.request;
  routeIdentity: RemoteRouteIdentity;
  claimKey: string;
  promptCandidates: RemoteBrowserPendingRecoveryClaim["promptCandidates"];
  timeoutMs: number;
}): Promise<RecoveryClaimLookupAttempt> {
  return new Promise((resolve, reject) => {
    const route = params.routeIdentity;
    if (!route.runId || !route.accountId || !route.laneId) {
      reject(new Error("Recovery claim lookup is missing its accepted run/account identity."));
      return;
    }
    const originRunId = route.runId;
    const accountId = route.accountId;
    const originLaneId = route.laneId;
    const req = params.requestFn(
      {
        hostname: params.hostname,
        port: params.port,
        path: REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH,
        method: "GET",
        headers: {
          accept: "application/json",
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey]: params.claimKey,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.accountId]: accountId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originRunId]: originRunId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId]: originLaneId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.promptPreviewSha256]: params.promptCandidates
            .map((candidate) => candidate.promptPreviewSha256)
            .join(","),
          ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += bytes.length;
          if (received > MAX_RECOVERY_CLAIM_RESPONSE_BYTES) {
            reject(new Error("Recovery claim response exceeded its bounded size."));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(bytes);
        });
        res.on("error", reject);
        res.on("end", () => {
          const responseRoute = readRemoteRouteIdentity(res.headers);
          const responseOriginProofLaneId =
            res.headers[REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId];
          const authenticatedRoute =
            hasCompatibleRemoteRecoveryResponseHeaders(res.headers) &&
            res.headers[REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER] ===
              REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE &&
            responseRoute.runId === originRunId &&
            responseRoute.accountId === accountId &&
            responseRoute.laneId !== null &&
            responseOriginProofLaneId === originLaneId;
          if (res.statusCode === 404 || res.statusCode === 410) {
            if (!authenticatedRoute) {
              reject(
                new Error(
                  `Recovery claim not-found response lacked its authenticated ${REMOTE_BROWSER_RECOVERY_PROTOCOL} route identity.`,
                ),
              );
              return;
            }
            resolve({ status: "not_found" });
            return;
          }
          if (res.statusCode === 425) {
            if (!authenticatedRoute) {
              reject(new Error("Pending recovery claim lacked its authenticated route identity."));
              return;
            }
            resolve({ status: "pending" });
            return;
          }
          if (res.statusCode !== 200 || !authenticatedRoute) {
            reject(
              new Error("Recovery claim lookup returned an unauthenticated or invalid response."),
            );
            return;
          }
          const contentType = res.headers["content-type"];
          if (
            typeof contentType !== "string" ||
            !/^application\/json(?:\s*;|$)/i.test(contentType)
          ) {
            reject(new Error("Recovery claim lookup response was not application/json."));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new Error("Recovery claim lookup response was not valid JSON."));
            return;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            reject(new Error("Recovery claim lookup response was not an object."));
            return;
          }
          const raw = parsed as Record<string, unknown>;
          const allowedKeys = new Set([
            "schema",
            "status",
            "originRunId",
            "originLaneId",
            "recovery",
          ]);
          if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
            reject(new Error("Recovery claim lookup response contained unsupported fields."));
            return;
          }
          const recovery = sanitizeRemoteRunRecoveryHint(raw.recovery);
          const responseOriginLaneId = raw.originLaneId;
          if (
            raw.schema !== REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA ||
            raw.status !== "ready" ||
            raw.originRunId !== originRunId ||
            responseOriginLaneId !== originLaneId ||
            !recovery ||
            recovery.originRunId !== originRunId ||
            !EXECUTABLE_RECOVERY_STAGE_SET.has(recovery.stage)
          ) {
            reject(new Error("Recovery claim lookup response failed strict validation."));
            return;
          }
          const ownership = resolveRecoveryPromptOwnershipFromCandidates(
            {
              ...recovery,
              stage: recovery.stage as RemoteBrowserRecoveryRequest["recovery"]["stage"],
            },
            params.promptCandidates,
          );
          if (!ownership) {
            reject(new Error("Recovery claim did not match any prompt owned by the original run."));
            return;
          }
          const response = raw as unknown as RemoteBrowserRecoveryClaimLookupResponse;
          resolve({
            status: "ready",
            carrier: {
              recovery: response.recovery,
              accountId,
              laneId: response.originLaneId,
              promptPreview: ownership.promptPreview,
              promptDomSha256: ownership.promptDomSha256,
            },
          });
        });
      },
    );
    req.on("error", reject);
    if (typeof req.setTimeout === "function") {
      req.setTimeout(params.timeoutMs, () => {
        reject(new Error("Recovery claim lookup timed out."));
        req.destroy();
      });
    }
    req.end();
  });
}

async function lookupRemoteRecoveryClaim(params: {
  hostname: string;
  port: number;
  token?: string;
  requestFn: typeof http.request;
  routeIdentity: RemoteRouteIdentity;
  claimKey: string;
  promptCandidates: RemoteBrowserPendingRecoveryClaim["promptCandidates"];
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<RemoteBrowserRecoveryCarrier | null> {
  if (!isCanonicalRecoveryClaimKey(params.claimKey)) return null;
  if (params.timeoutMs <= 0) return null;
  if (params.promptCandidates.length === 0) return null;
  const deadline = Date.now() + Math.max(0, params.timeoutMs);
  do {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const attempt = await lookupRemoteRecoveryClaimOnce({
        ...params,
        timeoutMs: Math.min(5_000, remaining),
      });
      if (attempt.status === "ready") return attempt.carrier;
      if (attempt.status === "not_found") return null;
    } catch {
      // A transient router/worker cut is precisely why this out-of-band path
      // exists. Retry only inside the caller's strict overall lookup budget.
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, Math.min(params.pollIntervalMs, Math.max(1, deadline - Date.now()))),
    );
  } while (Date.now() < deadline);
  return null;
}

export function sanitizeRemoteBrowserPendingRecoveryClaim(
  value: unknown,
): RemoteBrowserPendingRecoveryClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "claimKey",
    "originRunId",
    "accountId",
    "originLaneId",
    "promptCandidates",
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return null;
  const claimKey = raw.claimKey;
  const originRunId = raw.originRunId;
  const accountId = raw.accountId;
  const originLaneId = raw.originLaneId;
  if (
    !isCanonicalRecoveryClaimKey(claimKey) ||
    typeof originRunId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(originRunId) ||
    typeof accountId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(accountId) ||
    typeof originLaneId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(originLaneId) ||
    !Array.isArray(raw.promptCandidates) ||
    raw.promptCandidates.length < 1 ||
    raw.promptCandidates.length > 2
  ) {
    return null;
  }
  const promptCandidates: RemoteBrowserPendingRecoveryClaim["promptCandidates"] = [];
  for (const candidate of raw.promptCandidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const entry = candidate as Record<string, unknown>;
    if (
      Object.keys(entry).some((key) => key !== "promptPreview" && key !== "promptPreviewSha256") ||
      typeof entry.promptPreview !== "string" ||
      !entry.promptPreview.trim() ||
      entry.promptPreview.length > 160 ||
      typeof entry.promptPreviewSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.promptPreviewSha256) ||
      computePromptSha256(entry.promptPreview) !== entry.promptPreviewSha256
    ) {
      return null;
    }
    promptCandidates.push({
      promptPreview: entry.promptPreview,
      promptPreviewSha256: entry.promptPreviewSha256,
    });
  }
  const hashes = promptCandidates.map((candidate) => candidate.promptPreviewSha256);
  if (new Set(hashes).size !== hashes.length || hashes.join(",") !== [...hashes].sort().join(",")) {
    return null;
  }
  return { claimKey, originRunId, accountId, originLaneId, promptCandidates };
}

/** Resolve a previously persisted pending authority using GET only; never submits a prompt. */
export async function resolveRemoteBrowserPendingRecoveryClaim(params: {
  host: string;
  token?: string;
  claim: RemoteBrowserPendingRecoveryClaim;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestFn?: typeof http.request;
}): Promise<RemoteBrowserRecoveryCarrier | null> {
  const claim = sanitizeRemoteBrowserPendingRecoveryClaim(params.claim);
  if (!claim) return null;
  const { hostname, port } = parseHost(params.host);
  return await lookupRemoteRecoveryClaim({
    hostname,
    port,
    token: params.token,
    requestFn: params.requestFn ?? http.request,
    routeIdentity: {
      runId: claim.originRunId,
      accountId: claim.accountId,
      laneId: claim.originLaneId,
    },
    claimKey: claim.claimKey,
    promptCandidates: claim.promptCandidates,
    timeoutMs: params.timeoutMs ?? DEFAULT_RECOVERY_CLAIM_LOOKUP_TIMEOUT_MS,
    pollIntervalMs: params.pollIntervalMs ?? DEFAULT_RECOVERY_CLAIM_POLL_INTERVAL_MS,
  });
}

async function assertRemoteWorkerRecoveryCompatibility(params: {
  host: string;
  token?: string;
  requestFn: typeof http.request;
}): Promise<void> {
  const health = await checkRemoteHealth({
    host: params.host,
    token: params.token,
    timeoutMs: 5_000,
    requestFn: params.requestFn,
    probeRunAvailability: false,
  });
  const authenticated = health.ok || health.busy === true;
  if (!authenticated) {
    const authFailure = health.statusCode === 401 || health.statusCode === 403;
    throw new RemoteRunFailedError(
      `Remote browser protocol preflight failed before run admission: ${health.error ?? `HTTP ${health.statusCode ?? "unknown"}`}.`,
      {
        errorClass: authFailure ? "integrity_ui_unknown" : "transport_interrupted_before_submit",
        retryable: !authFailure,
      },
    );
  }
  const compatibility = health.browserRecoveryCompatibility;
  if (!compatibility?.compatible) {
    const observed = [
      compatibility?.protocol ?? "missing protocol",
      compatibility?.promptPreviewAlgorithm ?? "missing prompt-preview algorithm",
      compatibility?.promptDomIdentityAlgorithm ?? "missing DOM-identity algorithm",
      compatibility?.durableClaimLookup === true
        ? "durable claim lookup"
        : "missing durable claim lookup",
    ].join(", ");
    throw new RemoteRunFailedError(
      `Remote browser worker recovery protocol is incompatible (${observed}). Expected ` +
        `${REMOTE_BROWSER_RECOVERY_PROTOCOL}, ${PROMPT_RECOVERY_PREVIEW_ALGORITHM}, and ` +
        `${PROMPT_DOM_IDENTITY_ALGORITHM}; upgrade the client and worker before starting a run.`,
      { errorClass: "integrity_ui_unknown", retryable: false },
    );
  }
  const { hostname, port } = parseHost(params.host);
  await new Promise<void>((resolve, reject) => {
    const req = params.requestFn(
      {
        hostname,
        port,
        path: REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH,
        method: "OPTIONS",
        headers: {
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
        },
      },
      (res) => {
        if (typeof req.setTimeout === "function") req.setTimeout(0);
        res.resume();
        res.once("end", () => {
          if (
            res.statusCode === 204 &&
            hasCompatibleRemoteRecoveryResponseHeaders(res.headers) &&
            res.headers[REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER] ===
              REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE
          ) {
            resolve();
            return;
          }
          reject(
            new RemoteRunFailedError(
              `Remote recovery-claim route probe failed; the router and worker fleet must expose the authenticated ${REMOTE_BROWSER_RECOVERY_PROTOCOL} lookup path before any prompt is submitted.`,
              { errorClass: "integrity_ui_unknown", retryable: false },
            ),
          );
        });
      },
    );
    req.once("error", (error) =>
      reject(
        new RemoteRunFailedError(
          `Remote recovery-claim route probe failed before submit (${error.message}).`,
          { errorClass: "transport_interrupted_before_submit", retryable: true },
        ),
      ),
    );
    if (typeof req.setTimeout === "function") {
      req.setTimeout(5_000, () => {
        reject(
          new RemoteRunFailedError("Remote recovery-claim route probe timed out before submit.", {
            errorClass: "transport_interrupted_before_submit",
            retryable: true,
          }),
        );
        req.destroy();
      });
    }
    req.end();
  });
}

export function createRemoteBrowserExecutor({
  host,
  token,
  requestFn = http.request,
  streamIdleTimeoutMs = resolveDefaultStreamIdleTimeoutMs(),
  maxLineBytes = MAX_NDJSON_LINE_BYTES,
  recoveryClaimLookupTimeoutMs = DEFAULT_RECOVERY_CLAIM_LOOKUP_TIMEOUT_MS,
  recoveryClaimPollIntervalMs = DEFAULT_RECOVERY_CLAIM_POLL_INTERVAL_MS,
}: RemoteExecutorOptions) {
  // A successful capability probe is reusable for this executor. Every POST
  // still carries the exact contract headers, so a worker restarted or
  // downgraded after the probe remains authoritatively fail-closed.
  let compatibilityPreflight: Promise<void> | null = null;
  const ensureCompatibleWorker = (): Promise<void> => {
    // `requestFn` is an internal transport-injection seam used by unit tests
    // that capture serialization without implementing an HTTP service. Real
    // CLI/MCP execution always uses `http.request` and therefore always runs
    // the authenticated /health preflight. The POST headers below remain
    // unconditional for both paths.
    if (requestFn !== http.request) return Promise.resolve();
    if (compatibilityPreflight) return compatibilityPreflight;
    const pending = assertRemoteWorkerRecoveryCompatibility({ host, token, requestFn }).catch(
      (error) => {
        if (compatibilityPreflight === pending) compatibilityPreflight = null;
        throw error;
      },
    );
    compatibilityPreflight = pending;
    return pending;
  };
  // Return a drop-in replacement for runBrowserMode so the browser session runner can stay unchanged.
  return async function remoteBrowserExecutor(
    options: BrowserRunOptions,
  ): Promise<BrowserRunResult> {
    const log = options.log ?? (() => {});
    const signal = options.signal;
    if (signal?.aborted) {
      // Caller already gone before any work: fail fast without reading
      // attachment files or opening a connection to the worker.
      throw new RemoteRunFailedError("Caller aborted before submit; aborting the remote run.", {
        errorClass: "transport_interrupted_before_submit",
        retryable: true,
      });
    }
    // FLEET-BOUND MODEL GATE (defense-in-depth; the worker is authoritative).
    // This executor is instantiated ONLY behind a resolved remote host
    // (src/mcp/tools/consult.ts and bin/oracle-cli.ts wire it exclusively for
    // fleet runs), so every request here is fleet-bound. The browser fleet
    // serves ONLY GPT-5.6 Sol + Pro. Legacy absent/bare-Pro selection is
    // canonicalized to the exact protected label below; every other explicit
    // label is rejected before attachment I/O or a network connection.
    const desiredModelLabel = options.config?.desiredModel;
    if (
      desiredModelLabel !== undefined &&
      desiredModelLabel !== null &&
      (typeof desiredModelLabel !== "string" || desiredModelLabel.trim().length === 0)
    ) {
      throw new RemoteRunFailedError(
        "this browser worker requires a valid GPT-5.6 Sol model label.",
        { errorClass: "model_not_allowed", retryable: false },
      );
    }
    if (
      typeof desiredModelLabel === "string" &&
      desiredModelLabel.trim().length > 0 &&
      desiredModelLabel.trim().toLowerCase() !== "pro" &&
      !isGpt56SolModelLabel(desiredModelLabel)
    ) {
      throw new RemoteRunFailedError(
        `this browser worker serves only GPT-5.6 Sol + Pro; requested model label "${desiredModelLabel}" is not allowed. Drop --model (the default resolves to GPT-5.6 Sol) or use --engine api for API models.`,
        { errorClass: "model_not_allowed", retryable: false },
      );
    }
    const requestedModelStrategy = options.config?.modelStrategy as unknown;
    if (
      requestedModelStrategy !== undefined &&
      (typeof requestedModelStrategy !== "string" ||
        requestedModelStrategy.trim().toLowerCase() !== "select")
    ) {
      throw new RemoteRunFailedError(
        'this browser worker requires modelStrategy "select" for atomic model and Pro-mode verification.',
        { errorClass: "model_strategy_not_allowed", retryable: false },
      );
    }
    const requestedThinkingTime = options.config?.thinkingTime as unknown;
    if (requestedThinkingTime !== undefined && requestedThinkingTime !== "extended") {
      throw new RemoteRunFailedError(
        'this browser worker requires thinkingTime "extended" so GPT-5.6 Sol + Pro is verified before submit.',
        { errorClass: "model_mode_not_allowed", retryable: false },
      );
    }
    const fleetBrowserConfig = {
      ...(options.config ?? {}),
      desiredModel: "GPT-5.6 Sol",
      modelStrategy: "select" as const,
      thinkingTime: "extended" as const,
    };
    const primaryPrompt = options.prompt.trim();
    const serializedAttachments = await serializeAttachments(options.attachments ?? []);
    let fallbackSubmission = options.fallbackSubmission;
    let serializedFallbackAttachments = fallbackSubmission
      ? await serializeAttachments(fallbackSubmission.attachments ?? [])
      : [];
    const fallbackAuthorization = fallbackSubmission?.authorization;
    const fallbackPolicyEligible = Boolean(
      fallbackAuthorization?.attachmentsPolicy === "auto" &&
      fallbackAuthorization.bundleRequested === false &&
      fallbackAuthorization.model === "gpt-5.6-sol" &&
      Number.isSafeInteger(fallbackAuthorization.maxInputTokens) &&
      fallbackAuthorization.maxInputTokens > 0 &&
      [...serializedAttachments, ...serializedFallbackAttachments].every(
        (attachment) =>
          attachment.generatedBundle === false && attachment.fileName === attachment.displayPath,
      ),
    );
    const safeAutoUploadToInlineFallback = Boolean(
      fallbackPolicyEligible &&
      fallbackSubmission?.reason === "auto-upload-timeout-to-inline" &&
      fallbackSubmission.attachments.length === 0 &&
      verifyAutoUploadToInlineFallback({
        primaryPrompt,
        fallbackPrompt: fallbackSubmission.prompt,
        attachments: serializedAttachments.map((attachment) => ({
          displayPath: attachment.displayPath,
          content: Buffer.from(attachment.contentBase64, "base64"),
        })),
      }),
    );
    const safeAutoInlineToUploadFallback = Boolean(
      fallbackPolicyEligible &&
      fallbackSubmission?.reason === "auto-inline-too-large-to-upload" &&
      serializedAttachments.length === 0 &&
      serializedFallbackAttachments.length > 0 &&
      verifyAutoInlineToUploadFallback({
        primaryPrompt,
        fallbackPrompt: fallbackSubmission.prompt,
        attachments: serializedFallbackAttachments.map((attachment) => ({
          displayPath: attachment.displayPath,
          content: Buffer.from(attachment.contentBase64, "base64"),
        })),
      }),
    );
    const safeAutoFallback = safeAutoUploadToInlineFallback || safeAutoInlineToUploadFallback;
    if (fallbackSubmission && !safeAutoFallback) {
      // Fleet fallback is executable only when the client can prove the exact
      // bounded representation in the declared direction. The worker repeats
      // this proof authoritatively before it stages files or touches Chrome.
      log(
        "[remote] Refusing to arm an unverifiable prompt fallback; submitting the primary prompt only.",
      );
      fallbackSubmission = undefined;
      serializedFallbackAttachments = [];
    } else if (fallbackSubmission) {
      log(
        `[remote] Exact pre-dispatch ${fallbackSubmission.reason} fallback armed; the worker will independently verify equivalence before browser admission. ` +
          `primary prompt sha256 ${computePromptSha256(primaryPrompt)}; fallback prompt sha256 ${computePromptSha256(fallbackSubmission.prompt)}`,
      );
    }
    const payload: RemoteRunPayload = {
      schema: REMOTE_BROWSER_RUN_SCHEMA,
      prompt: primaryPrompt,
      attachments: serializedAttachments,
      fallbackSubmission: fallbackSubmission
        ? {
            prompt: fallbackSubmission.prompt,
            attachments: serializedFallbackAttachments,
          }
        : undefined,
      fallbackPolicy: fallbackSubmission
        ? {
            attachmentsPolicy: "auto",
            bundleRequested: false,
            model: "gpt-5.6-sol",
            maxInputTokens: fallbackAuthorization!.maxInputTokens,
          }
        : undefined,
      browserConfig: fleetBrowserConfig,
      options: {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        verbose: options.verbose,
        sessionId: options.sessionId,
        followUpPrompts: options.followUpPrompts,
      },
    };

    const body = Buffer.from(serializeRemoteRunPayloadForWire(payload));
    const { hostname, port } = parseHost(host);
    await ensureCompatibleWorker();
    if (signal?.aborted) {
      throw new RemoteRunFailedError("Caller aborted before the remote run request was sent.", {
        errorClass: "transport_interrupted_before_submit",
        retryable: true,
      });
    }

    return new Promise<BrowserRunResult>((resolve, reject) => {
      const transferredFiles: SavedBrowserFile[] = [];
      const transferFailures: string[] = [];
      const transferPromises: Promise<void>[] = [];
      // Shared byte-progress accumulator across every bridge artifact download,
      // bumped as bytes stream through each download's size limiter. The
      // post-stream overall-transfer deadline (see `res.on("end")` below) is
      // PROGRESS-AWARE: it resets whenever this advances, so a healthy,
      // actively-streaming large artifact (e.g. a deep-research ZIP over a slow
      // link) is never aborted by a fixed wall-clock cap while bytes are still
      // flowing — only a genuinely wedged transfer (no bytes for a full idle
      // window) trips it.
      const transferProgress = { bytes: 0 };
      let artifactTransferQueue = Promise.resolve();
      let settled = false;
      let resolved: BrowserRunResult | null = null;
      // Success is defined by the terminal done event and nothing else: a
      // stream that ends without one (crash, truncation, proxy cut) must
      // never be treated as a completed run.
      let doneObserved = false;
      // Stream-inactivity watchdog for the /runs response (see
      // `streamIdleTimeoutMs` doc): armed once the 200 response begins, reset
      // on every chunk, cleared once the stream ends or the run settles.
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      // Whether the worker's send-confirmation log line has been observed
      // (see SUBMIT_CONFIRMATION_LOG_PATTERN): decides the typed transport
      // class (before/after submit) for a caller-gone abort.
      let submitObserved = false;
      let acceptedRouteIdentity: RemoteRouteIdentity | null = null;
      let acceptedRecoveryClaimKey: string | null = null;
      let acceptedPendingRecoveryClaim: RemoteBrowserPendingRecoveryClaim | null = null;
      // Live 200 response, if the stream has started — destroyed alongside
      // the request on caller-gone abort. Registered abort-listener removal
      // runs whenever the run settles (success or failure).
      let activeRes: http.IncomingMessage | null = null;
      let removeAbortListener: (() => void) | null = null;
      // Whether the /runs response headers have been received. The per-chunk
      // idle watchdog (armIdleTimer) only arms after headers arrive, so the
      // pre-header window is covered by a separate request-level timeout that
      // this flag disarms once the 200 (or any) response begins.
      let headersReceived = false;
      let requestBodyStarted = false;

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const cleanup = () => {
        clearIdleTimer();
        if (removeAbortListener) {
          removeAbortListener();
          removeAbortListener = null;
        }
      };

      const fail = (error: Error) => {
        if (settled) return;
        // A fully identified accepted 200 route is enough to fail closed: a
        // proxy cut can hide the submit-confirmation line even though the
        // account already received the prompt. Persist nonsecret ownership
        // whenever that accepted route later fails, even without a capability.
        const failedRoute = failedRouteFromIdentity(acceptedRouteIdentity);
        if (failedRoute) remoteFailedRouteByError.set(error, failedRoute);
        if (acceptedPendingRecoveryClaim) {
          remotePendingRecoveryClaimByError.set(error, acceptedPendingRecoveryClaim);
        }
        settled = true;
        cleanup();
        void (async () => {
          if (
            error instanceof RemoteRunFailedError &&
            error.errorClass === "transport_interrupted_after_submit" &&
            acceptedRouteIdentity?.runId &&
            acceptedRouteIdentity.accountId &&
            acceptedRecoveryClaimKey &&
            !signal?.aborted &&
            !remoteRecoveryByError.has(error)
          ) {
            const carrier = await lookupRemoteRecoveryClaim({
              hostname,
              port,
              token,
              requestFn,
              routeIdentity: acceptedRouteIdentity,
              claimKey: acceptedRecoveryClaimKey,
              promptCandidates: acceptedPendingRecoveryClaim?.promptCandidates ?? [],
              timeoutMs: recoveryClaimLookupTimeoutMs,
              pollIntervalMs: recoveryClaimPollIntervalMs,
            });
            if (carrier) remoteRecoveryByError.set(error, carrier);
          }
          reject(error);
        })().catch(() => reject(error));
      };

      const req = requestFn(
        {
          hostname,
          port,
          path: REMOTE_BROWSER_RUN_PATH,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          activeRes = res;
          headersReceived = true;
          // Response has begun: hand inactivity duty to the per-chunk idle
          // watchdog below and disable the pre-header request-level timeout so
          // it cannot fire during a legitimate long-but-active stream.
          if (typeof req.setTimeout === "function") {
            req.setTimeout(0);
          }
          if (res.statusCode !== 200) {
            const trustedRefusal = hasAuthenticatedVersionedRefusalIdentity(res);
            collectRefusal(res, { inactivityTimeoutMs: streamIdleTimeoutMs })
              .then((refusal) =>
                fail(
                  trustedRefusal
                    ? new RemoteRunFailedError(refusal.message, {
                        errorClass: refusal.errorClass,
                        retryable: isCoherentRetryableRefusal(res.statusCode, refusal),
                      })
                    : new RemoteRunFailedError(
                        `Remote refusal lacked the exact authenticated ${REMOTE_BROWSER_RECOVERY_PROTOCOL} protocol and route identity; refusing to trust its retry advice.`,
                        { errorClass: "integrity_ui_unknown", retryable: false },
                      ),
                ),
              )
              .catch(fail);
            return;
          }
          const contentType = res.headers["content-type"];
          if (
            typeof contentType !== "string" ||
            !/^application\/x-ndjson(?:\s*;|$)/i.test(contentType)
          ) {
            fail(
              new RemoteRunFailedError(
                "Remote run response had an invalid content type; expected application/x-ndjson.",
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            req.destroy();
            res.destroy();
            return;
          }
          const routeIdentity = readRemoteRouteIdentity(res.headers);
          acceptedRouteIdentity = routeIdentity;
          if (!hasCompatibleRemoteRecoveryResponseHeaders(res.headers)) {
            fail(
              new RemoteRunFailedError(
                "Remote worker accepted the run without echoing the exact browser recovery protocol contract; refusing a mixed-version route before waiting for browser execution.",
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            req.destroy();
            res.destroy();
            return;
          }
          if (!routeIdentity.runId || !routeIdentity.accountId || !routeIdentity.laneId) {
            fail(
              new RemoteRunFailedError(
                "Versioned remote run response omitted a valid run/account/lane identity; refusing an unowned route.",
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            req.destroy();
            res.destroy();
            return;
          }
          const recoveryClaimKey = res.headers[REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey];
          const durableClaimRequired = (options.followUpPrompts?.length ?? 0) === 0;
          if (durableClaimRequired && !isCanonicalRecoveryClaimKey(recoveryClaimKey)) {
            fail(
              new RemoteRunFailedError(
                "Remote worker accepted the run without a valid durable recovery-claim key; refusing a stream that could become unrecoverable after submission.",
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            req.destroy();
            res.destroy();
            return;
          }
          acceptedRecoveryClaimKey = isCanonicalRecoveryClaimKey(recoveryClaimKey)
            ? recoveryClaimKey
            : null;
          const promptCandidates = recoveryPromptPreviewCandidates(options);
          if (acceptedRecoveryClaimKey && promptCandidates.length > 0) {
            acceptedPendingRecoveryClaim = {
              claimKey: acceptedRecoveryClaimKey,
              originRunId: routeIdentity.runId,
              accountId: routeIdentity.accountId,
              originLaneId: routeIdentity.laneId,
              promptCandidates,
            };
          }
          if (routeIdentity.runId || routeIdentity.accountId || routeIdentity.laneId) {
            log(
              `[remote] Accepted run route: run=${routeIdentity.runId ?? "unknown"} ` +
                `account=${routeIdentity.accountId ?? "unknown"} lane=${routeIdentity.laneId ?? "unknown"}.`,
            );
          }
          res.setEncoding("utf8");
          // Incremental NDJSON splitter (perf-io-remote#0): accumulate the
          // trailing partial line as a list of chunks and scan only each newly
          // arrived chunk for a newline, so building an N-byte answer (the
          // terminal `done` event carrying the full answer, legitimately split
          // across many TCP chunks) costs O(N) rather than O(N^2). A completed
          // line joins the pending chunks exactly once; the pending list is
          // never re-scanned or re-sliced per chunk.
          const pendingChunks: string[] = [];
          let pendingLength = 0;
          // Arm the inactivity watchdog as soon as the 200 response begins —
          // a worker that accepts the connection, sends headers, and then
          // never emits a single byte must not pin the caller forever.
          const armIdleTimer = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              if (settled) return;
              const idleError = new RemoteRunFailedError(
                `Remote run stream received no data for over ${streamIdleTimeoutMs}ms; aborting rather ` +
                  "than waiting indefinitely on a possibly-wedged worker. This is an inactivity deadline " +
                  "(reset on every received byte), not a cap on total run duration, so a normal slow-but-active " +
                  "Pro run is unaffected.",
                { errorClass: "transport_interrupted_after_submit", retryable: false },
              );
              fail(idleError);
              req.destroy();
              res.destroy();
            }, streamIdleTimeoutMs);
          };
          armIdleTimer();
          const processLine = (line: string) => {
            if (doneObserved) {
              fail(
                new RemoteRunFailedError("Remote run emitted data after its terminal done event.", {
                  errorClass: "integrity_ui_unknown",
                  retryable: false,
                }),
              );
              req.destroy();
              res.destroy();
              return;
            }
            const transferPromise = handleEvent({
              line,
              options,
              armedFallback: fallbackSubmission,
              expectedPrimaryAttachments: serializedAttachments,
              expectedFallbackAttachments: serializedFallbackAttachments,
              hostname,
              port,
              token,
              artifactInactivityTimeoutMs: streamIdleTimeoutMs,
              routeIdentity,
              onResult: (result) => {
                resolved = result;
              },
              onDone: () => {
                doneObserved = true;
              },
              onSubmitObserved: () => {
                submitObserved = true;
              },
              onArtifact: (artifact) => {
                transferredFiles.push(artifact);
              },
              onArtifactFailure: (message) => {
                transferFailures.push(message);
              },
              enqueueArtifactTransfer: (transfer) => {
                const queued = artifactTransferQueue.then(transfer);
                artifactTransferQueue = queued.catch(() => undefined);
                return queued;
              },
              onTransferProgress: (bytes) => {
                transferProgress.bytes += bytes;
              },
              onError: fail,
            });
            if (transferPromise) {
              transferPromises.push(transferPromise);
            }
          };
          res.on("data", (chunk: string) => {
            armIdleTimer();
            let start = 0;
            let newlineIndex = chunk.indexOf("\n");
            while (newlineIndex !== -1) {
              const segment = chunk.slice(start, newlineIndex);
              const line = (
                pendingChunks.length > 0 ? pendingChunks.join("") + segment : segment
              ).trim();
              pendingChunks.length = 0;
              pendingLength = 0;
              if (line.length > 0) {
                processLine(line);
              }
              start = newlineIndex + 1;
              newlineIndex = chunk.indexOf("\n", start);
            }
            if (start < chunk.length) {
              const rest = start === 0 ? chunk : chunk.slice(start);
              pendingChunks.push(rest);
              pendingLength += rest.length;
            }
            // Cap the trailing (not-yet-newline-terminated) partial line: a
            // worker that never emits a newline would otherwise accumulate the
            // pending chunks without bound. Checked AFTER draining complete
            // lines above, so a burst of many small legitimate lines in one
            // chunk never trips this — only a single line actually exceeding
            // the cap does.
            if (pendingLength > maxLineBytes) {
              fail(
                new RemoteRunFailedError(
                  `Remote run stream line exceeded the ${maxLineBytes}-byte NDJSON line cap without a ` +
                    "terminating newline; refusing to buffer further to avoid unbounded memory growth.",
                  { errorClass: "transport_interrupted_after_submit", retryable: false },
                ),
              );
              req.destroy();
              res.destroy();
            }
          });
          res.on("end", () => {
            clearIdleTimer();
            // NDJSON permits the FINAL line to omit the trailing newline: a
            // complete terminal event buffered at EOF must not be
            // misclassified as truncation. Only a tail that parses as JSON is
            // flushed — an unparseable tail is genuine mid-line truncation
            // and falls through to the EOF-without-done failure below.
            const tail = pendingChunks.length > 0 ? pendingChunks.join("").trim() : "";
            pendingChunks.length = 0;
            pendingLength = 0;
            if (tail.length > 0 && !settled) {
              let parseable = false;
              try {
                JSON.parse(tail);
                parseable = true;
              } catch {
                // truncated partial line — handled by the done-event check
              }
              if (parseable) {
                processLine(tail);
              }
            }
            void (async () => {
              // Overall deadline (bugs-remote#0): every artifact download also
              // has its own inactivity timeout, but if a transfer promise never
              // settles at all, do not await it forever after the stream has
              // ended — convert a wedged transfer into a typed post-submit
              // failure. PROGRESS-AWARE (not a fixed wall-clock cap): the
              // watchdog fires only when NO transfer has delivered a single byte
              // for a full `noProgressWindowMs` window, and resets on every
              // transferred byte. A healthy, actively-streaming large artifact
              // that legitimately outlasts any fixed multiple of the idle
              // timeout is therefore never aborted while bytes are still
              // flowing; only a genuinely wedged transfer (one that also
              // outlives its own per-download inactivity timeout) trips it.
              // The window is deliberately 2x the per-download inactivity
              // timeout: a genuinely stalled download is caught FIRST by its own
              // (earlier) inactivity watchdog, which fails the run with the
              // precise typed ArtifactDownloadTimeoutError; this outer deadline
              // is purely the backstop for a transfer promise that never settles
              // at all (e.g. inactivity watchdog disabled), so it must not race
              // the per-download one.
              const noProgressWindowMs = streamIdleTimeoutMs * 2;
              let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
              const outcome = await Promise.race<"settled" | "deadline">([
                Promise.allSettled(transferPromises).then(() => "settled" as const),
                new Promise<"deadline">((resolveDeadline) => {
                  // No transfers in flight → nothing to guard; never arm the
                  // watchdog (allSettled([]) settles immediately).
                  if (transferPromises.length === 0) {
                    return;
                  }
                  let lastBytes = transferProgress.bytes;
                  const scheduleCheck = () => {
                    deadlineTimer = setTimeout(() => {
                      if (settled) return;
                      if (transferProgress.bytes > lastBytes) {
                        // Byte progress since the last check → a healthy active
                        // transfer. Reset the window instead of aborting.
                        lastBytes = transferProgress.bytes;
                        scheduleCheck();
                        return;
                      }
                      resolveDeadline("deadline");
                    }, noProgressWindowMs);
                  };
                  scheduleCheck();
                }),
              ]);
              if (deadlineTimer) {
                clearTimeout(deadlineTimer);
              }
              if (settled) return;
              if (outcome === "deadline") {
                fail(
                  new RemoteRunFailedError(
                    `Remote run artifact transfers made no progress for over ${noProgressWindowMs}ms after the ` +
                      "stream ended; aborting rather than hanging on a wedged bridge artifact download. This is a " +
                      "no-progress deadline (reset on every transferred byte), not a fixed cap, so a slow-but-active " +
                      "large transfer is unaffected.",
                    { errorClass: "transport_interrupted_after_submit", retryable: false },
                  ),
                );
                return;
              }
              if (!doneObserved || !resolved) {
                // EOF without a terminal done event is a FAILURE, not an
                // answer. Post-submit conservatism: the prompt may have
                // reached the account, so this is never auto-retryable.
                fail(
                  new RemoteRunFailedError(
                    "Remote run stream ended without a terminal done event; refusing to treat it as success.",
                    { errorClass: "transport_interrupted_after_submit", retryable: false },
                  ),
                );
                return;
              }
              settled = true;
              cleanup();
              resolve(mergeTransferredArtifacts(resolved, transferredFiles, transferFailures));
            })().catch(fail);
          });
          res.on("error", (error) => {
            fail(
              new RemoteRunFailedError(
                `Remote run response failed after request dispatch; submission status is unknown (${error.message}).`,
                { errorClass: "transport_interrupted_after_submit", retryable: false },
              ),
            );
          });
        },
      );
      req.on("error", (error) => {
        if (settled) return;
        fail(
          new RemoteRunFailedError(
            requestBodyStarted
              ? `Remote run request failed after dispatch began; submission status is unknown (${error.message}).`
              : `Remote run request failed before dispatch (${error.message}).`,
            {
              errorClass: requestBodyStarted
                ? "transport_interrupted_after_submit"
                : "transport_interrupted_before_submit",
              retryable: !requestBodyStarted,
            },
          ),
        );
      });
      // Pre-response header watchdog (bugs-remote#1): armIdleTimer only arms
      // AFTER the 200 response begins, so a worker that accepts the TCP
      // connection but never sends response headers would otherwise pin the
      // caller until TCP keepalive (~2h). Bound the header-wait window here;
      // the response callback disarms this (req.setTimeout(0)) the instant any
      // response begins. Once the request body has been handed to the socket,
      // missing headers cannot prove the worker did not submit, so ambiguity
      // is conservatively non-retryable. (Guarded for
      // the injected requestFn test seam, whose minimal stub omits setTimeout.)
      if (typeof req.setTimeout === "function") {
        req.setTimeout(streamIdleTimeoutMs, () => {
          if (settled || headersReceived) return;
          fail(
            new RemoteRunFailedError(
              `Remote worker accepted the connection but sent no response headers within ${streamIdleTimeoutMs}ms; ` +
                "submission status is unknown, so refusing an automatic retry.",
              { errorClass: "transport_interrupted_after_submit", retryable: false },
            ),
          );
          req.destroy();
        });
      }
      if (signal) {
        // Caller-gone abort (mirrors buildClientAbortError in
        // src/browser/index.ts for the remote lane): fail with the typed
        // transport class reflecting whether the account-safety boundary
        // (the observed submit-confirmation marker) was crossed, then tear
        // down the outbound request so the worker's own client-gone handling
        // (res "close" -> onClientGone in src/remote/server.ts) fires and
        // frees the single-flight busy slot instead of streaming the rest of
        // the run to a caller that already gave up.
        const onAbort = () => {
          fail(
            new RemoteRunFailedError(
              submitObserved
                ? "Caller aborted after submit; abandoning the remote run without ChatGPT-side cancellation."
                : requestBodyStarted
                  ? "Caller aborted after request dispatch; submission status is unknown, so the run is not retryable."
                  : "Caller aborted before request dispatch.",
              {
                errorClass: requestBodyStarted
                  ? "transport_interrupted_after_submit"
                  : "transport_interrupted_before_submit",
                retryable: !requestBodyStarted,
              },
            ),
          );
          req.destroy();
          activeRes?.destroy();
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }
      }
      if (settled) return;
      requestBodyStarted = true;
      req.write(body);
      req.end();
    });
  };
}

async function serializeAttachments(
  attachments: BrowserAttachment[],
): Promise<RemoteAttachmentPayload[]> {
  const serialized: RemoteAttachmentPayload[] = [];
  for (const attachment of attachments) {
    // Read the local file upfront so the remote host never touches the caller's filesystem.
    const verified = await readBoundedRegularFile(attachment.path, {
      maxBytes: MAX_DATA_TRANSFER_BYTES,
      declaredSizeBytes: attachment.sizeBytes,
      declaredSha256: attachment.integritySha256,
    });
    const content = verified.bytes;
    const sha256 = verified.sha256;
    serialized.push({
      fileName: path.basename(attachment.path),
      displayPath: attachment.displayPath,
      sizeBytes: content.length,
      sha256,
      generatedBundle: attachment.generatedBundle === true,
      contentBase64: content.toString("base64"),
    });
  }
  return serialized;
}

export interface RecoverRemoteBrowserSessionOptions extends RemoteExecutorOptions {
  accountId: string;
  request: RemoteBrowserRecoveryRequest;
  log?: BrowserRunOptions["log"];
  signal?: AbortSignal;
}

/**
 * Dispatch a capture-only recovery to the account that minted its capability.
 * This parser deliberately accepts only log + one terminal done event: a
 * recovery cannot submit, stage attachments, or transfer artifacts.
 */
export async function recoverRemoteBrowserSession({
  host,
  token,
  accountId,
  request,
  log,
  signal,
  requestFn = http.request,
  streamIdleTimeoutMs = resolveDefaultStreamIdleTimeoutMs(),
  maxLineBytes = MAX_NDJSON_LINE_BYTES,
}: RecoverRemoteBrowserSessionOptions): Promise<BrowserRunResult> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(accountId)) {
    return Promise.reject(new Error("Invalid remote recovery account id."));
  }
  const body = Buffer.from(serializeRemoteBrowserRecoveryRequestForWire(request));
  if (requestFn === http.request) {
    await assertRemoteWorkerRecoveryCompatibility({ host, token, requestFn });
  }
  const { hostname, port } = parseHost(host);
  return await new Promise<BrowserRunResult>((resolve, reject) => {
    let settled = false;
    let doneResult: BrowserRunResult | null = null;
    let doneObserved = false;
    let routeIdentity: RemoteRouteIdentity | null = null;
    let activeRes: http.IncomingMessage | null = null;
    let requestHandle: http.ClientRequest | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: (() => void) | null = null;
    let headersReceived = false;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      removeAbortListener?.();
      removeAbortListener = null;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      requestHandle?.destroy();
      activeRes?.destroy();
      reject(error);
    };
    const armIdle = (req: http.ClientRequest, res: http.IncomingMessage) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(
          new RemoteRunFailedError(
            `Remote recovery stream received no data for over ${streamIdleTimeoutMs}ms.`,
            { errorClass: "transport_interrupted_after_submit", retryable: false },
          ),
        );
        req.destroy();
        res.destroy();
      }, streamIdleTimeoutMs);
    };

    const req = requestFn(
      {
        hostname,
        port,
        path: REMOTE_BROWSER_RECOVERY_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          "X-Oracle-Recovery-Account-Id": accountId,
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        activeRes = res;
        headersReceived = true;
        req.setTimeout?.(0);
        if (res.statusCode !== 200) {
          const trustedRefusal = hasAuthenticatedVersionedRefusalIdentity(res, accountId);
          collectRefusal(res, { inactivityTimeoutMs: streamIdleTimeoutMs })
            .then((refusal) =>
              fail(
                trustedRefusal
                  ? new RemoteRunFailedError(refusal.message, {
                      errorClass: refusal.errorClass,
                      retryable: isCoherentRetryableRefusal(res.statusCode, refusal),
                    })
                  : new RemoteRunFailedError(
                      `Remote recovery refusal lacked the exact authenticated ${REMOTE_BROWSER_RECOVERY_PROTOCOL} protocol and account-bound route identity; refusing to trust its retry advice.`,
                      { errorClass: "integrity_ui_unknown", retryable: false },
                    ),
              ),
            )
            .catch(fail);
          return;
        }
        const contentType = res.headers["content-type"];
        if (
          typeof contentType !== "string" ||
          !/^application\/x-ndjson(?:\s*;|$)/i.test(contentType)
        ) {
          fail(
            new RemoteRunFailedError(
              "Remote recovery response had an invalid content type; expected application/x-ndjson.",
              { errorClass: "integrity_ui_unknown", retryable: false },
            ),
          );
          return;
        }
        routeIdentity = readRemoteRouteIdentity(res.headers);
        if (!hasCompatibleRemoteRecoveryResponseHeaders(res.headers)) {
          fail(
            new RemoteRunFailedError(
              "Remote worker accepted recovery without echoing the exact browser recovery protocol contract; refusing a mixed-version route.",
              { errorClass: "integrity_ui_unknown", retryable: false },
            ),
          );
          res.destroy();
          return;
        }
        if (
          !routeIdentity.runId ||
          !routeIdentity.accountId ||
          !routeIdentity.laneId ||
          routeIdentity.accountId !== accountId
        ) {
          fail(
            new RemoteRunFailedError(
              "Remote recovery response did not match the requested authenticated account/run route.",
              { errorClass: "integrity_ui_unknown", retryable: false },
            ),
          );
          res.destroy();
          return;
        }
        log?.(
          `[remote] Accepted recovery route: run=${routeIdentity.runId} account=${routeIdentity.accountId} lane=${routeIdentity.laneId ?? "unknown"}.`,
        );
        res.setEncoding("utf8");
        let pending = "";
        const processLine = (line: string) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch (error) {
            fail(
              new Error(
                `Failed to parse remote recovery event: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
            return;
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            fail(
              new RemoteRunFailedError("Remote recovery event was not an object.", {
                errorClass: "integrity_ui_unknown",
                retryable: false,
              }),
            );
            return;
          }
          const event = parsed as Record<string, unknown>;
          const eventType = typeof event.type === "string" ? event.type : null;
          const eventRunId = typeof event.runId === "string" ? event.runId : null;
          if (
            !eventType ||
            eventType.length > 32 ||
            !eventRunId ||
            eventRunId.length > 128 ||
            !routeIdentity ||
            eventRunId !== routeIdentity.runId
          ) {
            fail(
              new RemoteRunFailedError(
                "Remote recovery event run id did not match its authenticated response header.",
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            return;
          }
          if (doneObserved) {
            fail(
              new RemoteRunFailedError(
                "Remote recovery emitted data after its terminal done event.",
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            return;
          }
          if (eventType === "log") {
            if (typeof event.message !== "string" || event.message.length > 64 * 1024) {
              fail(
                new RemoteRunFailedError("Remote recovery log event was malformed.", {
                  errorClass: "integrity_ui_unknown",
                  retryable: false,
                }),
              );
              return;
            }
            log?.(event.message);
            return;
          }
          if (eventType !== "done") {
            fail(
              new RemoteRunFailedError(
                `Remote recovery emitted forbidden event type ${eventType}.`,
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            return;
          }
          doneObserved = true;
          if (event.ok !== true) {
            fail(
              new RemoteRunFailedError(
                typeof event.errorMessage === "string"
                  ? event.errorMessage.slice(0, 4_096)
                  : "Remote browser recovery failed.",
                {
                  errorClass: typeof event.errorClass === "string" ? event.errorClass : null,
                  retryable: event.retryable === true,
                },
              ),
            );
            return;
          }
          if (!event.result || typeof event.result !== "object" || Array.isArray(event.result)) {
            fail(
              new RemoteRunFailedError("Remote recovery success carried no valid result object.", {
                errorClass: "integrity_ui_unknown",
                retryable: false,
              }),
            );
            return;
          }
          const recoveryProvenance = sanitizeStrongRemoteSuccessProvenance(event.provenance);
          if (!recoveryProvenance) {
            fail(
              new RemoteRunFailedError(
                "Remote recovery success lacked full message-handle capture-binding proof.",
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            return;
          }
          const rawResult = event.result as Record<string, unknown>;
          const expectedConversationId = request.recovery.runtime.conversationId;
          const resultConversationId =
            typeof rawResult.conversationId === "string" ? rawResult.conversationId : null;
          const resultTabUrl = typeof rawResult.tabUrl === "string" ? rawResult.tabUrl : null;
          if (
            resultConversationId !== expectedConversationId ||
            !resultTabUrl ||
            extractConversationIdFromUrl(resultTabUrl) !== expectedConversationId ||
            rawResult.promptSubmitted !== true
          ) {
            fail(
              new RemoteRunFailedError(
                "Remote recovery result conversation did not match the signed request.",
                { errorClass: "integrity_ui_unknown", retryable: false },
              ),
            );
            return;
          }
          const answerText = rawResult.answerText;
          const answerMarkdown = rawResult.answerMarkdown;
          const answerHtml = rawResult.answerHtml;
          const tookMs = rawResult.tookMs;
          const answerTokens = rawResult.answerTokens;
          const answerChars = rawResult.answerChars;
          if (
            typeof answerText !== "string" ||
            typeof answerMarkdown !== "string" ||
            (answerHtml !== undefined && typeof answerHtml !== "string") ||
            typeof tookMs !== "number" ||
            !Number.isFinite(tookMs) ||
            tookMs < 0 ||
            typeof answerTokens !== "number" ||
            !Number.isFinite(answerTokens) ||
            answerTokens < 0 ||
            typeof answerChars !== "number" ||
            !Number.isFinite(answerChars) ||
            answerChars < 0
          ) {
            fail(
              new RemoteRunFailedError("Remote recovery result fields were malformed.", {
                errorClass: "integrity_ui_unknown",
                retryable: false,
              }),
            );
            return;
          }
          doneResult = {
            answerText,
            answerMarkdown,
            ...(typeof answerHtml === "string" ? { answerHtml } : {}),
            tookMs,
            answerTokens,
            answerChars,
            browserTransport: "cdp",
            tabUrl: request.recovery.runtime.tabUrl,
            conversationId: expectedConversationId,
            promptSubmitted: true,
            remoteRun: {
              runId: routeIdentity.runId,
              accountId: routeIdentity.accountId,
              laneId: routeIdentity.laneId,
              terminalDoneOk: true,
              provenance: recoveryProvenance,
            },
          };
        };
        armIdle(req, res);
        res.on("data", (chunk: string) => {
          armIdle(req, res);
          pending += chunk;
          if (Buffer.byteLength(pending, "utf8") > maxLineBytes) {
            fail(
              new RemoteRunFailedError(
                `Remote recovery stream line exceeded the ${maxLineBytes}-byte cap.`,
                { errorClass: "transport_interrupted_after_submit", retryable: false },
              ),
            );
            req.destroy();
            res.destroy();
            return;
          }
          let newline = pending.indexOf("\n");
          while (newline >= 0 && !settled) {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (line) processLine(line);
            newline = pending.indexOf("\n");
          }
        });
        res.on("end", () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          const tail = pending.trim();
          pending = "";
          if (tail && !settled) processLine(tail);
          if (settled) return;
          if (!doneObserved || !doneResult) {
            fail(
              new RemoteRunFailedError(
                "Remote recovery stream ended without a valid terminal done event.",
                { errorClass: "transport_interrupted_after_submit", retryable: false },
              ),
            );
            return;
          }
          settled = true;
          cleanup();
          resolve(doneResult);
        });
        res.on("error", fail);
      },
    );
    requestHandle = req;
    req.on("error", fail);
    req.setTimeout?.(streamIdleTimeoutMs, () => {
      if (settled || headersReceived) return;
      fail(
        new RemoteRunFailedError(
          `Remote recovery worker sent no response headers within ${streamIdleTimeoutMs}ms.`,
          { errorClass: "transport_interrupted_before_submit", retryable: true },
        ),
      );
      req.destroy();
    });
    if (signal) {
      const onAbort = () => {
        fail(
          new RemoteRunFailedError("Remote browser recovery cancelled by caller.", {
            errorClass: "transport_interrupted_after_submit",
            retryable: false,
          }),
        );
        req.destroy();
        activeRes?.destroy();
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
    }
    if (!settled) {
      req.write(body);
      req.end();
    }
  });
}

function parseHost(input: string): { hostname: string; port: number } {
  try {
    return parseHostPort(input);
  } catch (error) {
    throw new Error(
      `Invalid remote host: ${input} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function hasOnlyEventKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function sanitizeRemoteBrowserRunResult(value: unknown): BrowserRunResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !hasOnlyEventKeys(raw, [
      "answerText",
      "answerMarkdown",
      "answerHtml",
      "generatedImages",
      "downloadableFiles",
      "archive",
      "tookMs",
      "answerTokens",
      "answerChars",
      "browserTransport",
      "warnings",
      "tabUrl",
      "conversationId",
      "promptSubmitted",
      "submissionProvenance",
      "modelSelection",
    ])
  ) {
    return null;
  }
  const nonNegativeFinite = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
  const nonNegativeSafeInteger = (candidate: unknown): candidate is number =>
    Number.isSafeInteger(candidate) && (candidate as number) >= 0;
  if (
    typeof raw.answerText !== "string" ||
    typeof raw.answerMarkdown !== "string" ||
    (raw.answerHtml !== undefined && typeof raw.answerHtml !== "string") ||
    !nonNegativeFinite(raw.tookMs) ||
    !nonNegativeSafeInteger(raw.answerTokens) ||
    !nonNegativeSafeInteger(raw.answerChars) ||
    (raw.browserTransport !== undefined && raw.browserTransport !== "cdp") ||
    (raw.promptSubmitted !== undefined && typeof raw.promptSubmitted !== "boolean") ||
    (raw.tabUrl !== undefined && typeof raw.tabUrl !== "string") ||
    (raw.conversationId !== undefined && typeof raw.conversationId !== "string") ||
    (raw.generatedImages !== undefined && !Array.isArray(raw.generatedImages)) ||
    (raw.downloadableFiles !== undefined && !Array.isArray(raw.downloadableFiles)) ||
    (raw.warnings !== undefined && !Array.isArray(raw.warnings)) ||
    (raw.archive !== undefined &&
      (!raw.archive || typeof raw.archive !== "object" || Array.isArray(raw.archive))) ||
    (raw.modelSelection !== undefined &&
      (!raw.modelSelection ||
        typeof raw.modelSelection !== "object" ||
        Array.isArray(raw.modelSelection)))
  ) {
    return null;
  }
  return raw as unknown as BrowserRunResult;
}

function handleEvent(params: {
  line: string;
  options: BrowserRunOptions;
  armedFallback: BrowserRunOptions["fallbackSubmission"];
  expectedPrimaryAttachments: RemoteAttachmentPayload[];
  expectedFallbackAttachments: RemoteAttachmentPayload[];
  hostname: string;
  port: number;
  token?: string;
  artifactInactivityTimeoutMs: number;
  routeIdentity: RemoteRouteIdentity;
  onResult: (result: BrowserRunResult) => void;
  onDone: () => void;
  onSubmitObserved: () => void;
  onArtifact: (artifact: SavedBrowserFile) => void;
  onArtifactFailure: (message: string) => void;
  enqueueArtifactTransfer: (transfer: () => Promise<void>) => Promise<void>;
  onTransferProgress: (bytes: number) => void;
  onError: (error: Error) => void;
}): Promise<void> | null {
  let event: RemoteRunEvent;
  try {
    const parsed = JSON.parse(params.line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("event must be an object");
    }
    event = parsed as RemoteRunEvent;
  } catch (error) {
    params.onError(
      new RemoteRunFailedError(
        `Failed to parse remote event: ${error instanceof Error ? error.message : String(error)}`,
        { errorClass: "integrity_ui_unknown", retryable: false },
      ),
    );
    return null;
  }
  if (
    !params.routeIdentity.runId ||
    typeof event.runId !== "string" ||
    event.runId !== params.routeIdentity.runId
  ) {
    params.onError(
      new RemoteRunFailedError(
        "Versioned remote run event id did not match its authenticated response route.",
        { errorClass: "integrity_ui_unknown", retryable: false },
      ),
    );
    return null;
  }
  if (event.type === "log") {
    if (
      !hasOnlyEventKeys(event as unknown as Record<string, unknown>, [
        "type",
        "runId",
        "message",
      ]) ||
      typeof event.message !== "string" ||
      event.message.length > 64 * 1024
    ) {
      params.onError(
        new RemoteRunFailedError("Remote log event was malformed.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
      return null;
    }
    if (SUBMIT_CONFIRMATION_LOG_PATTERN.test(event.message)) {
      params.onSubmitObserved();
    }
    params.options.log?.(event.message);
    return null;
  }
  if (event.type === "error") {
    if (
      !hasOnlyEventKeys(event as unknown as Record<string, unknown>, [
        "type",
        "runId",
        "message",
      ]) ||
      typeof event.message !== "string" ||
      event.message.length > 4_096
    ) {
      params.onError(
        new RemoteRunFailedError("Remote error event was malformed.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
      return null;
    }
    params.onError(new Error(event.message));
    return null;
  }
  if (event.type === "artifact-progress") {
    if (
      !hasOnlyEventKeys(event as unknown as Record<string, unknown>, [
        "type",
        "runId",
        "artifactId",
        "receivedBytes",
        "totalBytes",
        "phase",
      ]) ||
      typeof event.artifactId !== "string" ||
      !event.artifactId ||
      !["download", "transfer", "validate"].includes(event.phase) ||
      (event.receivedBytes !== undefined &&
        (!Number.isSafeInteger(event.receivedBytes) || event.receivedBytes < 0)) ||
      (event.totalBytes !== undefined &&
        (!Number.isSafeInteger(event.totalBytes) || event.totalBytes < 0))
    ) {
      params.onError(
        new RemoteRunFailedError("Remote artifact-progress event was malformed.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
      return null;
    }
    if (params.options.verbose) {
      params.options.log?.(
        `[browser] Artifact ${event.artifactId} ${event.phase}${
          event.receivedBytes !== undefined && event.totalBytes !== undefined
            ? ` ${event.receivedBytes}/${event.totalBytes} bytes`
            : ""
        }`,
      );
    }
    return null;
  }
  if (event.type === "artifact-ready") {
    if (
      !hasOnlyEventKeys(event as unknown as Record<string, unknown>, [
        "type",
        "runId",
        "artifact",
      ]) ||
      !event.artifact ||
      typeof event.artifact !== "object" ||
      Array.isArray(event.artifact)
    ) {
      params.onError(
        new RemoteRunFailedError("Remote artifact-ready event was malformed.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
      return null;
    }
    if (event.artifact?.runId !== params.routeIdentity.runId) {
      params.onError(
        new RemoteRunFailedError(
          "Remote artifact descriptor did not match its authenticated run route.",
          { errorClass: "integrity_ui_unknown", retryable: false },
        ),
      );
      return null;
    }
    const displayFilename = sanitizeArtifactFilename(
      String(event.artifact?.filename ?? ""),
      "artifact.bin",
    );
    const transfer = params.enqueueArtifactTransfer(() =>
      transferRemoteArtifact({
        hostname: params.hostname,
        port: params.port,
        token: params.token,
        descriptor: event.artifact,
        sessionId: params.options.sessionId,
        log: params.options.log,
        inactivityTimeoutMs: params.artifactInactivityTimeoutMs,
        onProgress: params.onTransferProgress,
      })
        .then((artifact) => {
          params.onArtifact(artifact);
        })
        .catch((error) => {
          // A STALLED download (inactivity timeout) is a transport-level hang,
          // not a content failure: after the answer has been submitted, fail
          // the run with a typed post-submit error instead of resolving with a
          // partial-artifact warning or hanging forever. Ordinary transfer
          // failures (size/sha/validation mismatch, HTTP error, invalid
          // descriptor) remain non-fatal warnings so a good paid answer is
          // still returned.
          if (error instanceof ArtifactDownloadTimeoutError) {
            params.onError(
              new RemoteRunFailedError(
                `Bridge artifact download for ${displayFilename} stalled and was aborted (${error.message}); ` +
                  "failing the run rather than hanging on a wedged transfer.",
                { errorClass: "transport_interrupted_after_submit", retryable: false },
              ),
            );
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          const fallback = `Oracle captured the browser text response, but bridge artifact transfer failed for ${displayFilename}. Open the ChatGPT browser on the bridge host, download the ZIP/file shown in the current response, and copy it to a cloud-readable path. Reason: ${message}`;
          params.options.log?.(`[browser] ${fallback}`);
          params.onArtifactFailure(fallback);
        }),
    );
    return transfer;
  }
  if (event.type === "done") {
    if (
      !hasOnlyEventKeys(event as unknown as Record<string, unknown>, [
        "type",
        "runId",
        "ok",
        "errorClass",
        "errorMessage",
        "retryable",
        "provenance",
        "recovery",
        "result",
        "uploadIntegrity",
      ]) ||
      typeof event.ok !== "boolean"
    ) {
      params.onError(
        new RemoteRunFailedError("Terminal done event was malformed.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
      return null;
    }
    if (event.ok === true && event.result) {
      const sanitizedResult = sanitizeRemoteBrowserRunResult(event.result);
      if (!sanitizedResult) {
        params.onError(
          new RemoteRunFailedError("Remote success carried a malformed result object.", {
            errorClass: "integrity_ui_unknown",
            retryable: false,
          }),
        );
        return null;
      }
      const successProvenance = sanitizeStrongRemoteSuccessProvenance(event.provenance, {
        requireModelProof: true,
      });
      const expectedPrimaryTransport =
        (params.options.attachments?.length ?? 0) > 0 ? "upload" : "inline";
      const resultSubmission = sanitizeBrowserSubmissionProvenance(
        sanitizedResult.submissionProvenance,
      );
      const submitted = successProvenance?.submission;
      const expectedSubmittedPrompt = submitted?.fallbackUsed
        ? params.armedFallback?.prompt.trim()
        : params.options.prompt.trim();
      const expectedSubmittedTransport = submitted?.fallbackUsed
        ? params.expectedFallbackAttachments.length > 0
          ? "upload"
          : "inline"
        : expectedPrimaryTransport;
      const fallbackBranchMatches = submitted?.fallbackUsed
        ? Boolean(
            params.armedFallback?.reason &&
            submitted.fallbackReason === params.armedFallback.reason &&
            expectedSubmittedPrompt &&
            submitted.submittedPromptSha256 === computePromptSha256(expectedSubmittedPrompt) &&
            submitted.submittedTransport === expectedSubmittedTransport,
          )
        : Boolean(
            submitted &&
            submitted.fallbackReason === null &&
            submitted.submittedPromptSha256 === computePromptSha256(params.options.prompt.trim()) &&
            submitted.submittedTransport === expectedPrimaryTransport,
          );
      if (
        !submitted ||
        submitted.primaryPromptSha256 !== computePromptSha256(params.options.prompt.trim()) ||
        submitted.primaryTransport !== expectedPrimaryTransport ||
        !fallbackBranchMatches ||
        !resultSubmission ||
        JSON.stringify(resultSubmission) !== JSON.stringify(submitted) ||
        !validateRemoteUploadIntegrity(
          event.uploadIntegrity,
          submitted,
          params.expectedPrimaryAttachments,
          params.expectedFallbackAttachments,
          Boolean(params.armedFallback),
        )
      ) {
        params.onError(
          new RemoteRunFailedError(
            "Remote success lacked matching full message-handle capture-binding, challenge-clean, and initial-submission provenance; refusing the unproven answer.",
            { errorClass: "integrity_ui_unknown", retryable: false },
          ),
        );
        return null;
      }
      // §14.16 provenance distinction: what the worker verified is plumbing
      // evidence (model, capture binding, challenge-clean) — it does not
      // certify the answer's correctness.
      params.options.log?.(
        `[remote] Terminal done.ok observed. Provenance: model=${String(successProvenance.modelVerified)} ` +
          `binding=${String(successProvenance.captureBindingVerified)} bindingQuality=${String(successProvenance.captureBindingQuality)} ` +
          `challengeClean=${String(successProvenance.challengeClean)} ` +
          `submission=${submitted.submittedTransport}${submitted.fallbackUsed ? ":fallback" : ":primary"} ` +
          "(provenance verified means the plumbing was right, not that the answer is correct).",
      );
      params.onResult({
        ...sanitizedResult,
        remoteRun: {
          runId: params.routeIdentity.runId,
          accountId: params.routeIdentity.accountId,
          laneId: params.routeIdentity.laneId,
          terminalDoneOk: true,
          provenance: successProvenance,
        },
      });
      params.onDone();
      return null;
    }
    if (event.ok === true) {
      params.onError(
        new RemoteRunFailedError("Terminal done event claimed success but carried no result.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
      return null;
    }
    if (
      (event.errorMessage !== undefined && typeof event.errorMessage !== "string") ||
      (event.errorClass !== undefined &&
        event.errorClass !== null &&
        typeof event.errorClass !== "string") ||
      (event.retryable !== undefined &&
        event.retryable !== null &&
        typeof event.retryable !== "boolean")
    ) {
      params.onError(
        new RemoteRunFailedError("Remote failure event was malformed.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
      return null;
    }
    const message =
      event.errorMessage ?? `Remote run failed (${event.errorClass ?? "unclassified"})`;
    const remoteFailure = new RemoteRunFailedError(message, {
      errorClass: event.errorClass ?? null,
      retryable: event.retryable ?? false,
    });
    const recovery = sanitizeRemoteRunRecoveryHint(event.recovery);
    if (recovery && EXECUTABLE_RECOVERY_STAGE_SET.has(recovery.stage)) {
      if (
        !event.runId ||
        !params.routeIdentity.runId ||
        event.runId !== params.routeIdentity.runId ||
        recovery.originRunId !== event.runId ||
        !params.routeIdentity.accountId
      ) {
        params.onError(
          new RemoteRunFailedError(
            "Remote recovery evidence did not match the authenticated run/account route; refusing to persist it.",
            { errorClass: "integrity_ui_unknown", retryable: false },
          ),
        );
        return null;
      }
      const recoveryError = new BrowserAutomationError(
        message,
        {
          stage: recovery.stage,
          runtime: recovery.runtime,
          errorClass: event.errorClass ?? null,
          retryable: event.retryable ?? false,
          remoteRun: {
            runId: event.runId ?? params.routeIdentity.runId,
            accountId: params.routeIdentity.accountId,
            laneId: params.routeIdentity.laneId,
            terminalDoneOk: false,
            provenance: null,
          },
        },
        remoteFailure,
      ) as BrowserAutomationError & {
        errorClass: string | null;
        retryable: boolean | null;
      };
      // Preserve the direct typed-failure fields for callers that branch on
      // errorClass/retryable without inspecting OracleUserError.details.
      recoveryError.errorClass = remoteFailure.errorClass;
      recoveryError.retryable = remoteFailure.retryable;
      const failedRoute = failedRouteFromIdentity(params.routeIdentity);
      if (failedRoute) remoteFailedRouteByError.set(recoveryError, failedRoute);
      const executableRecovery = recovery as RemoteBrowserRecoveryRequest["recovery"];
      const ownership = resolveRecoveryPromptOwnership(params.options, executableRecovery);
      if (ownership) {
        remoteRecoveryByError.set(recoveryError, {
          recovery: executableRecovery,
          accountId: params.routeIdentity.accountId,
          laneId: params.routeIdentity.laneId,
          ...ownership,
        });
      }
      params.onError(recoveryError);
      return null;
    }
    const failedRoute = failedRouteFromIdentity(params.routeIdentity);
    if (failedRoute) remoteFailedRouteByError.set(remoteFailure, failedRoute);
    params.onError(remoteFailure);
    return null;
  }
  if (event.type === "result") {
    params.onError(
      new RemoteRunFailedError("Versioned remote worker emitted a forbidden legacy result event.", {
        errorClass: "integrity_ui_unknown",
        retryable: false,
      }),
    );
    return null;
  }
  if (event.type === "attachment-manifest") {
    if (
      !hasOnlyEventKeys(event as unknown as Record<string, unknown>, [
        "type",
        "runId",
        "uploadIntegrity",
      ]) ||
      !event.uploadIntegrity ||
      typeof event.uploadIntegrity !== "object" ||
      Array.isArray(event.uploadIntegrity)
    ) {
      params.onError(
        new RemoteRunFailedError("Remote attachment-manifest event was malformed.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
    }
    return null;
  }
  params.onError(
    new RemoteRunFailedError("Versioned remote worker emitted an unknown event type.", {
      errorClass: "integrity_ui_unknown",
      retryable: false,
    }),
  );
  return null;
}

async function transferRemoteArtifact(params: {
  hostname: string;
  port: number;
  token?: string;
  descriptor: RemoteArtifactDescriptor;
  sessionId?: string;
  log?: BrowserRunOptions["log"];
  inactivityTimeoutMs: number;
  onProgress?: (bytes: number) => void;
}): Promise<SavedBrowserFile> {
  validateRemoteArtifactDescriptor(params.descriptor);
  const sessionId = params.sessionId ?? params.descriptor.runId;
  const artifactsDir = resolveSessionArtifactsDir(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const filename = sanitizeArtifactFilename(
    params.descriptor.filename,
    `artifact-${params.descriptor.artifactId}.bin`,
  );
  const finalPath = await resolveUniqueArtifactPath(path.join(artifactsDir, filename));
  const partPath = `${finalPath}.part-${params.descriptor.artifactId}`;
  const artifactPath = `/runs/${encodeURIComponent(params.descriptor.runId)}/artifacts/${encodeURIComponent(
    params.descriptor.artifactId,
  )}`;

  params.log?.(`[browser] Transferring artifact ${filename} from bridge host...`);
  const { sha256 } = await downloadArtifactToFile({
    hostname: params.hostname,
    port: params.port,
    path: artifactPath,
    token: params.token,
    targetPath: partPath,
    descriptor: params.descriptor,
    inactivityTimeoutMs: params.inactivityTimeoutMs,
    onProgress: params.onProgress,
  }).catch(async (error) => {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw error;
  });

  const fileStat = await stat(partPath);
  if (fileStat.size !== params.descriptor.byteSize) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`size mismatch (${fileStat.size} != ${params.descriptor.byteSize})`);
  }
  // sha256 was computed inline while the bytes streamed through the size
  // limiter (perf-io-remote#1), so the file is not re-read from disk purely to
  // hash it.
  if (sha256 !== params.descriptor.sha256) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error("sha256 mismatch");
  }
  const validation = await validateArtifactFile({
    path: partPath,
    filename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
  });
  if (!validation.ok) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`${validation.type} validation failed: ${validation.error ?? "invalid"}`);
  }

  await rename(partPath, finalPath);
  params.log?.(`[browser] Transferred artifact to ${finalPath}`);
  const publishedFilename = path.basename(finalPath);
  return {
    kind: "file",
    path: finalPath,
    label: publishedFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
    sizeBytes: fileStat.size,
    sourceUrl: "bridge-artifact",
    sha256,
    validation,
    transfer: { status: "completed", bytes: fileStat.size },
    origin: { mode: "bridge" },
    url: "bridge-artifact",
    finalUrl: "bridge-artifact",
    filename: publishedFilename,
  };
}

async function downloadArtifactToFile(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  targetPath: string;
  descriptor: RemoteArtifactDescriptor;
  inactivityTimeoutMs: number;
  onProgress?: (bytes: number) => void;
}): Promise<{ sha256: string }> {
  return await new Promise<{ sha256: string }>((resolve, reject) => {
    // Single-settle guard so the inactivity timeout deterministically wins over
    // the follow-on socket 'error'/pipeline rejection that req.destroy() emits,
    // and the caller reliably sees the typed ArtifactDownloadTimeoutError.
    let downloadSettled = false;
    const settleResolve = (value: { sha256: string }) => {
      if (downloadSettled) return;
      downloadSettled = true;
      resolve(value);
    };
    const settleReject = (error: Error) => {
      if (downloadSettled) return;
      downloadSettled = true;
      reject(error);
    };
    const req = http.request(
      {
        hostname: params.hostname,
        port: params.port,
        path: params.path,
        method: "GET",
        headers: params.token ? { authorization: `Bearer ${params.token}` } : undefined,
      },
      (res) => {
        if (res.statusCode !== 200) {
          collectError(res)
            .then((message) => settleReject(new Error(message)))
            .catch(settleReject);
          return;
        }
        const headerSha = String(res.headers["x-oracle-artifact-sha256"] ?? "");
        if (headerSha && headerSha !== params.descriptor.sha256) {
          res.resume();
          settleReject(new Error("artifact sha256 header mismatch"));
          return;
        }
        const contentLengthHeader = res.headers["content-length"];
        const contentLength =
          typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
        if (
          contentLength !== undefined &&
          (!Number.isSafeInteger(contentLength) ||
            contentLength <= 0 ||
            contentLength > MAX_REMOTE_ARTIFACT_BYTES ||
            contentLength !== params.descriptor.byteSize)
        ) {
          res.resume();
          settleReject(new Error("artifact content-length mismatch"));
          return;
        }
        const output = createWriteStream(params.targetPath, { flags: "wx" });
        // Hash inline as the bytes stream through the size limiter
        // (perf-io-remote#1) so the file is never re-read from disk purely to
        // compute its sha256.
        const hash = createHash("sha256");
        let receivedBytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            receivedBytes += chunk.length;
            if (
              receivedBytes > params.descriptor.byteSize ||
              receivedBytes > MAX_REMOTE_ARTIFACT_BYTES
            ) {
              callback(new Error("artifact exceeded declared size"));
              return;
            }
            hash.update(chunk);
            // Report byte progress so the /runs executor's progress-aware
            // overall-transfer deadline resets while this download is actively
            // streaming (a healthy slow-but-flowing large transfer must never
            // trip a fixed wall-clock cap).
            params.onProgress?.(chunk.length);
            callback(null, chunk);
          },
        });
        void pipeline(res, limiter, output).then(
          () => settleResolve({ sha256: hash.digest("hex") }),
          settleReject,
        );
      },
    );
    // Inactivity timeout (bugs-remote#0): a half-open artifact connection (VM
    // pause, mid-transfer partition, worker killed without FIN/RST) after the
    // 200 headers would otherwise wedge the transfer — and thus the whole run —
    // forever, since the /runs stream's own idle watchdog is already cleared by
    // this phase. Reset on socket activity, so a legitimately slow-but-active
    // large download is unaffected; a genuine stall aborts with a typed marker
    // that the caller converts into a post-submit run failure. (Guarded for the
    // requestFn test seam, though this path always uses the real http.request.)
    if (params.inactivityTimeoutMs > 0 && typeof req.setTimeout === "function") {
      req.setTimeout(params.inactivityTimeoutMs, () => {
        settleReject(
          new ArtifactDownloadTimeoutError(
            `artifact download received no data for over ${params.inactivityTimeoutMs}ms`,
          ),
        );
        req.destroy();
      });
    }
    req.on("error", settleReject);
    req.end();
  });
}

function validateRemoteArtifactDescriptor(descriptor: RemoteArtifactDescriptor): void {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    descriptor.kind !== "file" ||
    typeof descriptor.runId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.runId) ||
    typeof descriptor.artifactId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.artifactId) ||
    typeof descriptor.filename !== "string" ||
    !Number.isSafeInteger(descriptor.byteSize) ||
    descriptor.byteSize <= 0 ||
    descriptor.byteSize > MAX_REMOTE_ARTIFACT_BYTES ||
    typeof descriptor.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256)
  ) {
    throw new Error("invalid bridge artifact descriptor");
  }
}

function mergeTransferredArtifacts(
  result: BrowserRunResult,
  transferredFiles: SavedBrowserFile[],
  transferFailures: string[],
): BrowserRunResult {
  const artifacts = appendArtifacts(result.artifacts, transferredFiles);
  const savedFiles = appendSavedFiles(result.savedFiles, transferredFiles);
  const warnings = [
    ...(result.warnings ?? []),
    ...transferFailures.map((message) => ({
      code: "remote-artifact-transfer-failed",
      severity: "warning" as const,
      message,
    })),
  ];
  return {
    ...result,
    artifacts,
    savedFiles,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function appendSavedFiles(
  existing: SavedBrowserFile[] | undefined,
  additions: SavedBrowserFile[],
): SavedBrowserFile[] | undefined {
  const merged = new Map<string, SavedBrowserFile>();
  for (const artifact of existing ?? []) {
    merged.set(artifact.path, artifact);
  }
  for (const artifact of additions) {
    merged.set(artifact.path, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

function collectError(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed.error ?? `Remote host responded with status ${res.statusCode}`);
      } catch {
        resolve(raw || `Remote host responded with status ${res.statusCode}`);
      }
    });
    res.on("error", reject);
  });
}

/**
 * Typed refusal reader for non-200 /runs responses: surfaces the worker's
 * errorClass/retryable fields (e.g. capacity_busy + Retry-After on 409) so
 * callers apply the right retry policy instead of guessing from strings.
 */
function collectRefusal(
  res: http.IncomingMessage,
  options: { maxBytes?: number; inactivityTimeoutMs?: number } = {},
): Promise<{ message: string; errorClass: string | null; retryable: boolean | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const maxBytes = Math.max(1, options.maxBytes ?? 64 * 1024);
    const inactivityTimeoutMs = Math.max(
      1,
      options.inactivityTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    );
    let totalBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      res.destroy();
    };
    const arm = () => {
      cleanup();
      timer = setTimeout(() => {
        fail(
          new RemoteRunFailedError(
            `Remote refusal body received no data for over ${inactivityTimeoutMs}ms.`,
            { errorClass: "transport_interrupted_before_submit", retryable: true },
          ),
        );
      }, inactivityTimeoutMs);
    };
    arm();
    res.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      arm();
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) {
        fail(
          new RemoteRunFailedError(`Remote refusal body exceeded the ${maxBytes}-byte limit.`, {
            errorClass: "integrity_ui_unknown",
            retryable: false,
          }),
        );
        return;
      }
      chunks.push(bytes);
    });
    res.on("end", () => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = Buffer.concat(chunks).toString("utf8");
      const fallback = `Remote host responded with status ${res.statusCode}`;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Prefer the worker's actionable `message` (e.g. the model-not-allowed
        // guidance) over the terse `error` code so callers surface the fix, not
        // just the class name. Falls back to the code, then the status line.
        const message =
          typeof parsed.message === "string" && parsed.message.length > 0
            ? parsed.message
            : typeof parsed.error === "string"
              ? parsed.error
              : fallback;
        resolve({
          message,
          errorClass: typeof parsed.errorClass === "string" ? parsed.errorClass : null,
          retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : null,
        });
      } catch {
        resolve({ message: raw || fallback, errorClass: null, retryable: null });
      }
    });
    res.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}
