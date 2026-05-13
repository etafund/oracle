// Turn-binding check: the captured assistant turn must belong to the
// current prompt submission, not a prior conversation entry that
// happens to still be visible.
//
// Stale-turn capture is the most common Oracle output failure: the
// DOM probe finds *some* assistant element but it belongs to the
// previous round of the conversation. This module verifies the bind.

import { createHash } from "node:crypto";

import { staleTurn, type CaptureVerdict } from "./captureVerdict.js";

export interface TurnBindingInput {
  /**
   * Total turn count observed at prompt-submit time. The first new
   * assistant turn after submission must be at index `baselineTurns`
   * (zero-based) or higher — anything lower is a stale capture.
   */
  readonly baselineTurns: number;
  /** Turn index of the assistant message that was actually captured. */
  readonly observedTurnIndex: number;
  /** Optional DOM-assigned turn id. */
  readonly turnId?: string | null;
  /**
   * Optional prompt sha256. When provided alongside `observedPromptSha256`,
   * the binding verifier confirms the matching user turn's prompt text
   * hashes to the expected value.
   */
  readonly expectedPromptSha256?: `sha256:${string}` | null;
  readonly observedPromptSha256?: `sha256:${string}` | null;
}

export interface TurnBindingResult {
  /** True iff the captured turn belongs to the current submission. */
  bound: boolean;
  /** Detail string explaining the verdict. */
  reason: string;
  /** Convenience: when bound=false, a ready-made stale-turn verdict. */
  staleVerdict: CaptureVerdict | null;
}

/**
 * Verify that the captured turn is the one we expect. Returns
 * `{ bound: true }` when the turn index is at or past the baseline and
 * (if provided) the prompt sha256s match. Otherwise returns a stale
 * verdict the caller can pass straight to the FSM.
 */
export function verifyTurnBinding(input: TurnBindingInput): TurnBindingResult {
  if (!Number.isInteger(input.baselineTurns) || input.baselineTurns < 0) {
    return {
      bound: false,
      reason: `baselineTurns must be a non-negative integer (got ${input.baselineTurns})`,
      staleVerdict: staleTurn({
        expectedTurnIndex: 0,
        observedTurnIndex: input.observedTurnIndex,
        turnId: input.turnId,
      }),
    };
  }
  if (!Number.isInteger(input.observedTurnIndex) || input.observedTurnIndex < 0) {
    return {
      bound: false,
      reason: `observedTurnIndex must be a non-negative integer (got ${input.observedTurnIndex})`,
      staleVerdict: staleTurn({
        expectedTurnIndex: input.baselineTurns,
        observedTurnIndex: input.observedTurnIndex,
        turnId: input.turnId,
      }),
    };
  }

  if (input.observedTurnIndex < input.baselineTurns) {
    return {
      bound: false,
      reason: `observed turn ${input.observedTurnIndex} predates baseline ${input.baselineTurns}`,
      staleVerdict: staleTurn({
        expectedTurnIndex: input.baselineTurns,
        observedTurnIndex: input.observedTurnIndex,
        turnId: input.turnId,
      }),
    };
  }

  if (
    input.expectedPromptSha256 &&
    input.observedPromptSha256 &&
    input.expectedPromptSha256 !== input.observedPromptSha256
  ) {
    return {
      bound: false,
      reason: `expected user prompt ${input.expectedPromptSha256} but the matched turn references ${input.observedPromptSha256}`,
      staleVerdict: staleTurn({
        expectedTurnIndex: input.baselineTurns,
        observedTurnIndex: input.observedTurnIndex,
        turnId: input.turnId,
      }),
    };
  }

  return { bound: true, reason: "turn binding verified", staleVerdict: null };
}

/**
 * Compute a sha256 over canonicalised text bytes. Exposed for tests
 * that need to build matching expected/observed prompt hashes without
 * reaching into the v18 evidence module.
 */
export function sha256OfText(text: string): `sha256:${string}` {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `sha256:${digest}`;
}
