import { createContext, Script } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildResponseObserverExpressionForTest,
  buildThinkingGatePredicateJsForTest,
} from "../../src/browser/actions/assistantResponse.js";
import { chatgptSelectorList } from "../../src/browser/selectors/chatgpt/index.js";

type FakeRect = { width: number; height: number };

/**
 * Minimal DOM stand-in for the shared thinking-gate predicate: the predicate
 * only touches querySelectorAll, visibility (rect + computed style), closest
 * (composer adjacency), textContent and a few attributes, so nodes are
 * registered per selector instead of implementing a selector engine.
 */
class FakeNode {
  readonly textContent: string;
  private readonly attrs: Record<string, string>;
  private readonly rect: FakeRect;
  private readonly composerAdjacent: boolean;
  readonly style: Record<string, string>;

  constructor(options: {
    text?: string;
    attrs?: Record<string, string>;
    visible?: boolean;
    composerAdjacent?: boolean;
    style?: Record<string, string>;
  }) {
    this.textContent = options.text ?? "";
    this.attrs = options.attrs ?? {};
    this.rect = options.visible === false ? { width: 0, height: 0 } : { width: 120, height: 24 };
    this.composerAdjacent = options.composerAdjacent === true;
    this.style = options.style ?? {};
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  closest(selector: string): FakeNode | null {
    if (selector.includes("composer") && this.composerAdjacent) {
      return this;
    }
    return null;
  }
}

function runGate(nodesBySelector: Record<string, FakeNode[]>): boolean {
  const predicate = buildThinkingGatePredicateJsForTest("isThinkingGateActive");
  const context = createContext({
    Array,
    Boolean,
    Number,
    String,
    HTMLElement: FakeNode,
    document: {
      querySelectorAll: (selector: string) => nodesBySelector[selector] ?? [],
    },
    window: {
      getComputedStyle: (node: FakeNode) => ({
        display: node.style.display ?? "block",
        visibility: node.style.visibility ?? "visible",
        opacity: node.style.opacity ?? "1",
      }),
    },
  });
  return new Script(`${predicate}\nisThinkingGateActive();`).runInContext(context) as boolean;
}

describe("shared thinking-gate predicate", () => {
  const answerNowSelectors = chatgptSelectorList("answer_now_cta");

  test("detects the classic English thinking status", () => {
    expect(runGate({ '[role="status"]': [new FakeNode({ text: "Thinking" })] })).toBe(true);
  });

  // Regression: the acceptance gate only knew 4 English keywords while the
  // logging monitor already knew localized stems — a localized UI silently
  // disabled the only anti-truncation guard.
  test("detects localized thinking labels", () => {
    expect(runGate({ '[role="status"]': [new FakeNode({ text: "Denkt nach…" })] })).toBe(true);
    expect(runGate({ '[aria-live="polite"]': [new FakeNode({ text: "Rozumowanie" })] })).toBe(true);
  });

  test("detects broadened thinking-verb labels", () => {
    expect(runGate({ '[role="status"]': [new FakeNode({ text: "Analyzing sources" })] })).toBe(
      true,
    );
    expect(runGate({ '[role="status"]': [new FakeNode({ text: "Searching the web" })] })).toBe(
      true,
    );
  });

  test("treats structural streaming markers as active without any label", () => {
    expect(runGate({ ".result-streaming": [new FakeNode({})] })).toBe(true);
    expect(runGate({ '[data-is-streaming="true"]': [new FakeNode({})] })).toBe(true);
    expect(runGate({ "span.loading-shimmer": [new FakeNode({})] })).toBe(true);
  });

  test.each(answerNowSelectors)("treats visible Answer-now CTA %j as active", (selector) => {
    expect(
      runGate({
        [selector]: [
          new FakeNode({
            text: "Answer now",
            attrs: { "aria-label": "Answer now" },
          }),
        ],
      }),
    ).toBe(true);
  });

  test("ignores hidden Answer-now CTAs", () => {
    const selector = answerNowSelectors[0]!;
    expect(runGate({ [selector]: [new FakeNode({ text: "Answer now", visible: false })] })).toBe(
      false,
    );
    expect(
      runGate({
        [selector]: [new FakeNode({ text: "Answer now", style: { visibility: "hidden" } })],
      }),
    ).toBe(false);
  });

  test("keeps Answer-now selectors detection-only", () => {
    const predicate = buildThinkingGatePredicateJsForTest("isThinkingGateActive");
    expect(predicate).toContain("ANSWER_NOW_SELECTORS");
    expect(predicate).not.toMatch(/\.click\s*\(|dispatchClick|dispatchMouseEvent/);
  });

  test("ignores composer-adjacent and invisible indicators", () => {
    expect(
      runGate({
        '[role="status"]': [new FakeNode({ text: "Thinking", composerAdjacent: true })],
      }),
    ).toBe(false);
    expect(
      runGate({
        ".result-streaming": [new FakeNode({ visible: false })],
      }),
    ).toBe(false);
    expect(
      runGate({
        '[role="status"]': [new FakeNode({ text: "Thinking", style: { display: "none" } })],
      }),
    ).toBe(false);
  });

  test("ignores ordinary status text", () => {
    expect(runGate({ '[role="status"]': [new FakeNode({ text: "Saved to memory" })] })).toBe(false);
    expect(runGate({})).toBe(false);
  });
});

describe("observer expression lockstep", () => {
  test("generated observer expression compiles as valid JavaScript", () => {
    // The in-page code lives in a template string, so a syntax error there
    // escapes tsc entirely and would break every browser run at runtime.
    expect(() => new Script(buildResponseObserverExpressionForTest())).not.toThrow();
  });

  test("embeds the exact shared gate predicate source", () => {
    const expression = buildResponseObserverExpressionForTest();
    expect(expression).toContain(buildThinkingGatePredicateJsForTest("isThinkingIndicatorActive"));
  });

  test("embeds manifest Answer-now liveness selectors in the observer", () => {
    const expression = buildResponseObserverExpressionForTest();
    for (const selector of chatgptSelectorList("answer_now_cta")) {
      expect(expression).toContain(JSON.stringify(selector));
    }
  });

  test("wires the anti-flicker hardening into the in-page settle loop", () => {
    const expression = buildResponseObserverExpressionForTest();
    expect(expression).toContain("NONCOMPACT_ACCEPT_CONFIRM_SAMPLES");
    expect(expression).toContain("COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS");
    expect(expression).toContain("acceptStreak");
    // Thinking activity must reset the idle clock inside the settle loop.
    expect(expression).toMatch(/if \(thinkingActive\) \{[^}]*lastChangeAt = Date\.now\(\)/s);
  });

  // Regression (review finding): waitForSettle can start minutes into the
  // wait (captureViaObserver resolves on the FIRST extractable text), so the
  // compact grace window and the overall deadline must anchor on a timestamp
  // captured at expression start — measuring from settle entry would reset
  // the 60s gate exactly when a thinking pause ends and re-admit the stale
  // "1) Verdict" fragment class.
  test("anchors elapsed-time gates at expression start, not settle entry", () => {
    const expression = buildResponseObserverExpressionForTest();
    const anchorIndex = expression.indexOf("const waitStartedAt = Date.now();");
    const settleIndex = expression.indexOf("const waitForSettle");
    expect(anchorIndex).toBeGreaterThan(-1);
    expect(settleIndex).toBeGreaterThan(-1);
    expect(anchorIndex).toBeLessThan(settleIndex);
    expect(expression).toContain("const overallDeadline = waitStartedAt +");
    expect(expression).toMatch(
      /ELAPSED_BASELINE_MS \+ \(Date\.now\(\) - waitStartedAt\) <\s*COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS/,
    );
    // No elapsed gate may measure from settle entry.
    expect(expression).not.toContain("settleStartedAt");
  });
});
