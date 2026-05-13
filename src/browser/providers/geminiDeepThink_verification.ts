import {
  geminiDeepThinkErrorCodeForFailure,
  isGeminiDeepThinkFailureState,
  isGeminiDeepThinkSuccessState,
  type GeminiDeepThinkEvent,
  type GeminiDeepThinkMachine,
  type GeminiDeepThinkState,
} from "../state/geminiDeepThink.js";
import type { V18ErrorCode } from "../../oracle/v18/json_envelope.js";

export type {
  GeminiDeepThinkContext,
  GeminiDeepThinkEvent,
  GeminiDeepThinkFailureState,
  GeminiDeepThinkLegalState,
  GeminiDeepThinkMachine,
  GeminiDeepThinkState,
  GeminiDeepThinkVerificationResult,
  GeminiThinkingLevelTier,
  GeminiThinkingLevelTierEntry,
  VerifyGeminiDeepThinkCandidateInput,
} from "../state/geminiDeepThink.js";

export {
  GEMINI_DEEP_THINK_FAILURE_STATES,
  GEMINI_DEEP_THINK_LEGAL_STATES,
  GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
  GEMINI_THINKING_LEVEL_TIERS,
  availableGeminiEffortLabelsHash,
  createGeminiDeepThinkMachine,
  geminiDeepThinkErrorCodeForFailure,
  geminiDeepThinkLegalStateRank,
  isGeminiDeepThinkFailureState,
  isGeminiDeepThinkSuccessState,
  isGeminiModelLabel,
  tierForGeminiThinkingLevel,
  transitionGeminiDeepThink,
  verifyGeminiDeepThinkCandidate,
} from "../state/geminiDeepThink.js";

export function applyGeminiDeepThinkEvents(
  machine: GeminiDeepThinkMachine,
  events: readonly GeminiDeepThinkEvent[],
): GeminiDeepThinkMachine {
  let current = machine;
  for (const event of events) {
    current = current.send(event);
    if (isGeminiDeepThinkFailureState(current.state)) break;
  }
  return current;
}

export interface GeminiDeepThinkVerdict {
  readonly state: GeminiDeepThinkState;
  readonly verified: boolean;
  readonly errorCode: V18ErrorCode | null;
  readonly failureReason: string | null;
  readonly evidenceId: string | null;
}

export function geminiDeepThinkMachineVerdict(
  machine: GeminiDeepThinkMachine,
): GeminiDeepThinkVerdict {
  const verified = isGeminiDeepThinkSuccessState(machine.state);
  return {
    state: machine.state,
    verified,
    errorCode: isGeminiDeepThinkFailureState(machine.state)
      ? geminiDeepThinkErrorCodeForFailure(machine.state)
      : null,
    failureReason: machine.context.failureReason,
    evidenceId: machine.context.evidenceId,
  };
}
