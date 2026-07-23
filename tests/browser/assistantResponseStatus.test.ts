import { createContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildActiveThinkingStatusPredicateJsForTest,
  buildAnswerNowPlaceholderPredicateJsForTest,
  buildAssistantSnapshotExpressionForTest,
  buildCompletionVisibilityExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildResponseObserverExpressionForTest,
  buildSafeCollapsibleExpansionPredicateForTest,
  buildStopButtonVisibilityExpressionForTest,
  canAdoptAssistantSnapshotIdentityForTest,
  classifyTurnTerminal,
  createTerminalGateState,
  hasScopedCompletionProof,
  isFinishedAssistantSnapshotStableForTest,
  isAnswerNowPlaceholderTextForTest,
  matchesThinkingStatusLabelForTest,
  normalizeAssistantSnapshotForTest,
  recoveryElapsedBaselineForTest,
  shouldAcceptStableAssistantSnapshotForTest,
  shouldReplaceAssistantSnapshotForTest,
  type TerminalGateConfig,
  type TerminalSample,
} from "../../src/browser/actions/assistantResponse.js";
import {
  buildThinkingActivePredicateJsForTest,
  buildThinkingActivityDetailsPredicateJsForTest,
} from "../../src/browser/actions/thinkingStatus.js";
import { STOP_BUTTON_SELECTORS } from "../../src/browser/constants.js";

// Completed-summary shapes the veto must treat as NOT active: bare, heading-prefixed
// (the GPT-5.6 DOM renders "Reasoning Thought for 12s"), worded non-numeric durations,
// and heading fragments that concatenate without whitespace (CSS-spaced siblings).
const COMPLETED_SUMMARY_LABELS = [
  "Thought for 12s",
  "Reasoning Thought for 12s",
  "Thought for a few seconds",
  "Reasoning Thought for a moment",
  "ReasoningThought for 12s",
  "Thought for 1m 5s",
  "Reasoning Thought for 12s Edit",
  "Pro thinking Thought for 3.5s Edit",
];

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

function evaluateCollapsibleExpansionSafety(fixture: {
  text?: string;
  testId?: string;
  ariaLabel?: string;
  title?: string;
  unsafeAncestor?: boolean;
}): boolean {
  const predicate = buildSafeCollapsibleExpansionPredicateForTest("shouldExpand");
  const attributes: Record<string, string | undefined> = {
    "data-testid": fixture.testId,
    "aria-label": fixture.ariaLabel,
    title: fixture.title,
  };
  const button = {
    textContent: fixture.text ?? "",
    getAttribute: (name: string) => attributes[name] ?? null,
    closest: () => (fixture.unsafeAncestor ? {} : null),
  };
  return new Script(`${predicate}\nshouldExpand(button);`).runInNewContext({ button }) as boolean;
}

describe("assistant thinking-status capture", () => {
  test("keeps the original wait age when a short-answer recovery polls again", () => {
    expect(recoveryElapsedBaselineForTest(12 * 60_000, 1_000, 3_500)).toBe(722_500);
    expect(recoveryElapsedBaselineForTest(12 * 60_000, 3_500, 1_000)).toBe(720_000);
  });

  test("keeps a reload/recheck wait age inside the in-page compact-answer gate", () => {
    const expression = buildResponseObserverExpressionForTest(
      60_000,
      undefined,
      undefined,
      12 * 60_000,
    );

    expect(expression).toContain("const ELAPSED_BASELINE_MS = 720000");
    expect(expression).toContain(
      "ELAPSED_BASELINE_MS + (Date.now() - waitStartedAt) < COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS",
    );
  });

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

  test.each([
    { text: "Show more" },
    { text: "Expand response" },
    { testId: "assistant-markdown-toggle" },
  ])("allows ordinary response-content expansion: %o", (fixture) => {
    expect(evaluateCollapsibleExpansionSafety(fixture)).toBe(true);
  });

  test.each([
    { text: "Show thinking" },
    { text: "Show reasoning" },
    { text: "Show analysis" },
    { text: "Expand thought process" },
    { text: "Show more", unsafeAncestor: true },
    { text: "Show", testId: "thinking-toggle" },
    { text: "Show", testId: "reasoning-toggle" },
    { text: "Show", testId: "analysis-toggle" },
    { text: "Show", testId: "stop-answer-now-button" },
    { testId: "assistant-markdown-toggle", ariaLabel: "Answer now" },
    { testId: "assistant-markdown-toggle", title: "Show chain-of-thought" },
  ])("never expands thinking/reasoning/analysis controls: %o", (fixture) => {
    expect(evaluateCollapsibleExpansionSafety(fixture)).toBe(false);
  });

  test("wires the fail-closed expander guard into assistant extraction", () => {
    const expression = buildAssistantSnapshotExpressionForTest();
    expect(expression).toContain("const shouldExpandCollapsible = (button) =>");
    expect(expression).toContain("if (shouldExpandCollapsible(button))");
    expect(expression).toContain("stop-answer-now-button");
  });

  test.each(["Reasoning Thought for 12s", "Thought for a few seconds"])(
    "recognizes prefixed/worded completed summary %s as status chrome, not an answer",
    (label) => {
      expect(matchesThinkingStatusLabelForTest(label)).toBe(true);
      expect(evaluatePredicate(label, true)).toBe(true);
    },
  );

  test("does not treat a real answer mentioning 'thought for' as status chrome", () => {
    // Longer than the 40-char status cap: must never be held back as a placeholder.
    const answer = "I thought for a while about this tradeoff and Postgres still wins.";
    expect(matchesThinkingStatusLabelForTest(answer)).toBe(false);
    expect(evaluatePredicate(answer, true)).toBe(false);
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

  test("requires substantial finished-control captures to stop growing before acceptance", () => {
    const state = {
      currentLength: 900,
      stableCycles: 8,
      completionStableTarget: 8,
      stableMs: 3_000,
      minStableMs: 3_000,
      preambleStableTargetMs: 60_000,
    };

    expect(isFinishedAssistantSnapshotStableForTest({ ...state, stableCycles: 0 })).toBe(false);
    expect(isFinishedAssistantSnapshotStableForTest({ ...state, stableMs: 2_999 })).toBe(false);
    expect(isFinishedAssistantSnapshotStableForTest(state)).toBe(true);
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
    expect(shouldAcceptStableAssistantSnapshotForTest({ ...state, stableMs: 240_000 })).toBe(false);
    expect(shouldAcceptStableAssistantSnapshotForTest({ ...state, stableMs: 300_000 })).toBe(true);
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

  test("accepts a stable short Pro answer with exact-turn completion proof", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: false,
        // Regression: the independent last-turn probe can miss while ChatGPT
        // re-renders the outer turn, even though the snapshot's own turn has
        // finished controls.
        completionVisible: false,
        exactTurnComplete: true,
        thinkingActive: false,
        thinkingObserved: true,
        currentLength: "DIAG-OK".length,
        stableCycles: 12,
        requiredStableCycles: 12,
        completionStableTarget: 12,
        stableMs: 8_000,
        minStableMs: 8_000,
        elapsedMs: 120_000,
      }),
    ).toBe(true);
  });

  test("does not mistake a paused short Pro preamble for a completed turn", () => {
    expect(
      shouldAcceptStableAssistantSnapshotForTest({
        stopVisible: false,
        completionVisible: false,
        exactTurnComplete: false,
        thinkingActive: false,
        thinkingObserved: true,
        currentLength: "1) Verdict".length,
        stableCycles: 30,
        requiredStableCycles: 12,
        completionStableTarget: 12,
        stableMs: 30_000,
        minStableMs: 8_000,
        elapsedMs: 120_000,
      }),
    ).toBe(false);
  });

  test("aria-label stop fallback is scoped to the composer and excludes non-generation stops", () => {
    // Post-merge review of #285: a document-wide button[aria-label*="stop"] match let ANY
    // visible stop control (read-aloud, voice/dictation) hold isStopButtonVisible() true and
    // stall completion until the response timeout. Pin the scoping + exclusions.
    const fallback = STOP_BUTTON_SELECTORS.find((s) => s.includes('aria-label*="stop"'));
    expect(fallback).toBeDefined();
    expect(fallback).toMatch(/^form /);
    expect(fallback).toContain(':not([aria-label*="dictat" i])');
    expect(fallback).toContain(':not([aria-label*="voice" i])');
    expect(fallback).toContain(':not([aria-label*="read" i])');
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

describe("finish-aware thinking-status disambiguation (status-word answers)", () => {
  // Regression: a real one-word answer equal to a thinking-status label was
  // dropped as a placeholder everywhere, so capture never completed and the run
  // timed out. A finished turn (turnComplete) means it is the genuine answer.
  const STATUS_WORD_ANSWERS = [
    "Reading",
    "Searching",
    "Planning",
    "Working",
    "Analyzing",
    "Reasoning",
    "Researching",
  ];

  test("text-only status classification is unchanged (still matches these words)", () => {
    for (const word of STATUS_WORD_ANSWERS) {
      expect(matchesThinkingStatusLabelForTest(word)).toBe(true);
    }
  });

  test.each(STATUS_WORD_ANSWERS)("keeps a FINISHED one-word answer %j", (word) => {
    const kept = normalizeAssistantSnapshotForTest({ text: word, turnComplete: true });
    expect(kept?.text).toBe(word);
    expect(kept?.turnComplete).toBe(true);
  });

  test.each(STATUS_WORD_ANSWERS)("still drops the LIVE status placeholder %j", (word) => {
    // Unfinished turn: this is the Pro-thinking placeholder, never the answer.
    expect(normalizeAssistantSnapshotForTest({ text: word, turnComplete: false })).toBeNull();
    // No completion signal at all (legacy snapshot shape) also stays a placeholder,
    // so the anti-truncation guard is never weakened for older extractors.
    expect(normalizeAssistantSnapshotForTest({ text: word })).toBeNull();
  });

  test("ordinary prose is never a status placeholder regardless of completion", () => {
    expect(
      normalizeAssistantSnapshotForTest({ text: "The answer is 42.", turnComplete: false })?.text,
    ).toBe("The answer is 42.");
  });

  test("the finish gate is wired into both DOM capture paths", () => {
    for (const expression of [
      buildAssistantSnapshotExpressionForTest(),
      buildResponseObserverExpressionForTest(),
    ]) {
      expect(expression).toContain("isBlockingThinkingStatus");
      expect(expression).toContain("snapshot?.turnComplete !== true");
    }
  });

  test("the composed finish gate blocks placeholders but frees finished answers", () => {
    const composed = (snapshot: Record<string, unknown>): boolean => {
      const predicate = buildActiveThinkingStatusPredicateJsForTest("isActiveThinkingStatus");
      return new Script(
        `${predicate}\n` +
          "const isBlockingThinkingStatus = (s) => isActiveThinkingStatus(s) && s?.turnComplete !== true;\n" +
          `isBlockingThinkingStatus(${JSON.stringify(snapshot)});`,
      ).runInNewContext({ String }) as boolean;
    };
    expect(composed({ text: "Reading", turnComplete: true })).toBe(false);
    expect(composed({ text: "Reading", turnComplete: false })).toBe(true);
    expect(composed({ text: "Reading" })).toBe(true);
    expect(composed({ text: "The answer is 42.", turnComplete: false })).toBe(false);
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

  test("never grafts ids from a shorter unrelated assistant turn", () => {
    const current =
      "Primary answer A with its own detailed conclusion, evidence, and recommendations. ".repeat(
        12,
      );
    const unrelated =
      "Assistant answer B belongs to a later turn and must not donate its message identity.";

    expect(canAdoptAssistantSnapshotIdentityForTest(current, unrelated)).toBe(false);
  });

  test("allows ids only for normalized-equal or near-complete boundary truncation", () => {
    const full =
      "This is the same assistant answer with enough distinctive content to bind safely. ".repeat(
        10,
      );
    const nearCompletePrefix = full.slice(0, Math.floor(full.length * 0.95));

    expect(canAdoptAssistantSnapshotIdentityForTest(full, full.replace(/\s+/g, " ").trim())).toBe(
      true,
    );
    expect(canAdoptAssistantSnapshotIdentityForTest(full, nearCompletePrefix)).toBe(true);
    expect(canAdoptAssistantSnapshotIdentityForTest(full, full.slice(0, 60))).toBe(false);
    expect(
      canAdoptAssistantSnapshotIdentityForTest(
        full,
        full,
        { turnId: "assistant-turn-a" },
        { turnId: "assistant-turn-b" },
      ),
    ).toBe(false);
  });
});

describe("completion action correlation", () => {
  class FakeTurn {
    public dataset: Record<string, string> = {};
    public hidden = false;
    public isConnected = true;
    constructor(
      private attrs: Record<string, string>,
      private finished: boolean,
    ) {}
    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }
    querySelector(): object | null {
      return this.finished ? {} : null;
    }
    querySelectorAll(selector: string): FakeTurn[] {
      return this.finished && selector.includes("copy-turn-action-button") ? [this] : [];
    }
    getBoundingClientRect(): { width: number; height: number } {
      return { width: 100, height: 20 };
    }
  }

  function evaluateCompletionVisibility(args: {
    messageId?: string;
    minTurnIndex?: number;
    turns: FakeTurn[];
  }): boolean {
    const expression = buildCompletionVisibilityExpressionForTest(
      { messageId: args.messageId },
      args.minTurnIndex,
    );
    const context = createContext({
      Array,
      Boolean,
      HTMLElement: FakeTurn,
      Number,
      document: { querySelectorAll: () => args.turns },
      window: {
        getComputedStyle: () => ({ display: "block", opacity: "1", visibility: "visible" }),
      },
    });
    return new Script(expression).runInContext(context) as boolean;
  }

  test("rejects a persistent action bar from before the new-turn baseline", () => {
    const oldTurn = new FakeTurn(
      { "data-turn": "assistant", "data-message-id": "old-message" },
      true,
    );
    expect(evaluateCompletionVisibility({ minTurnIndex: 1, turns: [oldTurn] })).toBe(false);
  });

  test("accepts controls correlated to the sampled message identity", () => {
    const currentTurn = new FakeTurn(
      { "data-turn": "assistant", "data-message-id": "current-message" },
      true,
    );
    expect(
      evaluateCompletionVisibility({ messageId: "current-message", turns: [currentTurn] }),
    ).toBe(true);
  });

  test("rejects controls whose assistant identity differs from the sample", () => {
    const oldTurn = new FakeTurn(
      { "data-turn": "assistant", "data-message-id": "old-message" },
      true,
    );
    expect(evaluateCompletionVisibility({ messageId: "new-message", turns: [oldTurn] })).toBe(
      false,
    );
  });

  test("accepts completion controls scoped by the fallback extractor", () => {
    expect(hasScopedCompletionProof({ completionVisible: true })).toBe(true);
    expect(hasScopedCompletionProof({})).toBe(false);
  });

  test("fallback snapshots carry only node-scoped completion evidence", () => {
    const expression = buildMarkdownFallbackExtractorForTest("1");
    expect(expression).toContain(
      "completionVisible: turnComplete || actionMarkdowns.includes(node)",
    );
    expect(expression).toContain("return Boolean(lastUser.compareDocumentPosition(turn) & 4)");
    expect(expression).toContain("if (!hasTurns) return isAfterCurrentUser(node)");
  });
});

describe("classifyTurnTerminal", () => {
  const config: TerminalGateConfig = {
    barConfirmCycles: 3,
    minStableMs: 200,
  };

  // Drive the pure classifier over a sequence of samples (each 400ms apart by default),
  // returning the per-sample terminal decisions.
  function runGate(
    samples: Array<Partial<TerminalSample> & { len: number }>,
    cfg: TerminalGateConfig = config,
    stepMs = 400,
  ): boolean[] {
    let now = 0;
    let state = createTerminalGateState(now);
    const out: boolean[] = [];
    for (const partial of samples) {
      const sample: TerminalSample = {
        now,
        len: partial.len,
        // Default fingerprint = the length, so a changing length reads as "still moving"; tests
        // that need an equal-length rewrite pass an explicit contentKey.
        contentKey: partial.contentKey ?? String(partial.len),
        stopVisible: partial.stopVisible ?? false,
        barVisible: partial.barVisible ?? false,
        strongThinkingActive: partial.strongThinkingActive ?? false,
      };
      const result = classifyTurnTerminal(state, sample, cfg);
      state = result.state;
      out.push(result.terminal);
      now += stepMs;
    }
    return out;
  }

  test("never finalizes while the stop control is visible", () => {
    const out = runGate(Array.from({ length: 20 }, () => ({ len: 400, stopVisible: true })));
    expect(out.some(Boolean)).toBe(false);
  });

  test("holds a settled long preamble until the reasoning phase resolves", () => {
    // A 150-char preamble settles (stop gone, no bar), then thinking mounts for ~4s, then the
    // real answer streams and its action bar appears. It must NOT finalize the preamble.
    const samples: Array<Partial<TerminalSample> & { len: number }> = [];
    // preamble streaming
    for (let i = 0; i < 3; i++) samples.push({ len: 50 * (i + 1), stopVisible: true });
    // settle gap: stop gone, no bar, no thinking yet (the exact window the bug exploited)
    for (let i = 0; i < 2; i++) samples.push({ len: 150 });
    // thinking phase mounts (connector/reasoning)
    for (let i = 0; i < 10; i++) samples.push({ len: 150, strongThinkingActive: true });
    // real answer streams after thinking, bar appears and debounces
    samples.push({ len: 600, stopVisible: true });
    samples.push({ len: 900, stopVisible: true });
    for (let i = 0; i < 5; i++) samples.push({ len: 900, barVisible: true });
    const out = runGate(samples);
    // No terminal:true may occur before the real answer streamed (index of first len>150).
    const firstAnswerIdx = samples.findIndex((s) => s.len > 150);
    const finalizedEarly = out.slice(0, firstAnswerIdx).some(Boolean);
    expect(finalizedEarly).toBe(false);
    // It DOES finalize once the real answer's bar debounces.
    expect(out.some(Boolean)).toBe(true);
  });

  test("proofA: a debounced action bar finalizes (and bypasses the thinking veto)", () => {
    const out = runGate([
      { len: 800, stopVisible: true }, // streaming
      { len: 800, barVisible: true }, // grew stopped; bar appears (cycle 1)
      { len: 800, barVisible: true }, // cycle 2
      { len: 800, barVisible: true }, // cycle 3 -> barStableCycles reaches 3
      { len: 800, barVisible: true },
    ]);
    // First three post-stream cycles build the debounce; terminal by the time cycles>=3.
    expect(out.at(-1)).toBe(true);
  });

  test("proofA fires even if weak stale-sidecar evidence lingers", () => {
    const out = runGate([
      { len: 800, stopVisible: true },
      { len: 800, barVisible: true },
      { len: 800, barVisible: true },
      { len: 800, barVisible: true },
      { len: 800, barVisible: true },
    ]);
    // Weak activity can be a stale mounted sidecar; the debounced bar may override it.
    expect(out.at(-1)).toBe(true);
  });

  test("proofA cannot override strong live activity and rebuilds its debounce afterward", () => {
    const samples: Array<Partial<TerminalSample> & { len: number }> = [
      { len: 800, stopVisible: true },
    ];
    for (let i = 0; i < 5; i++) {
      samples.push({
        len: 800,
        barVisible: true,
        strongThinkingActive: true,
      });
    }
    samples.push({ len: 800, barVisible: true });
    samples.push({ len: 800, barVisible: true });
    samples.push({ len: 800, barVisible: true });
    const out = runGate(samples);
    expect(out.slice(0, 6).some(Boolean)).toBe(false);
    expect(out.at(-1)).toBe(true);
  });

  test("proofA does NOT finalize a transient bar while the answer is still rendering", () => {
    // Repo history: finished-action controls can surface while only the first tokens exist.
    // The bar is present the whole time, but the text keeps changing, so proofA must not fire.
    const out = runGate([
      { len: 4, barVisible: true },
      { len: 8, barVisible: true },
      { len: 12, barVisible: true },
      { len: 40, barVisible: true },
      { len: 90, barVisible: true },
    ]);
    expect(out.some(Boolean)).toBe(false);
  });

  test("any content change (even equal length) resets the stability clocks", () => {
    // An equal-length rewrite (preamble replaced by an answer of the same length) must reset:
    // length-only tracking would have treated it as stable and could finalize mid-rewrite.
    const out = runGate([
      { len: 200, barVisible: true, contentKey: "preamble-aaaaaaaaaaaaaaaaaaaa" },
      { len: 200, barVisible: true, contentKey: "answer-bbbbbbbbbbbbbbbbbbbbbb" }, // same len, new text
      { len: 200, barVisible: true, contentKey: "answer-bbbbbbbbbbbbbbbbbbbbbb" },
    ]);
    // The rewrite at sample 1 resets the debounce; only ~1 stable cycle follows -> not terminal.
    expect(out.some(Boolean)).toBe(false);
  });

  test("does not finalize stable text without correlated completion controls", () => {
    const samples: Array<Partial<TerminalSample> & { len: number }> = [
      { len: 800, stopVisible: true },
    ];
    for (let i = 0; i < 8; i++) samples.push({ len: 800 });
    const out = runGate(samples);
    expect(out.some(Boolean)).toBe(false);
  });

  test("an implausibly short capture still requires correlated completion controls", () => {
    const samples: Array<Partial<TerminalSample> & { len: number }> = [{ len: 1 }];
    for (let i = 0; i < 20; i++) samples.push({ len: 1 }); // stable "I", quiet, no bar/thinking
    const out = runGate(samples);
    expect(out.some(Boolean)).toBe(false);
  });

  test("a short answer still finalizes once its action bar debounces", () => {
    const out = runGate([
      { len: 4 },
      { len: 4, barVisible: true },
      { len: 4, barVisible: true },
      { len: 4, barVisible: true },
    ]);
    expect(out.at(-1)).toBe(true);
  });

  test("text growth resets the action-bar debounce", () => {
    const out = runGate([
      { len: 100, barVisible: true },
      { len: 100, barVisible: true },
      { len: 200, barVisible: true },
      { len: 200, barVisible: true },
    ]);
    expect(out.some(Boolean)).toBe(false);
  });
});

describe("thinking-active completion veto", () => {
  class FakeEl {
    public rect = { left: 0, top: 0, width: 120, height: 40 };
    constructor(
      public textContent = "",
      private attrs: Record<string, string> = {},
    ) {}
    getBoundingClientRect() {
      return this.rect;
    }
    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }
    querySelectorAll(selector: string) {
      const matches: FakeEl[] = [];
      if (selector.includes("progress"))
        matches.push(
          ...this.children.filter((child) => child.getAttribute("role") === "progressbar"),
        );
      if (selector.includes("loading-shimmer"))
        matches.push(
          ...this.children.filter((child) => child.getAttribute("data-kind") === "shimmer"),
        );
      if (selector.includes("aria-busy"))
        matches.push(
          ...this.children.filter((child) => child.getAttribute("aria-busy") === "true"),
        );
      return [...new Set(matches)];
    }
    public children: FakeEl[] = [];
  }

  interface ThinkingFixtureOptions {
    stop?: boolean;
    shimmer?: boolean;
    ariaBusy?: boolean;
    statusText?: string;
    statusTestId?: string;
    progress?: boolean;
    progressNow?: number;
    progressMax?: number;
    unrelatedProgress?: boolean;
    unrelatedBusy?: boolean;
    panel?: FakeEl;
  }

  function createThinkingContext(opts: ThinkingFixtureOptions) {
    const statusNodes =
      opts.statusText != null
        ? [
            new FakeEl(
              opts.statusText,
              opts.statusTestId ? { "data-testid": opts.statusTestId } : {},
            ),
          ]
        : [];
    const progressAttrs: Record<string, string> =
      opts.progressNow != null
        ? {
            "aria-valuenow": String(opts.progressNow),
            "aria-valuemax": String(opts.progressMax ?? 100),
            role: "progressbar",
          }
        : { "aria-valuenow": "40", role: "progressbar" };
    const progressNodes =
      opts.progress || opts.progressNow != null ? [new FakeEl("", progressAttrs)] : [];
    // Progress is scoped to the CURRENT assistant turn (review P1): the harness models the
    // turn container; unrelatedProgress mounts a live bar OUTSIDE any turn, which must not veto.
    const turn = new FakeEl("turn");
    turn.children = [
      ...progressNodes,
      ...(opts.shimmer ? [new FakeEl("", { "data-kind": "shimmer" })] : []),
      ...(opts.ariaBusy ? [new FakeEl("", { "aria-busy": "true" })] : []),
    ];
    const turnNodes = [turn];
    const panelNodes = opts.panel ? [opts.panel] : [];
    return createContext({
      Array,
      Number,
      String,
      HTMLElement: FakeEl,
      HTMLProgressElement: class {},
      document: {
        querySelectorAll: (selector: string) => {
          if (selector.includes("stop") || selector.includes('aria-label*="stop"')) {
            return opts.stop ? [new FakeEl()] : [];
          }
          if (selector.includes("loading-shimmer")) return opts.unrelatedBusy ? [new FakeEl()] : [];
          if (selector.includes("aria-busy")) return opts.unrelatedBusy ? [new FakeEl()] : [];
          if (selector.includes("progressbar") || selector.includes("aria-valuenow")) {
            // Only an UNRELATED page-wide bar is ever visible at document level now; the
            // turn-scoped bars are reached through the turn node's own querySelectorAll.
            return opts.unrelatedProgress ? [new FakeEl("", progressAttrs)] : [];
          }
          if (selector.includes("conversation-turn") || selector.includes("data-turn")) {
            return turnNodes;
          }
          // The panel selector carries "aside"/"complementary"/"sidecar"; the status selector
          // does not, so match panels first to disambiguate (both mention thinking/reasoning).
          if (
            selector.includes("aside") ||
            selector.includes("complementary") ||
            selector.includes("sidecar") ||
            selector.includes("sidebar")
          ) {
            return panelNodes;
          }
          if (
            selector.includes("thinking") ||
            selector.includes("reasoning") ||
            selector.includes("status") ||
            selector.includes("aria-live")
          ) {
            return statusNodes;
          }
          return [];
        },
      },
      window: {
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        innerHeight: 900,
        innerWidth: 1440,
      },
    });
  }

  function evalThinkingActive(opts: ThinkingFixtureOptions): boolean {
    const predicate = buildThinkingActivePredicateJsForTest("isThinkingActive");
    return new Script(`${predicate}\nisThinkingActive();`).runInContext(
      createThinkingContext(opts),
    ) as boolean;
  }

  function evalThinkingActivityDetails(opts: ThinkingFixtureOptions): {
    active: boolean;
    strong: boolean;
  } {
    const predicate = buildThinkingActivityDetailsPredicateJsForTest("readThinkingActivity");
    return new Script(`${predicate}\nreadThinkingActivity();`).runInContext(
      createThinkingContext(opts),
    ) as { active: boolean; strong: boolean };
  }

  test("fires on a visible stop control", () => {
    expect(evalThinkingActive({ stop: true })).toBe(true);
  });

  test("fires on a visible loading-shimmer skeleton", () => {
    expect(evalThinkingActive({ shimmer: true })).toBe(true);
  });

  test("fires on aria-busy", () => {
    expect(evalThinkingActive({ ariaBusy: true })).toBe(true);
  });

  test.each(["Thinking", "Pro thinking", "Searching the web", "Reading", "Finalizing answer"])(
    "fires on active status label %j",
    (label) => {
      expect(evalThinkingActive({ statusText: label, statusTestId: "thinking-status" })).toBe(true);
    },
  );

  test("does NOT treat ordinary live-region answer prose as active thinking", () => {
    expect(
      evalThinkingActivityDetails({ statusText: "Thinking clearly requires practice." }),
    ).toEqual({
      active: false,
      strong: false,
    });
  });

  test("allows prefix matching only in verified thinking chrome", () => {
    expect(
      evalThinkingActivityDetails({
        statusText: "Thinking through the remaining cases",
        statusTestId: "reasoning-status",
      }),
    ).toEqual({ active: true, strong: true });
  });

  test.each(COMPLETED_SUMMARY_LABELS)(
    "does NOT fire on the persistent completed reasoning summary %s",
    (statusText) => {
      // The headline hang the design must avoid: this summary lingers in the DOM on every
      // finished Pro turn and on reattach. A presence-based veto would hang forever here.
      expect(evalThinkingActive({ statusText })).toBe(false);
    },
  );

  test("fires on a live progress bar inside the current assistant turn", () => {
    expect(evalThinkingActive({ progress: true })).toBe(true);
    expect(evalThinkingActivityDetails({ progress: true })).toEqual({ active: true, strong: true });
  });

  test("does NOT fire on a completed progress bar (value at max)", () => {
    // A finished connector bar must not veto completion forever.
    expect(evalThinkingActive({ progressNow: 100, progressMax: 100 })).toBe(false);
  });

  test("does NOT fire on an unrelated progress bar outside the assistant turn", () => {
    // Review P1: unrelated page UI can keep a visible progress bar mounted indefinitely; a
    // document-wide veto would then hold a completed response until the watchdog timeout.
    expect(evalThinkingActive({ unrelatedProgress: true })).toBe(false);
  });

  test("does NOT fire on unrelated page-wide busy indicators", () => {
    expect(evalThinkingActivityDetails({ unrelatedBusy: true })).toEqual({
      active: false,
      strong: false,
    });
  });

  test("fires on a right-side reasoning sidecar panel with no inline label", () => {
    const panel = new FakeEl("Reasoning");
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 }; // right side, large
    expect(evalThinkingActive({ panel })).toBe(true);
    expect(evalThinkingActivityDetails({ panel })).toEqual({
      active: true,
      strong: false,
    });
  });

  test("does NOT treat progress in a generic panel as model activity", () => {
    const panel = new FakeEl("Upload");
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    panel.children = [new FakeEl("", { "aria-valuenow": "40", role: "progressbar" })];
    expect(evalThinkingActivityDetails({ panel })).toEqual({ active: false, strong: false });
  });

  test("treats progress in verified reasoning chrome as strong activity", () => {
    const panel = new FakeEl("", { "data-testid": "reasoning-panel" });
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    panel.children = [new FakeEl("", { "aria-valuenow": "40", role: "progressbar" })];
    expect(evalThinkingActivityDetails({ panel })).toEqual({ active: true, strong: true });
  });

  test.each(COMPLETED_SUMMARY_LABELS)("does NOT fire on completed sidecar summary %s", (text) => {
    const panel = new FakeEl(text);
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    expect(evalThinkingActive({ panel })).toBe(false);
  });

  test("still fires on a live sidecar trace that embeds a completed sub-step summary", () => {
    // A running trace accumulates sub-step summaries ("Thought for 2s") alongside live
    // reasoning text. Only a SHORT summary-only panel means the turn is done; a long trace
    // must keep vetoing completion even though it contains the completed phrase.
    const panel = new FakeEl(
      "Thought for 2s: Searching the web. Reasoning about the diff and enumerating candidate hunks to inspect next.",
    );
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    expect(evalThinkingActive({ panel })).toBe(true);
  });

  test("fires on a short live trace that begins with a completed sub-step", () => {
    const panel = new FakeEl("Thought for 2s: Searching the web");
    panel.rect = { left: 1000, top: 100, width: 380, height: 400 };
    expect(evalThinkingActive({ panel })).toBe(true);
  });

  test("does NOT fire on an idle DOM (finished, no controls)", () => {
    expect(evalThinkingActive({})).toBe(false);
  });
});
