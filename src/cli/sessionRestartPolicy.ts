import type { SessionMetadata } from "../sessionManager.js";
import { isRetryableRunErrorClass, isRunErrorClass } from "../remote/run_event_sink.js";

export interface BrowserRestartDecision {
  allowed: boolean;
  reason:
    | "not-browser"
    | "explicit-retryable-pre-submit"
    | "prompt-submitted"
    | "not-proven-pre-submit";
}

function detailsRecord(metadata: SessionMetadata): Record<string, unknown> {
  return metadata.error?.details ?? {};
}

function submittedFromDetails(details: Record<string, unknown>): boolean | undefined {
  const runtime = details.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return undefined;
  const submitted = (runtime as Record<string, unknown>).promptSubmitted;
  return typeof submitted === "boolean" ? submitted : undefined;
}

/**
 * A browser restart is a new paid submission. Permit it only when stored,
 * typed evidence proves the prior attempt was both pre-submit and retryable;
 * unknown/legacy state fails closed to account-affine recovery.
 */
export function evaluateBrowserRestart(metadata: SessionMetadata): BrowserRestartDecision {
  const mode = metadata.mode ?? metadata.options?.mode;
  if (mode !== "browser") return { allowed: true, reason: "not-browser" };

  const details = detailsRecord(metadata);
  const submitted =
    metadata.browser?.runtime?.promptSubmitted ?? submittedFromDetails(details) ?? undefined;
  if (submitted === true || metadata.browser?.remoteRecovery) {
    return { allowed: false, reason: "prompt-submitted" };
  }

  const errorClassValue = details.errorClass ?? details.oracleErrorClass;
  const explicitlyRetryable = details.retryable === true;
  const typedRemotePreSubmit =
    isRunErrorClass(errorClassValue) && isRetryableRunErrorClass(errorClassValue);
  const typedLocalPreSubmit = submitted === false;
  if (
    metadata.status === "error" &&
    explicitlyRetryable &&
    (typedRemotePreSubmit || typedLocalPreSubmit)
  ) {
    return { allowed: true, reason: "explicit-retryable-pre-submit" };
  }

  return { allowed: false, reason: "not-proven-pre-submit" };
}
