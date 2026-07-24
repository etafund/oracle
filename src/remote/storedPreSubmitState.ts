import type { SessionMetadata } from "../sessionManager.js";
import {
  parseRemoteBrowserPreSubmitDiagnostic,
  type RemoteBrowserPreSubmitDiagnosticV1,
} from "./types.js";

export type StoredRemotePreSubmitState =
  | {
      kind: "definitive-pre-submit";
      diagnostic: RemoteBrowserPreSubmitDiagnosticV1;
    }
  | {
      kind: "malformed";
    }
  | {
      kind: "contradictory";
      diagnostic: RemoteBrowserPreSubmitDiagnosticV1;
      conflicts: string[];
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasSubmissionProvenance(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function hasSuccessfulModelResponse(
  response: NonNullable<SessionMetadata["models"]>[number]["response"],
): boolean {
  if (!response) return false;
  if (isNonEmptyString(response.id) || isNonEmptyString(response.requestId)) {
    return true;
  }
  const status = response.status?.trim().toLowerCase();
  return (
    status === "completed" ||
    status === "complete" ||
    status === "success" ||
    status === "succeeded"
  );
}

function modelRunSuccessConflicts(metadata: SessionMetadata, model?: string): string[] {
  const conflicts: string[] = [];
  for (const [index, run] of (metadata.models ?? []).entries()) {
    if (model !== undefined && run.model !== model) continue;
    const prefix = `models[${index}]`;
    if (run.status === "completed" || run.status === "partial") {
      conflicts.push(`${prefix}.status`);
    }
    if (hasSuccessfulModelResponse(run.response)) {
      conflicts.push(`${prefix}.response`);
    }
    if (run.usage !== undefined) {
      conflicts.push(`${prefix}.usage`);
    }
  }
  return conflicts;
}

/**
 * Durable per-model completion/partial evidence can land before an older runner's
 * top-level session write. Browser admission/failure CASes use this guard so
 * that split-file persistence can never turn a submitted/completed run into a
 * definitive "no prompt was submitted" refusal.
 */
export function hasStoredModelRunSuccessEvidence(
  metadata: SessionMetadata,
  model?: string,
): boolean {
  return modelRunSuccessConflicts(metadata, model).length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const STORED_PRE_SUBMIT_DETAIL_KEYS = new Set([
  "stage",
  "errorClass",
  "retryable",
  "preSubmitDiagnostic",
  "runtime",
]);
const REQUIRED_STORED_PRE_SUBMIT_DETAIL_KEYS = new Set([
  "stage",
  "errorClass",
  "retryable",
  "preSubmitDiagnostic",
]);
const STORED_PRE_SUBMIT_RUNTIME_KEYS = new Set(["promptSubmitted", "submissionProvenance"]);
const FAILED_REMOTE_RUN_KEYS = new Set([
  "runId",
  "accountId",
  "laneId",
  "terminalDoneOk",
  "provenance",
]);

function hasEveryKey(value: Record<string, unknown>, required: ReadonlySet<string>): boolean {
  return [...required].every((key) => Object.hasOwn(value, key));
}

/**
 * Classify the closed, validated diagnostic persisted by a failed remote run.
 *
 * A present-but-invalid envelope is not treated as absent: every non-null
 * result blocks recovery/replay. Only the exact terminal failed-route shape may
 * claim that no prompt was submitted; durable send/success evidence makes the
 * state contradictory instead.
 */
export function classifyStoredRemotePreSubmitState(
  metadata: SessionMetadata,
): StoredRemotePreSubmitState | null {
  const details = metadata.error?.details;
  if (!details || typeof details !== "object" || !Object.hasOwn(details, "preSubmitDiagnostic")) {
    return null;
  }
  if (
    !isPlainRecord(details) ||
    !hasOnlyKeys(details, STORED_PRE_SUBMIT_DETAIL_KEYS) ||
    !hasEveryKey(details, REQUIRED_STORED_PRE_SUBMIT_DETAIL_KEYS)
  ) {
    return { kind: "malformed" };
  }

  const hasErrorRuntime = Object.hasOwn(details, "runtime");
  if (
    hasErrorRuntime &&
    (!isPlainRecord(details.runtime) ||
      !hasOnlyKeys(details.runtime, STORED_PRE_SUBMIT_RUNTIME_KEYS) ||
      (Object.hasOwn(details.runtime, "promptSubmitted") &&
        typeof details.runtime.promptSubmitted !== "boolean"))
  ) {
    return { kind: "malformed" };
  }

  const diagnostic = parseRemoteBrowserPreSubmitDiagnostic(details.preSubmitDiagnostic);
  if (
    !diagnostic ||
    metadata.mode !== "browser" ||
    metadata.error?.category !== "browser-automation" ||
    details.stage !== "remote-run" ||
    details.errorClass !== "integrity_ui_unknown" ||
    details.retryable !== false
  ) {
    return { kind: "malformed" };
  }

  const conflicts: string[] = [];
  const errorRuntime = hasErrorRuntime ? (details.runtime as Record<string, unknown>) : null;
  if (metadata.status !== "error") {
    conflicts.push("status");
  }
  if (errorRuntime?.promptSubmitted === true) {
    conflicts.push("error.details.runtime.promptSubmitted");
  }
  if (hasSubmissionProvenance(errorRuntime?.submissionProvenance)) {
    conflicts.push("error.details.runtime.submissionProvenance");
  }
  if (metadata.browser?.runtime?.promptSubmitted === true) {
    conflicts.push("browser.runtime.promptSubmitted");
  }
  if (hasSubmissionProvenance(metadata.browser?.runtime?.submissionProvenance)) {
    conflicts.push("browser.runtime.submissionProvenance");
  }
  if (metadata.browser?.submittedPromptDomSha256 !== undefined) {
    conflicts.push("browser.submittedPromptDomSha256");
  }
  if (metadata.browser?.remoteRecovery) {
    conflicts.push("browser.remoteRecovery");
  }
  if (metadata.browser?.remoteRecoveryCompletionClaim) {
    conflicts.push("browser.remoteRecoveryCompletionClaim");
  }
  if (metadata.browser?.remoteRun?.terminalDoneOk === true) {
    conflicts.push("browser.remoteRun.terminalDoneOk");
  }
  if (metadata.response !== undefined) {
    conflicts.push("response");
  }
  conflicts.push(...modelRunSuccessConflicts(metadata));

  const failedRun = metadata.browser?.remoteRun;
  if (
    failedRun !== undefined &&
    (!isPlainRecord(failedRun) ||
      !hasOnlyKeys(failedRun, FAILED_REMOTE_RUN_KEYS) ||
      !hasEveryKey(failedRun, FAILED_REMOTE_RUN_KEYS))
  ) {
    return { kind: "malformed" };
  }
  const hasExactFailedRoute =
    failedRun?.terminalDoneOk === false &&
    isNonEmptyString(failedRun.runId) &&
    isNonEmptyString(failedRun.accountId) &&
    isNonEmptyString(failedRun.laneId) &&
    failedRun.provenance === null;
  if (!hasExactFailedRoute) {
    return conflicts.length > 0
      ? { kind: "contradictory", diagnostic, conflicts }
      : { kind: "malformed" };
  }
  return conflicts.length > 0
    ? { kind: "contradictory", diagnostic, conflicts }
    : { kind: "definitive-pre-submit", diagnostic };
}

export function formatStoredRemotePreSubmitRecoveryBlock(
  sessionId: string,
  state: StoredRemotePreSubmitState,
): string {
  if (state.kind === "definitive-pre-submit") {
    return `Stored browser session ${sessionId} has a validated pre-submit integrity refusal (${state.diagnostic.code}); no prompt was submitted. Capture-only recovery is inapplicable, and this failed attempt will not be replayed. Start a new session only after fixing the browser automation failure.`;
  }
  if (state.kind === "malformed") {
    return `Stored browser session ${sessionId} carries a malformed pre-submit diagnostic. Submission state cannot be trusted, so Oracle is refusing both capture recovery and replay. Inspect the stored session metadata and worker logs.`;
  }
  return `Stored browser session ${sessionId} has contradictory pre-submit and submission evidence. Submission state cannot be trusted, so Oracle is refusing both capture recovery and replay. Inspect the stored session metadata and worker logs.`;
}
