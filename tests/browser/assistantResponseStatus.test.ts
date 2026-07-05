import { createContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildActiveThinkingStatusPredicateJsForTest,
  buildAssistantSnapshotExpressionForTest,
  isAnswerNowPlaceholderTextForTest,
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

  test.each(statusLabels)("suppresses pure status label without a stop button %j", (label) => {
    expect(evaluatePredicate(label, false)).toBe(true);
  });

  test("does not suppress normal text while generation is active", () => {
    expect(evaluatePredicate("Thinking about the design, use Postgres.", true)).toBe(false);
  });

  test("rejects bare Answer now placeholder captures", () => {
    expect(isAnswerNowPlaceholderTextForTest("Answer now")).toBe(true);
    expect(isAnswerNowPlaceholderTextForTest("Answer now Edit")).toBe(true);
    expect(isAnswerNowPlaceholderTextForTest("Do not click Answer now; wait.")).toBe(false);
  });

  test("uses the active-status predicate in snapshot capture", () => {
    const expression = buildAssistantSnapshotExpressionForTest();
    expect(expression).toContain("isActiveThinkingStatus");
    expect(expression).toContain("normalized === 'answer now'");
    expect(expression).toContain("Pure thinking/status labels are placeholders");
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

  test("accepts compact finished answers even if the stop button lingers", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: true,
        completionVisible: true,
        thinkingActive: false,
        currentLength: 30,
        stableCycles: 10,
        requiredStableCycles: 10,
        completionStableTarget: 8,
        stableMs: 12_500,
        minStableMs: 1200,
      }),
    ).toBe(true);
  });

  test("does not accept substantial answers while the stop button remains visible", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: true,
        completionVisible: true,
        thinkingActive: false,
        currentLength: 600,
        stableCycles: 30,
        requiredStableCycles: 10,
        completionStableTarget: 8,
        stableMs: 60_000,
        minStableMs: 3000,
      }),
    ).toBe(false);
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

  test("does not trust preamble-sized finished controls until they stay idle longer", () => {
    const state = {
      stopVisible: false,
      completionVisible: true,
      thinkingActive: false,
      currentLength: 180,
      stableCycles: 30,
      requiredStableCycles: 8,
      completionStableTarget: 6,
      minStableMs: 2000,
    };
    expect(shouldAcceptStableAssistantSnapshotForTest({ ...state, stableMs: 30_000 })).toBe(false);
    expect(shouldAcceptStableAssistantSnapshotForTest({ ...state, stableMs: 60_000 })).toBe(true);
  });

  test("does not accept substantial idle output without finished controls", () => {
    // Regression for Pro review preambles: even a long stable idle window is
    // not proof of finality when ChatGPT hides the stop button mid-turn.
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
    ).toBe(false);
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

  test("does not accept a one-character answer on bare stop-button absence", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: false,
        completionVisible: false,
        thinkingActive: false,
        currentLength: 1,
        stableCycles: 30,
        requiredStableCycles: 12,
        completionStableTarget: 12,
        stableMs: 30_000,
        minStableMs: 8000,
      }),
    ).toBe(false);
  });
});
