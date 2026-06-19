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
        currentLength: 600,
        stableCycles: 8,
        requiredStableCycles: 10,
        completionStableTarget: 8,
        stableMs: 3000,
        minStableMs: 3000,
      }),
    ).toBe(true);
  });
});
