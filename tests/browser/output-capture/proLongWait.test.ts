// Unit tests for the Pro long-wait controller (oracle-qfl).
//
// Acceptance criteria from the bead include "no Answer now automation"
// — there's a dedicated invariant test that drives the controller
// through every realistic state and asserts the decision kind never
// suggests clicking the CTA.

import { describe, expect, test } from "vitest";

import {
  DEFAULT_PRO_WAIT_BUDGET_MS,
  decideProLongWait,
  decisionMentionsAnswerNowClick,
  isTerminalDecision,
  type ObservedThinkingState,
  type ProLongWaitDecision,
} from "../../../src/browser/output-capture/index.js";

const BUDGET = DEFAULT_PRO_WAIT_BUDGET_MS;
const HEARTBEAT_INTERVAL = 30_000;

describe("decideProLongWait — terminal capture decisions", () => {
  test("'complete' state → capture", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: 5_000,
      state: "complete",
    });
    expect(decision.kind).toBe("capture");
    expect(isTerminalDecision(decision)).toBe(true);
  });

  test("'complete_empty' state → capture_empty", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: 5_000,
      state: "complete_empty",
    });
    expect(decision.kind).toBe("capture_empty");
    expect(isTerminalDecision(decision)).toBe(true);
  });
});

describe("decideProLongWait — wait decisions", () => {
  test("returns wait while inside the budget", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: 60_000, // 1 min in
      state: "thinking",
    }) as Extract<ProLongWaitDecision, { kind: "wait" }>;
    expect(decision.kind).toBe("wait");
    expect(decision.verdict.status).toBe("background_pending");
    expect(decision.verdict.reason).toMatch(/Elapsed 60000ms/);
    expect(isTerminalDecision(decision)).toBe(false);
  });

  test("emitHeartbeatNow=true at the first interval", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: HEARTBEAT_INTERVAL,
      state: "thinking",
      heartbeatsEmitted: 0,
    }) as Extract<ProLongWaitDecision, { kind: "wait" }>;
    expect(decision.emitHeartbeatNow).toBe(true);
    expect(decision.heartbeatMessage).toMatch(/still waiting/i);
  });

  test("emitHeartbeatNow=false when the caller is up-to-date", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: HEARTBEAT_INTERVAL,
      state: "thinking",
      heartbeatsEmitted: 1,
    }) as Extract<ProLongWaitDecision, { kind: "wait" }>;
    expect(decision.emitHeartbeatNow).toBe(false);
    expect(decision.heartbeatMessage).toBe("");
  });

  test("nextPollMs advances past the current heartbeat boundary", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: HEARTBEAT_INTERVAL,
      state: "thinking",
      heartbeatsEmitted: 1,
    }) as Extract<ProLongWaitDecision, { kind: "wait" }>;
    expect(decision.nextPollMs).toBe(HEARTBEAT_INTERVAL * 2);
  });

  test("heartbeat interval is clamped to a sane floor", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: 100,
      state: "thinking",
      heartbeatIntervalMs: 100, // way below the floor
    }) as Extract<ProLongWaitDecision, { kind: "wait" }>;
    expect(decision.kind).toBe("wait");
    // The clamp keeps the controller from heartbeating every 100ms.
    expect(decision.nextPollMs).toBeGreaterThanOrEqual(5_000);
  });
});

describe("decideProLongWait — Answer now is benign", () => {
  test("answer_now_visible still returns wait (NEVER auto-click)", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: 90_000,
      state: "answer_now_visible",
    }) as Extract<ProLongWaitDecision, { kind: "wait" }>;
    expect(decision.kind).toBe("wait");
    expect(decision.verdict.reason).toMatch(/Answer now/);
    expect(decision.verdict.reason).toMatch(/Oracle policy is to wait/);
  });

  test("INVARIANT: no decision kind from any realistic input represents a click", () => {
    const states: ObservedThinkingState[] = [
      "thinking",
      "answer_now_visible",
      "complete",
      "complete_empty",
      "unknown",
    ];
    const heartbeatsCases = [0, 1, 5, 10];
    const sessions = [
      { sessionIsReattachable: true, sessionId: "s-1" },
      { sessionIsReattachable: false, sessionId: undefined },
    ];
    const elapsedSamples = [
      0,
      30_000,
      5 * 60_000,
      BUDGET - 1,
      BUDGET,
      BUDGET + 60_000,
    ];

    for (const state of states) {
      for (const heartbeatsEmitted of heartbeatsCases) {
        for (const session of sessions) {
          for (const elapsed of elapsedSamples) {
            const decision = decideProLongWait({
              startedAtMs: 0,
              nowMs: elapsed,
              state,
              heartbeatsEmitted,
              ...session,
            });
            // Pure invariant: no decision kind exists that maps to a click.
            expect(decisionMentionsAnswerNowClick(decision)).toBe(false);
            // The decision's verdict (when waiting) never names a click.
            if (decision.kind === "wait") {
              expect(decision.verdict.reason.toLowerCase()).not.toContain("click");
            }
          }
        }
      }
    }
  });
});

describe("decideProLongWait — budget exhaustion + reattach", () => {
  test("budget elapsed + reattachable → reattach with recovery command", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: BUDGET + 1_000,
      state: "thinking",
      sessionIsReattachable: true,
      sessionId: "session-xyz",
    });
    expect(decision.kind).toBe("reattach");
    if (decision.kind === "reattach") {
      expect(decision.verdict.status).toBe("needs_reattach");
      expect(decision.verdict.recoveryCommand).toBe("oracle session session-xyz --render");
    }
  });

  test("budget elapsed + NOT reattachable → escalate (caller decides)", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: BUDGET + 1_000,
      state: "thinking",
      sessionIsReattachable: false,
    });
    expect(decision.kind).toBe("escalate");
  });

  test("does NOT recommend duplicating the run when reattachable", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: BUDGET + 60_000,
      state: "thinking",
      sessionIsReattachable: true,
      sessionId: "session-xyz",
    });
    expect(decision.kind).toBe("reattach");
    if (decision.kind === "reattach") {
      expect(decision.verdict.recoveryCommand).not.toMatch(/duplicate|rerun|--force/i);
    }
  });
});

describe("decideProLongWait — defensive errors", () => {
  test("startedAtMs in the future → escalate (clock skew)", () => {
    const decision = decideProLongWait({ startedAtMs: 1_000, nowMs: 500, state: "thinking" });
    expect(decision.kind).toBe("escalate");
    if (decision.kind === "escalate") {
      expect(decision.reason).toMatch(/clock skew/i);
    }
  });

  test("budgetMs <= 0 → escalate", () => {
    const decision = decideProLongWait({
      startedAtMs: 0,
      nowMs: 100,
      state: "thinking",
      budgetMs: 0,
    });
    expect(decision.kind).toBe("escalate");
  });
});
