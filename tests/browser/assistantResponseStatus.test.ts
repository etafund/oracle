import { createContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildActiveThinkingStatusPredicateJsForTest,
  buildAnswerNowPlaceholderPredicateJsForTest,
  buildAssistantSnapshotExpressionForTest,
  buildStopButtonVisibilityExpressionForTest,
  isAnswerNowPlaceholderTextForTest,
  matchesThinkingStatusLabelForTest,
  shouldAcceptStableAssistantSnapshotForTest,
  shouldConfirmAssistantCompletion,
  shouldReplaceAssistantSnapshotForTest,
} from "../../src/browser/actions/assistantResponse.js";
import { STOP_BUTTON_SELECTORS } from "../../src/browser/constants.js";

function evaluatePredicate(text: string, generating: boolean): boolean {
  const predicate = buildActiveThinkingStatusPredicateJsForTest("isActiveThinkingStatus");
  class FakeHtmlElement {
    getBoundingClientRect() {
      return { width: 120, height: 40 };
    }
  }
  const context = createContext({
    Array,
    Number,
    String,
    HTMLElement: FakeHtmlElement,
    document: {
      querySelectorAll: () => (generating ? [new FakeHtmlElement()] : []),
    },
    window: {
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
  });
  return new Script(
    `${predicate}\nisActiveThinkingStatus({ text: ${JSON.stringify(text)} });`,
  ).runInContext(context) as boolean;
}

function evaluateAnswerNowPredicate(text: string): boolean {
  const predicate = buildAnswerNowPlaceholderPredicateJsForTest("isPlaceholder");
  return new Script(
    `${predicate}\nisPlaceholder({ text: ${JSON.stringify(text)} });`,
  ).runInNewContext({ String }) as boolean;
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

  test("rejects bare and status-combined Answer now placeholder captures", () => {
    expect(isAnswerNowPlaceholderTextForTest("Answer now")).toBe(true);
    expect(isAnswerNowPlaceholderTextForTest("Answer now Edit")).toBe(true);
    expect(isAnswerNowPlaceholderTextForTest("Finalizing answer\nAnswer now")).toBe(true);
    expect(isAnswerNowPlaceholderTextForTest("Thinking · Answer now · Edit")).toBe(true);
    expect(evaluateAnswerNowPredicate("Finalizing answer\nAnswer now")).toBe(true);
    expect(evaluateAnswerNowPredicate("Thinking · Answer now · Edit")).toBe(true);
    expect(isAnswerNowPlaceholderTextForTest("Do not click Answer now; wait.")).toBe(false);
    expect(evaluateAnswerNowPredicate("Do not click Answer now; wait.")).toBe(false);
    const explanatoryProse =
      "In Pro thinking mode, Answer now is an interrupt control; Oracle must wait for the complete response.";
    expect(isAnswerNowPlaceholderTextForTest(explanatoryProse)).toBe(false);
    expect(evaluateAnswerNowPredicate(explanatoryProse)).toBe(false);
    expect(
      isAnswerNowPlaceholderTextForTest(
        "While finalizing the answer, do not click Answer now; the explanation follows.",
      ),
    ).toBe(false);
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

  test("requires a longer calm window for preamble-sized output after thinking was observed", () => {
    const state = {
      stopVisible: false,
      completionVisible: true,
      thinkingActive: false,
      thinkingObserved: true,
      currentLength: 180,
      stableCycles: 30,
      requiredStableCycles: 8,
      completionStableTarget: 6,
      minStableMs: 2000,
    };
    expect(shouldAcceptStableAssistantSnapshotForTest({ ...state, stableMs: 240_000 })).toBe(
      false,
    );
    expect(shouldAcceptStableAssistantSnapshotForTest({ ...state, stableMs: 300_000 })).toBe(
      true,
    );
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

  // Regression: lr-plan-gap-r2b/r2c returned the literal section heading
  // "1) Verdict" (10 chars) for a 333k-char structured-review prompt. The
  // stream had paused mid-thinking with the stop button hidden, and the bare
  // compact fast path accepted the fragment. Minutes into a run, a compact
  // answer needs finished-action controls, not just stability.
  test("rejects a bare compact answer once the wait is in thinking-model territory", () => {
    const state = {
      stopVisible: false,
      completionVisible: false,
      thinkingActive: false,
      currentLength: 10,
      stableCycles: 30,
      requiredStableCycles: 12,
      completionStableTarget: 12,
      stableMs: 30_000,
      minStableMs: 8000,
    };
    expect(shouldAcceptStableAssistantSnapshotForTest({ ...state, elapsedMs: 30_000 })).toBe(false);
    expect(shouldAcceptStableAssistantSnapshotForTest({ ...state, elapsedMs: 120_000 })).toBe(
      false,
    );
  });

  test("still accepts a long-elapsed compact answer once finished controls render", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: false,
        completionVisible: true,
        thinkingActive: false,
        currentLength: 10,
        stableCycles: 30,
        requiredStableCycles: 12,
        completionStableTarget: 12,
        stableMs: 30_000,
        minStableMs: 8000,
        elapsedMs: 240_000,
      }),
    ).toBe(true);
  });

  test("shares all stop-control selectors with completion capture", () => {
    let observedSelector = "";
    new Script(buildStopButtonVisibilityExpressionForTest()).runInContext(
      createContext({
        Array,
        Number,
        HTMLElement: class {},
        document: {
          querySelectorAll: (selector: string) => {
            observedSelector = selector;
            return [];
          },
        },
        window: { getComputedStyle: () => ({}) },
      }),
    );
    expect(observedSelector).toBe(STOP_BUTTON_SELECTORS.join(", "));
  });

  test.each([
    {
      width: 120,
      height: 40,
      display: "block",
      visibility: "visible",
      opacity: "1",
      expected: true,
    },
    {
      width: 0,
      height: 40,
      display: "block",
      visibility: "visible",
      opacity: "1",
      expected: false,
    },
    {
      width: 120,
      height: 40,
      display: "none",
      visibility: "visible",
      opacity: "1",
      expected: false,
    },
  ])("requires a visible stop control before blocking completion: %o", (fixture) => {
    class FakeHtmlElement {
      getBoundingClientRect() {
        return { width: fixture.width, height: fixture.height };
      }
    }
    const result = new Script(buildStopButtonVisibilityExpressionForTest()).runInContext(
      createContext({
        Array,
        Number,
        HTMLElement: FakeHtmlElement,
        document: { querySelectorAll: () => [new FakeHtmlElement()] },
        window: {
          getComputedStyle: () => ({
            display: fixture.display,
            visibility: fixture.visibility,
            opacity: fixture.opacity,
          }),
        },
      }),
    );
    expect(result).toBe(fixture.expected);
  });
});

describe("shouldReplaceAssistantSnapshot", () => {
  // Regression: a turn re-render / extractor pivot can produce a strictly
  // shorter snapshot than the parsed candidate; replacing on "different text"
  // alone shrank good captures to a one-line teaser right before the
  // post-race return.
  test("never replaces the candidate with a shorter snapshot", () => {
    expect(
      shouldReplaceAssistantSnapshotForTest({
        currentLength: 900,
        latestLength: 203,
        hasBetterId: true,
        hasDifferentText: true,
      }),
    ).toBe(false);
  });

  test("replaces the candidate when the snapshot grew", () => {
    expect(
      shouldReplaceAssistantSnapshotForTest({
        currentLength: 203,
        latestLength: 900,
        hasBetterId: false,
        hasDifferentText: true,
      }),
    ).toBe(true);
  });

  test("replaces an equal-length candidate only for better ids or corrected text", () => {
    expect(
      shouldReplaceAssistantSnapshotForTest({
        currentLength: 100,
        latestLength: 100,
        hasBetterId: true,
        hasDifferentText: false,
      }),
    ).toBe(true);
    expect(
      shouldReplaceAssistantSnapshotForTest({
        currentLength: 100,
        latestLength: 100,
        hasBetterId: false,
        hasDifferentText: false,
      }),
    ).toBe(false);
  });
});

describe("shouldConfirmAssistantCompletion", () => {
  test("confirms while the stop button is visible", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 500,
        stopVisible: true,
        completionVisible: false,
      }),
    ).toBe(true);
  });

  test("confirms while completion controls are visible", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 500,
        stopVisible: false,
        completionVisible: true,
      }),
    ).toBe(true);
  });

  test("confirms an implausibly short capture even when no controls are visible", () => {
    // The thinking-UI flapping case: stop button already gone, completion
    // controls not yet shown, a stub answer ("I") captured mid-stream.
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 1,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(true);
  });

  test("trusts a long capture once controls have cleared", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 500,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(false);
  });

  test("does not force confirmation for an empty capture (handled elsewhere)", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 0,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(false);
  });

  test("uses length 16 as the confidence boundary", () => {
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 15,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(true);
    expect(
      shouldConfirmAssistantCompletion({
        candidateLength: 16,
        stopVisible: false,
        completionVisible: false,
      }),
    ).toBe(false);
  });
});
