// Thin wrapper that wires the ChatGPT Pro verification state machine
// into the browser provider surface. Keeping this here (rather than
// inside chatgptDomProvider.ts) preserves the boundary between the
// provider's runtime entry points and the v18 verification FSM.
//
// Consumers:
//   - oracle-bag (ChatGPT Pro formal-plan + synthesis routes) drives
//     the machine through its DOM probes.
//   - oracle-6ll (CLI doctor/lease wiring) reads the machine state to
//     decide whether to emit a verified-or-blocked envelope.

import {
  errorCodeForFailure,
  isFailureState,
  isSuccessState,
  type ChatGptProEvent,
  type ChatGptProMachine,
  type ChatGptProState,
} from "../state/chatgptPro.js";
import type { V18ErrorCode } from "../../oracle/v18/json_envelope.js";

export type {
  ChatGptProContext,
  ChatGptProEvent,
  ChatGptProFailureState,
  ChatGptProLegalState,
  ChatGptProMachine,
  ChatGptProState,
} from "../state/chatgptPro.js";
export {
  CHATGPT_PRO_FAILURE_STATES,
  CHATGPT_PRO_LEGAL_STATES,
  createChatGptProMachine,
  errorCodeForFailure,
  isFailureState,
  isProLabel,
  isSuccessState,
  legalStateRank,
  transition,
} from "../state/chatgptPro.js";

/**
 * Drive a machine through a sequence of events. The reducer short-
 * circuits on the first failure state — once an absorbing failure is
 * reached, remaining events are not applied so the resulting machine
 * preserves the original failure reason.
 */
export function applyChatGptProEvents(
  machine: ChatGptProMachine,
  events: readonly ChatGptProEvent[],
): ChatGptProMachine {
  let current = machine;
  for (const event of events) {
    current = current.send(event);
    if (isFailureState(current.state)) break;
  }
  return current;
}

/**
 * Convenience verdict object for emitting json_envelope.v1 results.
 * The caller still has to wrap this in an envelope; this helper just
 * surfaces the (verified | failureCode) summary.
 */
export interface ChatGptProVerdict {
  state: ChatGptProState;
  verified: boolean;
  errorCode: V18ErrorCode | null;
  failureReason: string | null;
  evidenceId: string | null;
}

export function machineVerdict(machine: ChatGptProMachine): ChatGptProVerdict {
  const verified = isSuccessState(machine.state);
  return {
    state: machine.state,
    verified,
    errorCode: isFailureState(machine.state) ? errorCodeForFailure(machine.state) : null,
    failureReason: machine.context.failureReason,
    evidenceId: machine.context.evidenceId,
  };
}

// ─── Output-capture wiring (oracle-qfl) ──────────────────────────────────────

import {
  captured,
  emptyOutput,
  hasBalancedMarkdown,
  sha256OfText,
  verifyTurnBinding,
  type CaptureConfidence,
  type CaptureVerdict,
  type TurnBindingInput,
} from "../output-capture/index.js";

export {
  // Re-export the output-capture surface so callers downstream of the
  // FSM (formal plan + synthesis routes, doctor preflight) get the
  // entire ChatGPT Pro browser pipeline from one module path.
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PRO_HEAVY_WAIT_BUDGET_MS,
  DEFAULT_PRO_WAIT_BUDGET_MS,
  assertMarkdownPreserved,
  backgroundPending,
  captured,
  countMarkdownStructure,
  decideProLongWait,
  decisionMentionsAnswerNowClick,
  emptyOutput,
  hasBalancedMarkdown,
  isCapturedOk,
  isTerminalDecision,
  isWaiting,
  needsReattach,
  partial,
  sha256OfText,
  staleTurn,
  verifyTurnBinding,
  type CaptureConfidence,
  type CaptureStatus,
  type CaptureVerdict,
  type MarkdownGuardInput,
  type MarkdownGuardResult,
  type ObservedThinkingState,
  type ProLongWaitDecision,
  type ProLongWaitInput,
  type TurnBindingInput,
  type TurnBindingResult,
} from "../output-capture/index.js";

export interface BuildChatGptCaptureVerdictInput {
  /** Captured assistant text bytes. */
  readonly text: string;
  /** DOM-assigned turn id, when known. */
  readonly turnId?: string | null;
  /** DOM-assigned message id, when known. */
  readonly messageId?: string | null;
  /** Caller capture-confidence hint (DOM probe quality). */
  readonly confidenceHint?: CaptureConfidence;
  /** Turn binding inputs; when supplied the verdict short-circuits on stale. */
  readonly turnBinding?: TurnBindingInput;
}

/**
 * Build a single CaptureVerdict from observed DOM text + binding info.
 * Encodes the full output-capture decision tree the bead asks for:
 *
 *   - turn binding failure → stale_turn
 *   - empty text → output_capture_empty
 *   - otherwise → captured, with sha256 + markdown preservation +
 *     confidence rolled in
 */
export function buildChatGptCaptureVerdict(input: BuildChatGptCaptureVerdictInput): CaptureVerdict {
  if (input.turnBinding) {
    const binding = verifyTurnBinding(input.turnBinding);
    if (!binding.bound && binding.staleVerdict) {
      return binding.staleVerdict;
    }
  }

  const bytes = Buffer.byteLength(input.text, "utf8");
  if (bytes === 0) {
    return emptyOutput();
  }

  const sha = sha256OfText(input.text);
  const markdownPreserved = hasBalancedMarkdown(input.text);
  return captured({
    outputTextSha256: sha,
    outputBytes: bytes,
    captureConfidence: input.confidenceHint ?? (markdownPreserved ? "high" : "medium"),
    turnId: input.turnId ?? null,
    messageId: input.messageId ?? null,
    markdownPreserved,
  });
}
