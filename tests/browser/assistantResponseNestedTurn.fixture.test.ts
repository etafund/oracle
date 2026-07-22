import { describe, expect, test, vi } from "vitest";
import {
  buildAssistantSnapshotExpressionForTest,
  buildCompletionVisibleExpressionForTest,
  readAssistantSnapshot,
} from "../../src/browser/actions/assistantResponse.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { loadBrowserFixture } from "../_helpers/browserFixture.js";

const DOCUMENT_POSITION_FOLLOWING = 4;

class FixtureElement extends EventTarget {
  parentElement: FixtureElement | null = null;
  readonly children: FixtureElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly tagName: string;
  private ownText = "";

  constructor(
    tagName: string,
    private readonly attributes: Record<string, string>,
    readonly order: number,
  ) {
    super();
    this.tagName = tagName.toUpperCase();
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith("data-")) {
        this.dataset[
          key.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())
        ] = value;
      }
    }
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  get innerText(): string {
    return this.textContent.replace(/\s+/g, " ").trim();
  }

  get textContent(): string {
    return `${this.ownText}${this.children.map((child) => child.textContent).join("")}`;
  }

  get innerHTML(): string {
    return `${escapeHtml(this.ownText)}${this.children.map((child) => child.outerHTML).join("")}`;
  }

  get outerHTML(): string {
    const attrs = Object.entries(this.attributes)
      .map(([key, value]) => (value ? ` ${key}="${escapeHtml(value)}"` : ` ${key}`))
      .join("");
    return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }

  appendChild(child: FixtureElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  appendText(text: string): void {
    this.ownText += text;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name.toLowerCase()] ?? null;
  }

  matches(selector: string): boolean {
    return matchesSelectorList(this, selector);
  }

  closest(selector: string): FixtureElement | null {
    if (matchesSelectorList(this, selector)) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelector(selector: string): FixtureElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FixtureElement[] {
    return flattenElements(this.children).filter((element) =>
      matchesSelectorList(element, selector),
    );
  }

  compareDocumentPosition(other: FixtureElement): number {
    return other.order > this.order ? DOCUMENT_POSITION_FOLLOWING : 0;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 100, height: 20 };
  }
}

class FixtureDocument {
  readonly body: FixtureElement;

  constructor(body: FixtureElement) {
    this.body = body;
  }

  querySelector(selector: string): FixtureElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FixtureElement[] {
    const matches = flattenElements([this.body]).filter((element) =>
      matchesSelectorList(element, selector),
    );
    return matches;
  }
}

function runtimeForFixture(html: string): ChromeClient["Runtime"] & {
  evaluate: ReturnType<typeof vi.fn>;
} {
  return {
    evaluate: vi.fn(async ({ expression }: { expression?: string }) => ({
      result: { value: evaluateFixtureExpression(html, String(expression ?? "")) },
    })),
  } as unknown as ChromeClient["Runtime"] & { evaluate: ReturnType<typeof vi.fn> };
}

function evaluateFixtureExpression<T = unknown>(html: string, expression: string): T {
  const document = parseFixtureDocument(html);
  const location = { href: "https://chatgpt.com/c/nested-turn-fixture" };
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
    FixtureElement,
    { DOCUMENT_POSITION_FOLLOWING },
    location,
    window,
    EventTarget,
    class MouseEvent extends Event {},
    class PointerEvent extends Event {},
  ) as T;
}

function parseFixtureDocument(html: string): FixtureDocument {
  let order = 0;
  const root = new FixtureElement("document", {}, order++);
  const stack: FixtureElement[] = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-z][^>]*>|[^<]+/giu;

  for (const match of html.matchAll(tokenPattern)) {
    const token = match[0];
    if (token.startsWith("<!--") || /^<!doctype/i.test(token)) {
      continue;
    }
    if (token.startsWith("</")) {
      const closingTag = token.slice(2, -1).trim().toLowerCase();
      while (stack.length > 1) {
        const node = stack.pop();
        if (node?.tagName.toLowerCase() === closingTag) {
          break;
        }
      }
      continue;
    }
    if (token.startsWith("<")) {
      const parsed = parseOpeningTag(token);
      if (!parsed) {
        continue;
      }
      const node = new FixtureElement(parsed.tagName, parsed.attributes, order++);
      stack.at(-1)?.appendChild(node);
      if (!parsed.selfClosing && !isVoidTag(parsed.tagName)) {
        stack.push(node);
      }
      continue;
    }
    stack.at(-1)?.appendText(decodeHtml(token));
  }

  return new FixtureDocument(root.querySelector("body") ?? root);
}

function parseOpeningTag(
  token: string,
): { tagName: string; attributes: Record<string, string>; selfClosing: boolean } | null {
  const raw = token.slice(1, -1).trim();
  const tagName = raw.match(/^[a-z][a-z0-9-]*/iu)?.[0]?.toLowerCase();
  if (!tagName) {
    return null;
  }
  const selfClosing = /\/\s*$/.test(raw);
  const attrSource = raw.slice(tagName.length).replace(/\/\s*$/, "");
  const attributes: Record<string, string> = {};
  const attrPattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of attrSource.matchAll(attrPattern)) {
    const name = match[1]?.toLowerCase();
    if (!name) {
      continue;
    }
    attributes[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return { tagName, attributes, selfClosing };
}

function flattenElements(elements: FixtureElement[]): FixtureElement[] {
  return elements.flatMap((element) => [element, ...flattenElements(element.children)]);
}

function matchesSelectorList(element: FixtureElement, selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSingleSelector(element, part));
}

function matchesSingleSelector(element: FixtureElement, selector: string): boolean {
  const normalized = selector.trim();
  const tag = normalized.match(/^[a-z][a-z0-9-]*/iu)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) {
    return false;
  }

  for (const classMatch of normalized.matchAll(/\.([a-zA-Z0-9_-]+)/gu)) {
    const className = classMatch[1] ?? "";
    if (!element.className.split(/\s+/).includes(className)) {
      return false;
    }
  }

  const attrPattern =
    /\[([a-zA-Z_:][-a-zA-Z0-9_:.]*)([*^]?=)?(?:"([^"]*)"|'([^']*)'|([^\]]+))?\]/gu;
  for (const match of normalized.matchAll(attrPattern)) {
    const name = match[1]?.toLowerCase();
    const operator = match[2];
    const expected = match[3] ?? match[4] ?? match[5] ?? "";
    const actual = name ? element.getAttribute(name) : null;
    if (actual === null) {
      return false;
    }
    if (operator === "=" && actual !== expected) {
      return false;
    }
    if (operator === "*=" && !actual.includes(expected)) {
      return false;
    }
    if (operator === "^=" && !actual.startsWith(expected)) {
      return false;
    }
  }

  return true;
}

function isVoidTag(tagName: string): boolean {
  return new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta"]).has(
    tagName,
  );
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

describe("ChatGPT nested assistant turn fixture", () => {
  test("extracts inner assistant text after the latest user despite a higher numeric baseline", async () => {
    const fixture = await loadBrowserFixture("chatgpt", "nested-assistant-turn");
    const runtime = runtimeForFixture(fixture.html);

    const snapshot = await readAssistantSnapshot(runtime, 99);

    expect(snapshot?.text).toContain("Nested turn regression answer.");
    expect(snapshot?.text).toContain("inner assistant role node owns the text");
    expect(snapshot?.text).not.toContain("Stale prior answer");
    expect(snapshot?.messageId).toBe("assistant-msg-current");
    // The extractor binds to the outermost conversation turn so sibling
    // controls (notably Copy) stay in the same authoritative scope as the
    // nested assistant message.
    expect(snapshot?.turnId).toBe("conversation-turn-4");
    expect(snapshot?.afterLatestUser).toBe(true);
    expect(snapshot?.turnIndex).toBeLessThan(99);
    expect(runtime.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        expression: buildAssistantSnapshotExpressionForTest(99),
        returnByValue: true,
      }),
    );
  });

  test("detects completion controls on the outer assistant conversation turn", async () => {
    const fixture = await loadBrowserFixture("chatgpt", "nested-assistant-turn");

    expect(evaluateFixtureExpression(fixture.html, buildCompletionVisibleExpressionForTest())).toBe(
      true,
    );
  });

  test("does not treat old finished controls as completion for the latest nested turn", async () => {
    const fixture = await loadBrowserFixture("chatgpt", "nested-assistant-turn");
    const withoutLatestTurnActions = fixture.html.replace(
      /\s*<div class="turn-actions" data-current-actions>[\s\S]*?<\/div>/u,
      "",
    );

    expect(
      evaluateFixtureExpression(
        withoutLatestTurnActions,
        buildCompletionVisibleExpressionForTest(),
      ),
    ).toBe(false);
  });
});
