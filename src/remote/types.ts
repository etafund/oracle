import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRunResult } from "../browserMode.js";
import type {
  BrowserAttachment,
  BrowserPromptFallbackReason,
  BrowserSubmissionProvenance,
  BrowserSubmissionTransport,
} from "../browser/types.js";
import type { SubmittedMessageBindingQuality } from "../browser/actions/captureBinding.js";
import {
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../browser/promptDomMatch.js";
import type { SessionArtifactValidation } from "../sessionManager.js";
import type { OracleBuildInfo } from "../version.js";
import type { RunErrorClass } from "./run_event_sink.js";

export const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024 * 1024;

/**
 * Exact mixed-version contract for executable remote browser recovery.
 *
 * Ordinary remote runs advertise this contract at admission because a run
 * can cross the submit boundary and need capture-only recovery later. A
 * client/worker pair that disagrees must refuse the run before touching the
 * browser; silently degrading to a legacy sidecar would make the resulting
 * failed session unrecoverable.
 */
export const REMOTE_BROWSER_RECOVERY_PROTOCOL = "remote-browser-recovery.v5" as const;
export const REMOTE_BROWSER_TERMINAL_RETRY_POLICY = "class-allowlist.v1" as const;
// Keep the deployed router's exact `/runs`, `/recover`, and recovery-claim
// locations while
// versioning the upstream request target. nginx location matching excludes
// the query string, but Node workers compare `req.url` including it: current
// routers forward these targets, while legacy workers return 404 before body
// parsing/browser execution instead of ignoring a new header and submitting.
export const REMOTE_BROWSER_RUN_PATH = "/runs?protocol=remote-browser-recovery.v5" as const;
export const REMOTE_BROWSER_RECOVERY_PATH = "/recover?protocol=remote-browser-recovery.v5" as const;
export const REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH =
  "/recovery-claims?protocol=remote-browser-recovery.v5" as const;
export const REMOTE_BROWSER_RUN_SCHEMA = "remote-browser-run.v5" as const;
export const REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA = "remote-browser-recovery-claim.v1" as const;
export const REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER = "x-oracle-recovery-claim-lookup" as const;
export const REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE = "v1" as const;
export const REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_SCHEMA =
  "remote-browser-pre-submit-diagnostic.v1" as const;

const REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_CODES = [
  "protected-route-public-proof-unverified",
  "protected-route-changed-after-preflight",
  "protected-dispatch-guard-not-armed",
  "protected-route-dispatch-blocked",
  "protected-route-dispatch-unproven",
] as const;

const REMOTE_BROWSER_PRE_SUBMIT_REASON_VALUES = [
  "unrecognized",
  "bound-send-target-changed",
  "checked-row-not-exact",
  "dispatch-composer-focus-rebind-failed",
  "dispatch-composer-remounted-during-proof",
  "dispatch-guard-already-blocked",
  "dispatch-guard-expired",
  "dispatch-guard-missing",
  "duplicate-trusted-dispatch-event",
  "event-guard-unavailable",
  "exact-attachment-state-changed",
  "exact-dispatch-composer-unavailable",
  "exact-editor-focus-changed",
  "exact-prompt-changed",
  "exact-row-ambiguous",
  "guard-registry-unavailable",
  "guard-token-missing",
  "model-submenu-owner-unverified",
  "non-primary-dispatch-event",
  "owned-menu-not-visible",
  "parent-menu-owner-unverified",
  "proof-menus-did-not-close",
  "protected-route-changed",
  "proved-route-pill-unavailable",
  "public-route-proof-alternate-submit",
  "public-route-proof-bound-node-changed",
  "public-route-proof-burned",
  "public-route-proof-consume-failed",
  "public-route-proof-consumed-before-guard",
  "public-route-proof-dispatch-before-guard",
  "public-route-proof-dom-mutated",
  "public-route-proof-expired",
  "public-route-proof-guard-handoff-failed",
  "public-route-proof-handoff-blocker-unavailable",
  "public-route-proof-invalid",
  "public-route-proof-invalid-at-mint",
  "public-route-proof-key-event",
  "public-route-proof-location-changed",
  "public-route-proof-menu-set-changed",
  "public-route-proof-missing",
  "public-route-proof-navigation",
  "public-route-proof-observer-failed",
  "public-route-proof-observer-unavailable",
  "public-route-proof-payload-event",
  "public-route-proof-pill-changed",
  "public-route-proof-prompt-changed",
  "public-route-proof-result-missing",
  "public-route-proof-route-event",
  "public-route-proof-token-missing",
  "public-route-proof-unavailable",
  "sol-submenu-trigger-ambiguous",
  "row-selection-state-contradictory",
  "trusted-event-target-changed",
  "untrusted-dispatch-event",
  "verdict-binding-call-failed",
  "verdict-binding-unavailable",
] as const;

const REMOTE_BROWSER_PRE_SUBMIT_GUARD_STATUS_VALUES = [
  "unrecognized",
  "allowed",
  "armed",
  "blocked",
  "missing",
] as const;

const REMOTE_BROWSER_PRE_SUBMIT_EXACT_READ_REASON_VALUES = [
  "unrecognized",
  "editor-missing",
  "selection-api-unavailable",
  "selection-state-unsupported",
  "editor-not-focused",
  "selection-read-failed",
  "selection-restore-failed",
  "focus-changed",
  "editor-root-changed",
] as const;

type RemoteBrowserPreSubmitDiagnosticCode =
  (typeof REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_CODES)[number];
type RemoteBrowserPreSubmitReason = (typeof REMOTE_BROWSER_PRE_SUBMIT_REASON_VALUES)[number];
type RemoteBrowserPreSubmitGuardStatus =
  (typeof REMOTE_BROWSER_PRE_SUBMIT_GUARD_STATUS_VALUES)[number];
type RemoteBrowserPreSubmitExactReadReason =
  (typeof REMOTE_BROWSER_PRE_SUBMIT_EXACT_READ_REASON_VALUES)[number];

/**
 * Closed, non-sensitive explanation for a protected browser refusal before
 * Send. Raw DOM text, prompts, URLs, paths, selectors, account identifiers,
 * and signal labels are deliberately absent.
 */
export interface RemoteBrowserPreSubmitDiagnosticV1 {
  schema: typeof REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_SCHEMA;
  stage: "model-selection";
  code: RemoteBrowserPreSubmitDiagnosticCode;
  reason: RemoteBrowserPreSubmitReason | null;
  composerBindingVerified: boolean | null;
  modelVerified: boolean | null;
  modeVerified: boolean | null;
  modelSignalCount: number | null;
  modeSignalCount: number | null;
  privateModelProofAttempted: boolean | null;
  privateModelProofValid: boolean | null;
  guardInstalled: boolean | null;
  guardStatus: RemoteBrowserPreSubmitGuardStatus | null;
  exactPromptVerified: boolean | null;
  attachmentStateVerified: boolean | null;
  focusVerified: boolean | null;
  exactReadVerified: boolean | null;
  exactReadReason: RemoteBrowserPreSubmitExactReadReason | null;
  selectionRestored: boolean | null;
  focusPreserved: boolean | null;
}

const REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_KEYS = [
  "schema",
  "stage",
  "code",
  "reason",
  "composerBindingVerified",
  "modelVerified",
  "modeVerified",
  "modelSignalCount",
  "modeSignalCount",
  "privateModelProofAttempted",
  "privateModelProofValid",
  "guardInstalled",
  "guardStatus",
  "exactPromptVerified",
  "attachmentStateVerified",
  "focusVerified",
  "exactReadVerified",
  "exactReadReason",
  "selectionRestored",
  "focusPreserved",
] as const;

const remoteBrowserPreSubmitCodeSet = new Set<string>(REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_CODES);
const remoteBrowserPreSubmitReasonSet = new Set<string>(REMOTE_BROWSER_PRE_SUBMIT_REASON_VALUES);
const remoteBrowserPreSubmitGuardStatusSet = new Set<string>(
  REMOTE_BROWSER_PRE_SUBMIT_GUARD_STATUS_VALUES,
);
const remoteBrowserPreSubmitExactReadReasonSet = new Set<string>(
  REMOTE_BROWSER_PRE_SUBMIT_EXACT_READ_REASON_VALUES,
);

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableBoundedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 64
    ? (value as number)
    : null;
}

function allowlistedValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T | "unrecognized" | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && allowed.has(value) ? (value as T) : "unrecognized";
}

/**
 * Server-side projection from a typed browser error. Unknown strings become a
 * fixed sentinel rather than crossing the remote boundary.
 */
export function buildRemoteBrowserPreSubmitDiagnostic(
  details: unknown,
): RemoteBrowserPreSubmitDiagnosticV1 | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const raw = details as Record<string, unknown>;
  if (
    raw.stage !== "model-selection" ||
    typeof raw.code !== "string" ||
    !remoteBrowserPreSubmitCodeSet.has(raw.code)
  ) {
    return null;
  }
  const rawReason = raw.guardReason ?? raw.dispatchGuardReason ?? raw.proofReason;
  const rawGuardStatus = raw.guardStatus ?? raw.dispatchGuardStatus;
  return {
    schema: REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_SCHEMA,
    stage: "model-selection",
    code: raw.code as RemoteBrowserPreSubmitDiagnosticCode,
    reason: allowlistedValue<RemoteBrowserPreSubmitReason>(
      rawReason,
      remoteBrowserPreSubmitReasonSet,
    ),
    composerBindingVerified: nullableBoolean(raw.composerBindingVerified),
    modelVerified: nullableBoolean(raw.modelVerified),
    modeVerified: nullableBoolean(raw.modeVerified),
    modelSignalCount: nullableBoundedCount(raw.modelSignalCount),
    modeSignalCount: nullableBoundedCount(raw.modeSignalCount),
    privateModelProofAttempted: nullableBoolean(raw.privateModelProofAttempted),
    privateModelProofValid: nullableBoolean(raw.privateModelProofValid),
    guardInstalled: nullableBoolean(raw.guardInstalled),
    guardStatus: allowlistedValue<RemoteBrowserPreSubmitGuardStatus>(
      rawGuardStatus,
      remoteBrowserPreSubmitGuardStatusSet,
    ),
    exactPromptVerified: nullableBoolean(raw.exactPromptVerified),
    attachmentStateVerified: nullableBoolean(raw.attachmentStateVerified),
    focusVerified: nullableBoolean(raw.focusVerified),
    exactReadVerified: nullableBoolean(raw.exactReadVerified),
    exactReadReason: allowlistedValue<RemoteBrowserPreSubmitExactReadReason>(
      raw.exactReadReason,
      remoteBrowserPreSubmitExactReadReasonSet,
    ),
    selectionRestored: nullableBoolean(raw.selectionRestored),
    focusPreserved: nullableBoolean(raw.focusPreserved),
  };
}

/**
 * Client-side closed-schema validation. Unlike the server projection, unknown
 * values or extra/missing keys reject the event instead of being normalized.
 */
export function parseRemoteBrowserPreSubmitDiagnostic(
  value: unknown,
): RemoteBrowserPreSubmitDiagnosticV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (
    keys.length !== REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_KEYS.length ||
    keys.some(
      (key) => !(REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_KEYS as readonly string[]).includes(key),
    ) ||
    raw.schema !== REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_SCHEMA ||
    raw.stage !== "model-selection" ||
    typeof raw.code !== "string" ||
    !remoteBrowserPreSubmitCodeSet.has(raw.code) ||
    (raw.reason !== null &&
      (typeof raw.reason !== "string" || !remoteBrowserPreSubmitReasonSet.has(raw.reason))) ||
    (raw.guardStatus !== null &&
      (typeof raw.guardStatus !== "string" ||
        !remoteBrowserPreSubmitGuardStatusSet.has(raw.guardStatus))) ||
    (raw.exactReadReason !== null &&
      (typeof raw.exactReadReason !== "string" ||
        !remoteBrowserPreSubmitExactReadReasonSet.has(raw.exactReadReason)))
  ) {
    return null;
  }
  for (const key of [
    "composerBindingVerified",
    "modelVerified",
    "modeVerified",
    "privateModelProofAttempted",
    "privateModelProofValid",
    "guardInstalled",
    "exactPromptVerified",
    "attachmentStateVerified",
    "focusVerified",
    "exactReadVerified",
    "selectionRestored",
    "focusPreserved",
  ] as const) {
    if (raw[key] !== null && typeof raw[key] !== "boolean") return null;
  }
  for (const key of ["modelSignalCount", "modeSignalCount"] as const) {
    if (
      raw[key] !== null &&
      (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0 || (raw[key] as number) > 64)
    ) {
      return null;
    }
  }
  return {
    schema: REMOTE_BROWSER_PRE_SUBMIT_DIAGNOSTIC_SCHEMA,
    stage: "model-selection",
    code: raw.code as RemoteBrowserPreSubmitDiagnosticCode,
    reason: raw.reason as RemoteBrowserPreSubmitReason | null,
    composerBindingVerified: raw.composerBindingVerified as boolean | null,
    modelVerified: raw.modelVerified as boolean | null,
    modeVerified: raw.modeVerified as boolean | null,
    modelSignalCount: raw.modelSignalCount as number | null,
    modeSignalCount: raw.modeSignalCount as number | null,
    privateModelProofAttempted: raw.privateModelProofAttempted as boolean | null,
    privateModelProofValid: raw.privateModelProofValid as boolean | null,
    guardInstalled: raw.guardInstalled as boolean | null,
    guardStatus: raw.guardStatus as RemoteBrowserPreSubmitGuardStatus | null,
    exactPromptVerified: raw.exactPromptVerified as boolean | null,
    attachmentStateVerified: raw.attachmentStateVerified as boolean | null,
    focusVerified: raw.focusVerified as boolean | null,
    exactReadVerified: raw.exactReadVerified as boolean | null,
    exactReadReason: raw.exactReadReason as RemoteBrowserPreSubmitExactReadReason | null,
    selectionRestored: raw.selectionRestored as boolean | null,
    focusPreserved: raw.focusPreserved as boolean | null,
  };
}

export const REMOTE_BROWSER_RECOVERY_ADMISSION_HEADERS = {
  protocol: "x-oracle-browser-recovery-protocol",
  promptPreviewAlgorithm: "x-oracle-prompt-preview-algorithm",
  promptDomIdentityAlgorithm: "x-oracle-prompt-dom-identity-algorithm",
  terminalRetryPolicy: "x-oracle-terminal-retry-policy",
} as const;

export const REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES = {
  [REMOTE_BROWSER_RECOVERY_ADMISSION_HEADERS.protocol]: REMOTE_BROWSER_RECOVERY_PROTOCOL,
  [REMOTE_BROWSER_RECOVERY_ADMISSION_HEADERS.promptPreviewAlgorithm]:
    PROMPT_RECOVERY_PREVIEW_ALGORITHM,
  [REMOTE_BROWSER_RECOVERY_ADMISSION_HEADERS.promptDomIdentityAlgorithm]:
    PROMPT_DOM_IDENTITY_ALGORITHM,
  [REMOTE_BROWSER_RECOVERY_ADMISSION_HEADERS.terminalRetryPolicy]:
    REMOTE_BROWSER_TERMINAL_RETRY_POLICY,
} as const;

/** Private request/response headers used only for the out-of-band durable claim lookup. */
export const REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS = {
  claimKey: "x-oracle-recovery-claim-key",
  accountId: "x-oracle-recovery-account-id",
  originRunId: "x-oracle-recovery-origin-run-id",
  /** Request coordinate echoed by a direct worker or minted by the trusted router as route proof. */
  originLaneId: "x-oracle-recovery-origin-lane-id",
  /** Comma-separated canonical set of one or two authorized preview hashes. */
  promptPreviewSha256: "x-oracle-recovery-prompt-preview-sha256",
} as const;

export type RemoteActiveRunPhase = "running" | "completed";

export type RemoteRunReadinessState =
  | "idle-ready"
  | "admitting"
  | "active-run-client-connected"
  | "active-run-client-disconnected"
  | "completed-but-not-finalized"
  | "wedged-no-progress"
  | "substrate-broken";

export interface RemoteAttachmentPayload {
  fileName: string;
  displayPath: string;
  sizeBytes: number;
  sha256: string;
  generatedBundle: boolean;
  contentBase64: string;
}

export interface RemotePromptFallbackPolicy {
  attachmentsPolicy: "auto";
  bundleRequested: false;
  model: "gpt-5.6-sol";
  maxInputTokens: number;
}

export interface RemoteRunPayload {
  /** Redundant body marker; the request path and admission headers are authoritative. */
  schema?: typeof REMOTE_BROWSER_RUN_SCHEMA;
  prompt: string;
  attachments: RemoteAttachmentPayload[];
  fallbackSubmission?: {
    prompt: string;
    attachments: RemoteAttachmentPayload[];
  };
  fallbackPolicy?: RemotePromptFallbackPolicy;
  browserConfig: BrowserSessionConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
    sessionId?: string;
    followUpPrompts?: string[];
    /**
     * Caller-supplied idempotency/dedup key, recorded verbatim as job_id in
     * the worker's oracle.run.v1 sink line so scheduling tooling can join
     * runs to jobs; never interpreted by the worker.
     */
    jobId?: string;
    /**
     * Concurrency bucket the scheduler placed this run into (c=1/2/3),
     * recorded verbatim as scheduled_concurrency in the oracle.run.v1 sink
     * line for overlap-metric joins; never interpreted by the worker.
     */
    scheduledConcurrency?: number;
  };
}

export interface RemoteArtifactCapabilities {
  artifactTransfer: boolean;
  artifactProtocolVersion: number;
  maxArtifactBytes: number;
  browserRecovery?: RemoteBrowserRecoveryCapabilities;
}

export interface RemoteBrowserRecoveryCapabilities {
  protocol: typeof REMOTE_BROWSER_RECOVERY_PROTOCOL;
  promptPreviewAlgorithm: typeof PROMPT_RECOVERY_PREVIEW_ALGORITHM;
  promptDomIdentityAlgorithm: typeof PROMPT_DOM_IDENTITY_ALGORITHM;
  /** A severed run stream can recover its capability through a durable authenticated lookup. */
  durableClaimLookup: true;
  /** Terminal retry advice is derived only from Oracle's closed error-class allowlist. */
  terminalRetryPolicy: typeof REMOTE_BROWSER_TERMINAL_RETRY_POLICY;
}

export interface RemoteArtifactDescriptor {
  artifactId: string;
  runId: string;
  kind: "file";
  filename: string;
  label?: string;
  mimeType?: string;
  byteSize: number;
  sha256: string;
  validation?: SessionArtifactValidation;
  sourceUrlKind: "sandbox" | "chatgpt-file-endpoint" | "browser-download";
  transferStatus: "ready" | "streaming" | "completed" | "failed" | "skipped";
}

export interface RemoteAttachmentIntegrityEntry {
  index: number;
  originalName: string;
  storedName: string;
  bytes: number;
  sha256: string;
}

/**
 * Upload-plumbing proof for a run's attachments: the exact bytes staged on
 * the host, under collision-proof stored names, with their hashes. The
 * browser-side pre-Send composer check consumes the same stored names, so
 * chip presence is joinable to these entries. This proves PLUMBING (the
 * right bytes were staged and offered to the composer) — it does NOT prove
 * the model read the files.
 */
export interface RemoteUploadIntegrity {
  attachments: RemoteAttachmentIntegrityEntry[];
  fallbackAttachments?: RemoteAttachmentIntegrityEntry[];
  /** Null on the pre-browser staging event; terminal outcome identifies what crossed Send. */
  submittedBranch: "primary" | "fallback" | null;
  submittedTransport: BrowserSubmissionTransport | null;
  fallbackUsed: boolean | null;
  fallbackReason: BrowserPromptFallbackReason | null;
  preSendDomCheck: "composer-chips-by-stored-name" | "not-applicable" | null;
}

/**
 * What the worker actually verified for a run. Provenance proves PLUMBING
 * (the right model was selected, the capture was bound to this run's own
 * submitted message, no challenge/quarantine was latched) — it does NOT
 * prove the answer is correct. Unknown facts are null, never guessed.
 */
export interface RemoteRunProvenanceSummary {
  modelVerified: boolean | null;
  modelRequested: string | null;
  modelResolved: string | null;
  requestedModelLabel?: string | null;
  resolvedModelLabel?: string | null;
  modelLabelVerified?: boolean | null;
  requestedMode?: string | null;
  resolvedModeLabel?: string | null;
  modeVerified?: boolean | null;
  verifiedBeforePromptSubmit?: boolean | null;
  captureBindingVerified: boolean | null;
  /**
   * Strength tier of a passed capture-binding validation:
   * "message-handle" is full structural verification (the captured reply is
   * provably bound to this run's own submitted message); "guessed" and
   * "conversation-only" are degraded conversation-level verification only.
   * `captureBindingVerified: true` alone therefore does NOT imply full
   * structural binding — consumers needing the strong guarantee must also
   * require quality "message-handle". Null when unverified, when validation
   * failed, or when the worker's log did not report a recognizable tier.
   */
  captureBindingQuality: SubmittedMessageBindingQuality | null;
  challengeClean: boolean | null;
  /** Exact prompt/transport branch that crossed the initial Send boundary. */
  submission: BrowserSubmissionProvenance | null;
}

export const REMOTE_RUN_RECOVERY_STAGES = [
  "assistant-timeout",
  "assistant-recheck",
  "capture-binding",
  "submit-prompt",
  "connection-lost",
  "cloudflare-challenge",
] as const;

export type RemoteRunRecoveryStage = (typeof REMOTE_RUN_RECOVERY_STAGES)[number];

export const REMOTE_SESSION_RECOVERY_STAGES = [
  "assistant-timeout",
  "assistant-recheck",
  "capture-binding",
  "submit-prompt",
  "connection-lost",
] as const satisfies readonly RemoteRunRecoveryStage[];

export type RemoteSessionRecoveryStage = (typeof REMOTE_SESSION_RECOVERY_STAGES)[number];

/**
 * Narrow, host-sanitized recovery evidence for a failed remote browser run.
 * Worker-local CDP endpoints, process IDs, profile paths, and diagnostics are
 * deliberately excluded. The durable ChatGPT identity preserves the recovery
 * coordinate; the client records account/lane attribution separately from the
 * authenticated response headers so an operator can reopen it on the account
 * that created it.
 */
export interface RemoteRunRecoveryHint {
  category: "browser-automation";
  stage: RemoteRunRecoveryStage;
  /** Run that crossed the prompt-submit boundary and minted this capability. */
  originRunId: string;
  /** Absolute expiry for the opaque recovery capability. */
  expiresAt: string;
  /** Opaque HMAC capability; persist for reattach but never print or log it. */
  capability: string;
  /** Canonicalizer used before hashing the bounded prompt discovery preview. */
  promptPreviewAlgorithm: typeof PROMPT_RECOVERY_PREVIEW_ALGORITHM;
  /** Hash of the canonical bounded prompt preview; lets the client select it from known candidates. */
  promptPreviewSha256: string;
  /** Canonical rendered-DOM identity algorithm used before hashing the complete committed turn. */
  promptDomIdentityAlgorithm: typeof PROMPT_DOM_IDENTITY_ALGORITHM;
  /** Hash of the full normalized committed user-turn DOM text; opaque outside the browser worker. */
  promptDomSha256: string;
  runtime: {
    tabUrl: string;
    conversationId: string;
    /** Recovery is offered only after the worker proved the prompt was submitted. */
    promptSubmitted: true;
  };
}

/**
 * Recovery-only request sent to POST /recover. It carries no prompt body and
 * cannot submit a new turn. The account coordinate is deliberately excluded
 * from JSON: the authenticated routing header is independently verified by
 * the destination worker before any Chrome/CDP operation.
 */
export interface RemoteBrowserRecoveryRequest {
  schema: typeof REMOTE_BROWSER_RECOVERY_PROTOCOL;
  recovery: RemoteRunRecoveryHint & { stage: RemoteSessionRecoveryStage };
  /** Bounded saved prompt preview used only to discover candidates; the signed DOM digest proves ownership. */
  promptPreview: string;
  browserConfig: BrowserSessionConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
    sessionId?: string;
  };
}

/** Successful, authenticated response from the durable recovery-claim lookup. */
export interface RemoteBrowserRecoveryClaimLookupResponse {
  schema: typeof REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA;
  status: "ready";
  originRunId: string;
  originLaneId: string;
  recovery: RemoteRunRecoveryHint & { stage: RemoteSessionRecoveryStage };
}

export type RemoteRunEvent =
  // `runId` is stamped onto every event by the server so each NDJSON line of a
  // run is joinable end-to-end (client logs, server logs, forensics) even when
  // a run fails early. Optional in the type so hand-built client fixtures stay
  // valid; the server always emits it.
  | { type: "log"; message: string; runId?: string }
  | { type: "artifact-ready"; runId: string; artifact: RemoteArtifactDescriptor }
  | {
      type: "artifact-progress";
      artifactId: string;
      receivedBytes?: number;
      totalBytes?: number;
      phase: "download" | "transfer" | "validate";
      runId?: string;
    }
  | { type: "attachment-manifest"; uploadIntegrity: RemoteUploadIntegrity; runId?: string }
  /**
   * NON-AUTHORITATIVE legacy event. The caller-usable answer travels ONLY in
   * the terminal `done` event; clients must ignore `result` events and treat
   * a stream that ends without `done` as a failure. Kept in the union so
   * fixtures/parsers stay type-checked while the fleet transitions.
   */
  | {
      type: "result";
      result: BrowserRunResult;
      uploadIntegrity?: RemoteUploadIntegrity;
      runId?: string;
    }
  /**
   * TERMINAL event — exactly one per accepted run, always the last line the
   * server writes. Success is defined as done.ok === true; the answer payload
   * is carried here and nowhere else. On failure `errorClass` is one of the
   * typed retry classes and `retryable` states whether an automatic retry is
   * permissible (post-submit and quarantine failures are never auto-retried).
   */
  | {
      type: "done";
      ok: boolean;
      runId?: string;
      errorClass?: RunErrorClass | null;
      errorMessage?: string;
      retryable?: boolean | null;
      preSubmitDiagnostic?: RemoteBrowserPreSubmitDiagnosticV1;
      provenance?: RemoteRunProvenanceSummary;
      recovery?: RemoteRunRecoveryHint;
      result?: BrowserRunResult;
      uploadIntegrity?: RemoteUploadIntegrity;
    }
  | { type: "error"; message: string; runId?: string };

export interface RemoteActiveRunInfo {
  id: string;
  startedAt: string;
  ageSeconds: number;
  clientConnected: boolean;
  promptChars: number;
  phase?: RemoteActiveRunPhase;
  completedAt?: string;
  completedAgeSeconds?: number;
  sessionId?: string;
  desiredModel?: string;
}

export interface SerializedAttachment extends BrowserAttachment {
  fileName: string;
  contentBase64: string;
}

export interface RemoteBrowserEndpointV1 {
  _schema: "remote_browser_endpoint.v1";
  endpoint_id: string;
  mode: "preferred" | "required" | "off";
  status:
    | "healthy"
    | "busy"
    | "unreachable"
    | "auth_failed"
    | "missing_token"
    | "not_configured"
    | "incompatible"
    | "unknown";
  host_env: string | null;
  token_env: string | null;
  host_hash: string | null;
  auth_profile_id_hash: string | null;
  no_plaintext_secrets: boolean;
  shared_profile_policy: boolean;
  provider_locks: string[];
  doctor_command: string;
  recover_command: string;
  version: string | null;
  build?: OracleBuildInfo | null;
  uptimeSeconds: number | null;
  browser_recovery?: {
    compatible: boolean;
    protocol: string | null;
    prompt_preview_algorithm: string | null;
    prompt_dom_identity_algorithm: string | null;
    durable_claim_lookup: boolean | null;
    terminal_retry_policy: string | null;
  } | null;
  busy?: boolean;
  activeRun?: RemoteActiveRunInfo | null;
  error?: string;
}

export const REMOTE_FLEET_SLOTS_SCHEMA_VERSION = "remote_fleet_slots.v1" as const;

export type RemoteFleetSlotStatus =
  | "healthy"
  | "busy"
  | "disconnected"
  | "completed-but-not-finalized"
  | "wedged"
  | "substrate-broken"
  | "unreachable"
  | "auth_failed"
  | "missing_token"
  | "not_configured"
  | "legacy"
  | "unknown";

export type RemoteSlotInventorySource =
  | "configured-remote"
  | "explicit-hosts"
  | "env-hosts"
  | "none";

export type RemoteSlotNextActionCode =
  | "ready"
  | "wait"
  | "watch_abort"
  | "wait_finalize"
  | "drain_and_inspect"
  | "start_chrome"
  | "repair_chrome_owner"
  | "manual_quarantine_clear"
  | "fix_lease_registry"
  | "check_service_network"
  | "fix_token"
  | "set_token"
  | "upgrade_worker"
  | "configure_lane_inventory"
  | "inspect";

export interface RemoteFleetSlotsV1 {
  _schema: typeof REMOTE_FLEET_SLOTS_SCHEMA_VERSION;
  generated_at: string;
  no_plaintext_secrets: true;
  inventory: {
    source: RemoteSlotInventorySource;
    complete: boolean;
    configured_endpoint_id: string | null;
    configured_host_hash: string | null;
    notes: string[];
  };
  summary: {
    total: number;
    healthy: number;
    busy: number;
    disconnected: number;
    completed_but_not_finalized: number;
    wedged: number;
    substrate_broken: number;
    unreachable: number;
    auth_failed: number;
    missing_token: number;
    not_configured: number;
    legacy: number;
    unknown: number;
    read_only: true;
  };
  lanes: RemoteFleetSlotLaneV1[];
  problems: RemoteFleetSlotsProblem[];
}

export interface RemoteFleetSlotsProblem {
  code: string;
  message: string;
}

export interface RemoteFleetSlotLaneV1 {
  lane_id: string | null;
  account_id: string | null;
  endpoint_id: string;
  host_hash: string | null;
  port: number | null;
  status: RemoteFleetSlotStatus;
  readiness_state: RemoteRunReadinessState | null;
  ok: boolean;
  http_status: number | null;
  version: string | null;
  build: OracleBuildInfo | null;
  observed_at: string;
  reason: string | null;
  probe: {
    primary_endpoint: "/ready" | "/health" | "/status" | null;
    fallback_endpoint: "/health" | "/status" | null;
    read_only: true;
    timed_out: boolean;
    error: string | null;
  };
  run: {
    run_id: string | null;
    session_id: string | null;
    session_id_hash: string | null;
    session_id_redacted: boolean;
    phase: RemoteActiveRunPhase | null;
    age_seconds: number | null;
    started_at: string | null;
    client_connected: boolean | null;
    completed_at: string | null;
    completed_age_seconds: number | null;
    prompt_chars: number | null;
    desired_model: string | null;
  };
  progress: {
    last_progress_age_seconds: number | null;
    source: "ready.lastProgressAgeSeconds" | null;
  };
  lease: {
    active_count: number | null;
    registry_readable: boolean | null;
    ttl_seconds: number | null;
    ttl_source: string | null;
  };
  substrate: {
    attach_only: boolean | null;
    chrome_reachable: boolean | null;
    chrome_owner_ok: boolean | null;
    cleanup_tainted: boolean | null;
    quarantined: boolean | null;
    manifest_present: boolean | null;
    manifest_match: boolean | null;
    manifest_mismatches: string[];
  };
  compatibility: {
    ready_supported: boolean;
    health_supported: boolean;
    status_supported: boolean | null;
    rich_progress_available: boolean;
    lease_ttl_available: boolean;
  };
  next_action: {
    code: RemoteSlotNextActionCode;
    message: string;
  };
}
