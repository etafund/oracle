// Long-wait controller for ChatGPT Pro thinking (oracle-qfl).
//
// AGENTS.md is explicit: Pro browser runs can take up to 10 minutes
// (sometimes an hour for heavy thinking) and Oracle must NEVER click
// the "Answer now" button. This module is a pure scheduler that takes
// observable browser state, makes a decision (`wait`, `capture`,
// `reattach`, `escalate`) and emits a heartbeat schedule. It refuses
// — by construction — to ever emit an "answer_now_click" intent.
//
// The decision function is pure so tests can drive it with synthetic
// clocks without needing a real browser. The driver loop wires it up
// to actual DOM probes + heartbeat sinks.

import { backgroundPending, needsReattach, type CaptureVerdict } from "./captureVerdict.js";

// Default budgets sourced from AGENTS.md:
//   "Pro browser runs: allow up to 10 minutes"
//   "Browser 'Pro thinking' gate: wait 10m–1h for the real assistant response"

export const DEFAULT_PRO_WAIT_BUDGET_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_PRO_HEAVY_WAIT_BUDGET_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 1000; // every 30s
export const MIN_HEARTBEAT_INTERVAL_MS = 5 * 1000; // sanity floor

// ─── Inputs ──────────────────────────────────────────────────────────────────

export type ObservedThinkingState =
  /** Pro thinking sidecar is visible; the assistant is still composing. */
  | "thinking"
  /** "Answer now" CTA is visible. We MUST NOT click it. */
  | "answer_now_visible"
  /** Generation finished and we already captured a non-empty output. */
  | "complete"
  /** Generation finished but the captured output is empty. */
  | "complete_empty"
  /** No thinking indicator and no complete output — generation status unknown. */
  | "unknown";

export interface ProLongWaitInput {
  /** Monotonic millis at which the wait started. */
  readonly startedAtMs: number;
  /** Monotonic millis right now. */
  readonly nowMs: number;
  /** Observed thinking/CTA state from the DOM probe. */
  readonly state: ObservedThinkingState;
  /** Wait budget in ms; defaults to the Pro budget. */
  readonly budgetMs?: number;
  /** Heartbeat interval; defaults to 30 s; clamped to MIN_HEARTBEAT_INTERVAL_MS. */
  readonly heartbeatIntervalMs?: number;
  /** When true, the session is reattachable and we should NOT recommend duplicating the run. */
  readonly sessionIsReattachable?: boolean;
  /** Session id used when emitting a recovery command for needs_reattach. */
  readonly sessionId?: string;
  /** Caller-controlled heartbeats emitted so far; used to gate the next emission. */
  readonly heartbeatsEmitted?: number;
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

export type ProLongWaitDecision =
  | { kind: "capture"; reason: string }
  | { kind: "capture_empty"; reason: string }
  | {
      kind: "wait";
      /** When the caller should poll the DOM again, in monotonic ms. */
      nextPollMs: number;
      /**
       * Whether the controller wants the caller to emit a heartbeat
       * right now. The controller bumps `heartbeatsEmitted` mentally
       * after the caller acts, but never re-emits on its own.
       */
      emitHeartbeatNow: boolean;
      /** Suggested heartbeat message for human-readable logs. */
      heartbeatMessage: string;
      /** Verdict to record while waiting (for browser_evidence.v1 snapshots). */
      verdict: CaptureVerdict;
    }
  | { kind: "reattach"; reason: string; verdict: CaptureVerdict }
  | { kind: "escalate"; reason: string };

/**
 * Decide what to do next during a Pro long-wait. Pure function; the
 * caller supplies wall-clock observations and the function returns a
 * decision plus (when waiting) the next poll time + heartbeat hint.
 *
 * The function NEVER returns an instruction to click "Answer now". The
 * `answer_now_visible` state is treated as a benign placeholder — keep
 * waiting per AGENTS.md.
 */
export function decideProLongWait(input: ProLongWaitInput): ProLongWaitDecision {
  const budgetMs = input.budgetMs ?? DEFAULT_PRO_WAIT_BUDGET_MS;
  const heartbeatIntervalMs = Math.max(
    MIN_HEARTBEAT_INTERVAL_MS,
    input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  );

  if (input.startedAtMs > input.nowMs) {
    return { kind: "escalate", reason: "startedAtMs is in the future; clock skew suspected" };
  }
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return { kind: "escalate", reason: `invalid budgetMs ${budgetMs}` };
  }

  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);

  if (input.state === "complete") {
    return { kind: "capture", reason: `generation complete after ${elapsedMs}ms` };
  }
  if (input.state === "complete_empty") {
    return { kind: "capture_empty", reason: `generation complete but empty after ${elapsedMs}ms` };
  }

  // Budget exhausted: either reattach (preferred) or escalate. We
  // NEVER recommend duplicating the run when the session is
  // reattachable — that is the bead's primary invariant.
  if (elapsedMs >= budgetMs) {
    if (input.sessionIsReattachable && input.sessionId) {
      const verdict = needsReattach({
        sessionId: input.sessionId,
        reason: `Pro long-wait budget (${budgetMs}ms) elapsed; session is reattachable.`,
      });
      return {
        kind: "reattach",
        reason: verdict.reason,
        verdict,
      };
    }
    return {
      kind: "escalate",
      reason: `Pro long-wait budget (${budgetMs}ms) elapsed and session is not reattachable.`,
    };
  }

  // Default path: keep waiting.
  const heartbeatsEmitted = input.heartbeatsEmitted ?? 0;
  const heartbeatsDue = Math.floor(elapsedMs / heartbeatIntervalMs);
  const emitHeartbeatNow = heartbeatsDue > heartbeatsEmitted;
  const nextPollMs = input.startedAtMs + (heartbeatsEmitted + 1) * heartbeatIntervalMs;

  // The wait verdict pins the documented Pro thinking state on the
  // evidence ledger; it does not mark the run as failed.
  const verdict = backgroundPending({
    detail:
      input.state === "answer_now_visible"
        ? `Pro thinking active; "Answer now" CTA visible but Oracle policy is to wait. Elapsed ${elapsedMs}ms.`
        : input.state === "thinking"
          ? `Pro thinking active. Elapsed ${elapsedMs}ms.`
          : `Pro long-wait in progress (state=${input.state}). Elapsed ${elapsedMs}ms.`,
  });

  return {
    kind: "wait",
    nextPollMs,
    emitHeartbeatNow,
    heartbeatMessage: emitHeartbeatNow
      ? `[browser] still waiting for ChatGPT Pro response — ${Math.floor(elapsedMs / 1000)}s elapsed.`
      : "",
    verdict,
  };
}

/**
 * Hard invariant: this controller MUST NEVER produce an instruction
 * that clicks "Answer now". The function is exported so the test suite
 * can assert this property holds across an exhaustive synthesised
 * decision matrix.
 */
export function decisionMentionsAnswerNowClick(decision: ProLongWaitDecision): boolean {
  // We do not have an "answer_now_click" decision kind by design. A
  // future refactor must not introduce one — the test that calls this
  // helper across every realistic input pins that invariant.
  const kinds = ["capture", "capture_empty", "wait", "reattach", "escalate"] as const;
  return !kinds.includes(decision.kind);
}

/**
 * Convenience: returns true when the controller has decided to stop
 * polling (success, empty, reattach, or escalate). Used by the driver
 * loop to break out of its wait loop.
 */
export function isTerminalDecision(decision: ProLongWaitDecision): boolean {
  return decision.kind !== "wait";
}
