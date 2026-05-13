// Barrel: ChatGPT output-capture hardening (oracle-qfl).

export {
  backgroundPending,
  captured,
  emptyOutput,
  isCapturedOk,
  isWaiting,
  needsReattach,
  partial,
  staleTurn,
  type CaptureConfidence,
  type CaptureStatus,
  type CaptureVerdict,
} from "./captureVerdict.js";

export {
  sha256OfText,
  verifyTurnBinding,
  type TurnBindingInput,
  type TurnBindingResult,
} from "./turnBinding.js";

export {
  assertMarkdownPreserved,
  countMarkdownStructure,
  hasBalancedMarkdown,
  type MarkdownGuardInput,
  type MarkdownGuardResult,
  type MarkdownStructureCounts,
} from "./markdownGuard.js";

export {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PRO_HEAVY_WAIT_BUDGET_MS,
  DEFAULT_PRO_WAIT_BUDGET_MS,
  MIN_HEARTBEAT_INTERVAL_MS,
  decideProLongWait,
  decisionMentionsAnswerNowClick,
  isTerminalDecision,
  type ObservedThinkingState,
  type ProLongWaitDecision,
  type ProLongWaitInput,
} from "./proLongWait.js";
