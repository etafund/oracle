// ChatGPT output capture verdict (oracle-qfl).
//
// `captureVerdict` is the single shape the output-capture helpers
// produce. It rolls up every check the bead's acceptance criteria
// names (turn binding, non-empty, hash, capture confidence, markdown
// preservation, reattach hint) into one record so the caller can wire
// it directly into `browser_evidence.v1` + a `json_envelope.v1`.

import type { V18ErrorCode } from "../../oracle/v18/json_envelope.js";

export type CaptureStatus =
  | "captured" // happy path: response belongs to current turn, non-empty, complete
  | "partial" // interim payload while generation is still in flight
  | "empty" // generation complete but output text is empty
  | "stale_turn" // captured the wrong assistant turn (older message)
  | "background_pending" // documented background state (Pro thinking, Deep Research)
  | "needs_reattach"; // wait budget exhausted; session is reattachable

export type CaptureConfidence = "high" | "medium" | "low";

export interface CaptureVerdict {
  /** Overall status — see decision rules in oracle-qfl. */
  readonly status: CaptureStatus;
  /** sha256 of captured text bytes, or null when nothing was captured. */
  readonly outputTextSha256: `sha256:${string}` | null;
  /** Byte length of captured text. */
  readonly outputBytes: number;
  /** Confidence in the capture — drives provenance fields on the evidence. */
  readonly captureConfidence: CaptureConfidence;
  /** Matched assistant turn id, when the DOM exposed one. */
  readonly turnId: string | null;
  /** Matched assistant message id, when the DOM exposed one. */
  readonly messageId: string | null;
  /** True if markdown structure survived the capture (lists, fences). */
  readonly markdownPreserved: boolean;
  /** Caller-side recovery command when status === "needs_reattach". */
  readonly recoveryCommand: string | null;
  /** v18 error code, when status is not "captured" / "partial" / "background_pending". */
  readonly errorCode: V18ErrorCode | null;
  /** Human-readable detail; safe to log, never carries raw output text. */
  readonly reason: string;
}

const STATUS_TO_CODE: Partial<Record<CaptureStatus, V18ErrorCode>> = {
  empty: "output_capture_empty",
  stale_turn: "output_capture_unverified",
  // `needs_reattach` is not strictly an error — it is a recoverable
  // wait-budget exhaustion. The bead specifies that we return session
  // metadata and a recovery command rather than a failure. We attach
  // `output_capture_unverified` so callers that need to surface an
  // error code (e.g. CI) still have one.
  needs_reattach: "output_capture_unverified",
};

/** Build a captured-OK verdict. */
export function captured(input: {
  outputTextSha256: `sha256:${string}`;
  outputBytes: number;
  captureConfidence: CaptureConfidence;
  turnId: string | null;
  messageId: string | null;
  markdownPreserved: boolean;
  reason?: string;
}): CaptureVerdict {
  return {
    status: "captured",
    outputTextSha256: input.outputTextSha256,
    outputBytes: input.outputBytes,
    captureConfidence: input.captureConfidence,
    turnId: input.turnId,
    messageId: input.messageId,
    markdownPreserved: input.markdownPreserved,
    recoveryCommand: null,
    errorCode: null,
    reason: input.reason ?? "captured",
  };
}

/** Build a partial-capture verdict for generation still in flight. */
export function partial(input: {
  outputTextSha256: `sha256:${string}` | null;
  outputBytes: number;
  captureConfidence: CaptureConfidence;
  turnId: string | null;
  messageId: string | null;
  markdownPreserved: boolean;
  reason?: string;
}): CaptureVerdict {
  return {
    status: "partial",
    outputTextSha256: input.outputTextSha256,
    outputBytes: input.outputBytes,
    captureConfidence: input.captureConfidence,
    turnId: input.turnId,
    messageId: input.messageId,
    markdownPreserved: input.markdownPreserved,
    recoveryCommand: null,
    errorCode: null,
    reason: input.reason ?? "partial capture; generation still in flight",
  };
}

export function emptyOutput(reason = "generation complete but output text is empty"): CaptureVerdict {
  return {
    status: "empty",
    outputTextSha256: null,
    outputBytes: 0,
    captureConfidence: "high",
    turnId: null,
    messageId: null,
    markdownPreserved: false,
    recoveryCommand: null,
    errorCode: STATUS_TO_CODE.empty ?? null,
    reason,
  };
}

export function staleTurn(input: {
  expectedTurnIndex: number;
  observedTurnIndex: number;
  turnId?: string | null;
}): CaptureVerdict {
  return {
    status: "stale_turn",
    outputTextSha256: null,
    outputBytes: 0,
    captureConfidence: "low",
    turnId: input.turnId ?? null,
    messageId: null,
    markdownPreserved: false,
    recoveryCommand: null,
    errorCode: STATUS_TO_CODE.stale_turn ?? null,
    reason: `captured assistant turn ${input.observedTurnIndex} but expected ${input.expectedTurnIndex}`,
  };
}

export function backgroundPending(input: {
  detail: string;
  turnId?: string | null;
}): CaptureVerdict {
  return {
    status: "background_pending",
    outputTextSha256: null,
    outputBytes: 0,
    captureConfidence: "high",
    turnId: input.turnId ?? null,
    messageId: null,
    markdownPreserved: false,
    recoveryCommand: null,
    errorCode: null,
    reason: input.detail,
  };
}

export function needsReattach(input: {
  sessionId: string;
  reason: string;
}): CaptureVerdict {
  return {
    status: "needs_reattach",
    outputTextSha256: null,
    outputBytes: 0,
    captureConfidence: "low",
    turnId: null,
    messageId: null,
    markdownPreserved: false,
    recoveryCommand: `oracle session ${input.sessionId} --render`,
    errorCode: STATUS_TO_CODE.needs_reattach ?? null,
    reason: input.reason,
  };
}

/** Convenience: success surface for the FSM layer. */
export function isCapturedOk(verdict: CaptureVerdict): boolean {
  return verdict.status === "captured";
}

/**
 * True when the verdict represents recoverable waiting state — the
 * caller should NOT mark the run failed. Used by the long-wait
 * controller to decide whether to keep heartbeating.
 */
export function isWaiting(verdict: CaptureVerdict): boolean {
  return (
    verdict.status === "partial" ||
    verdict.status === "background_pending" ||
    verdict.status === "needs_reattach"
  );
}
