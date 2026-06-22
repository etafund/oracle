import { createContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildActiveThinkingStatusPredicateJsForTest,
  buildAssistantSnapshotExpressionForTest,
  matchesThinkingStatusLabelForTest,
  shouldAcceptStableAssistantSnapshotForTest,
} from "../../src/browser/actions/assistantResponse.js";

function evaluatePredicate(text: string, generating: boolean): boolean {
  const predicate = buildActiveThinkingStatusPredicateJsForTest("isActiveThinkingStatus");
  const context = createContext({
    String,
    document: {
      querySelector: () => (generating ? {} : null),
    },
  });
  return new Script(
    `${predicate}\nisActiveThinkingStatus({ text: ${JSON.stringify(text)} });`,
  ).runInContext(context) as boolean;
}

describe("assistant thinking-status capture", () => {
  const statusLabels = [
    "Pro thinking",
    "Finalizing answer",
    "Thinking",
    "Reading",
    "Thought for 12s",
    "Pro thinking - planning",
  ];

  test.each(statusLabels)("suppresses active status label %j", (label) => {
    expect(matchesThinkingStatusLabelForTest(label)).toBe(true);
    expect(evaluatePredicate(label, true)).toBe(true);
  });

  test.each(statusLabels)("preserves completed exact answer %j", (label) => {
    expect(evaluatePredicate(label, false)).toBe(false);
  });

  test("does not suppress normal text while generation is active", () => {
    expect(evaluatePredicate("Thinking about the design, use Postgres.", true)).toBe(false);
  });

  test("uses the active-status predicate in snapshot capture", () => {
    const expression = buildAssistantSnapshotExpressionForTest();
    expect(expression).toContain("isActiveThinkingStatus");
    expect(expression).toContain('data-testid=\\"stop-button\\"');
    expect(expression).toContain("const fallback = extractFallback();");
  });

  test("accepts compact stable answers when a stale stop button remains", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: true,
        completionVisible: false,
        thinkingActive: false,
        currentLength: "CHECK_REMOTE_GPT55_OK done".length,
        stableCycles: 30,
        requiredStableCycles: 8,
        completionStableTarget: 8,
        stableMs: 12_500,
        minStableMs: 1200,
      }),
    ).toBe(true);
  });

  test("keeps waiting on long answers with only a stop button", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: true,
        completionVisible: false,
        thinkingActive: false,
        currentLength: 600,
        stableCycles: 30,
        requiredStableCycles: 10,
        completionStableTarget: 8,
        stableMs: 45_000,
        minStableMs: 3000,
      }),
    ).toBe(false);
  });

  test("accepts finished action controls even if the stop button lingers", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: true,
        completionVisible: true,
        thinkingActive: false,
        currentLength: 600,
        stableCycles: 8,
        requiredStableCycles: 10,
        completionStableTarget: 8,
        stableMs: 3000,
        minStableMs: 3000,
      }),
    ).toBe(true);
  });

  test("never accepts a snapshot while a Pro thinking indicator is active", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        // Stop button gone + finished controls visible + stable, but thinking is
        // still active — the real answer has not finished, so keep waiting.
        stopVisible: false,
        completionVisible: true,
        thinkingActive: true,
        currentLength: 600,
        stableCycles: 30,
        requiredStableCycles: 8,
        completionStableTarget: 6,
        stableMs: 60_000,
        minStableMs: 2000,
      }),
    ).toBe(false);
  });

  test("does not accept a substantial preamble on bare stop-button absence", () => {
    // Regression for the Pro-thinking truncation: a ~150-char streamed preamble
    // is stable and the stop button has disappeared (thinking pause), but no
    // finished-action controls exist yet. We must keep waiting rather than
    // capture the preamble as the final answer.
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: false,
        completionVisible: false,
        thinkingActive: false,
        currentLength: 152,
        stableCycles: 8,
        requiredStableCycles: 8,
        completionStableTarget: 6,
        stableMs: 3200,
        minStableMs: 2000,
      }),
    ).toBe(false);
  });

  test("accepts a substantial answer once finished-action controls render", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: false,
        completionVisible: true,
        thinkingActive: false,
        currentLength: 600,
        stableCycles: 8,
        requiredStableCycles: 8,
        completionStableTarget: 6,
        stableMs: 3000,
        minStableMs: 2000,
      }),
    ).toBe(true);
  });

  test("accepts a substantial idle answer after a long stable window", () => {
    // Fallback when ChatGPT never renders a copy button: trust stop-button
    // absence only after a much longer idle period.
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: false,
        completionVisible: false,
        thinkingActive: false,
        currentLength: 600,
        stableCycles: 60,
        requiredStableCycles: 10,
        completionStableTarget: 8,
        stableMs: 22_000,
        minStableMs: 3000,
      }),
    ).toBe(true);
  });

  test("still accepts compact answers on bare stop-button absence", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: false,
        completionVisible: false,
        thinkingActive: false,
        currentLength: 30,
        stableCycles: 8,
        requiredStableCycles: 8,
        completionStableTarget: 8,
        stableMs: 2000,
        minStableMs: 1200,
      }),
    ).toBe(true);
  });
});
