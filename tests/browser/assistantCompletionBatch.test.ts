// Watchdog poll perf hardening:
//   * pollAssistantCompletion collapses its four per-tick Runtime.evaluate reads
//     (snapshot + stop + completion + thinking) into ONE batched evaluate with
//     identical semantics.
//   * the poll cadence is adaptive: it widens only while a thinking indicator is
//     confirmed active and tightens straight back once thinking clears.

import { describe, expect, test } from "vitest";
import {
  buildBatchedAssistantCompletionExpressionForTest,
  watchdogPollIntervalMsForTest,
} from "../../src/browser/actions/assistantResponse.js";

const DOCUMENT_POSITION_FOLLOWING = 4;

class FakeEl {
  constructor(
    private readonly attrs: Record<string, string> = {},
    private readonly visible = true,
  ) {}
  get dataset(): Record<string, string> {
    return {};
  }
  getAttribute(name: string): string | null {
    return this.attrs[name.toLowerCase()] ?? null;
  }
  get className(): string {
    return this.attrs.class ?? "";
  }
  get textContent(): string {
    return this.attrs.text ?? "";
  }
  get innerText(): string {
    return this.attrs.text ?? "";
  }
  get innerHTML(): string {
    return "";
  }
  getBoundingClientRect(): { width: number; height: number } {
    return { width: this.visible ? 100 : 0, height: this.visible ? 20 : 0 };
  }
  matches(): boolean {
    return false;
  }
  closest(): FakeEl | null {
    return null;
  }
  querySelector(): FakeEl | null {
    return null;
  }
  querySelectorAll(): FakeEl[] {
    return [];
  }
}

interface DomSpec {
  querySelector?: (selector: string) => unknown;
  querySelectorAll?: (selector: string) => unknown[];
}

interface BatchedResult {
  snapshot: unknown;
  stopVisible: boolean;
  completionVisible: boolean;
  thinkingActive: boolean;
}

function runBatched(dom: DomSpec = {}): BatchedResult {
  const expression = buildBatchedAssistantCompletionExpressionForTest();
  const document = {
    title: "ChatGPT",
    body: {
      innerText: "",
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    querySelector: dom.querySelector ?? (() => null),
    querySelectorAll: dom.querySelectorAll ?? (() => []),
  };
  const location = { href: "https://chatgpt.com/" };
  const window = {
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  const evaluate = new Function(
    "document",
    "HTMLElement",
    "Node",
    "location",
    "window",
    "EventTarget",
    "MouseEvent",
    "PointerEvent",
    `return ${expression};`,
  );
  return evaluate(
    document,
    FakeEl,
    { DOCUMENT_POSITION_FOLLOWING },
    location,
    window,
    EventTarget,
    class extends Event {},
    class extends Event {},
  ) as BatchedResult;
}

describe("batched assistant completion read", () => {
  test("collapses the four per-tick probes into one shared-source expression", () => {
    const expression = buildBatchedAssistantCompletionExpressionForTest();
    // All four signals are computed inside the SAME evaluate...
    expect(expression).toContain("isStopControlVisible");
    expect(expression).toContain("isThinkingGateActive");
    expect(expression).toContain("extractAssistantTurn"); // snapshot extractor
    expect(expression).toContain("copy-turn-action-button"); // completion controls
    // ...and returned together as one object with every signal present.
    expect(expression).toContain(
      "return { snapshot, stopVisible, completionVisible, thinkingActive };",
    );
    // Exactly one snapshot extractor + one completion turn walk (no duplicate
    // full walks): the extractor and completion builder each appear once.
    expect(expression.match(/extractAssistantTurn\(\)/g)?.length).toBe(1);
  });

  test("returns all four signals as one object; a calm empty page is all-negative", () => {
    const result = runBatched();
    expect(result).toEqual({
      snapshot: null,
      stopVisible: false,
      completionVisible: false,
      thinkingActive: false,
    });
  });

  test("surfaces a visible stop button independently of the other signals", () => {
    const result = runBatched({
      querySelectorAll: (selector) =>
        selector.includes("stop-button") ? [new FakeEl({}, true)] : [],
    });
    expect(result.stopVisible).toBe(true);
    expect(result.completionVisible).toBe(false);
    expect(result.thinkingActive).toBe(false);
    expect(result.snapshot).toBeNull();
  });
});

describe("adaptive watchdog poll interval", () => {
  test("widens only while a thinking indicator is confirmed active", () => {
    expect(watchdogPollIntervalMsForTest(false)).toBe(400);
    expect(watchdogPollIntervalMsForTest(true)).toBe(1200);
  });

  test("the widened interval stays modest (<=1.5s) and strictly wider than the tight cadence", () => {
    expect(watchdogPollIntervalMsForTest(true)).toBeGreaterThan(
      watchdogPollIntervalMsForTest(false),
    );
    expect(watchdogPollIntervalMsForTest(true)).toBeLessThanOrEqual(1500);
  });
});
