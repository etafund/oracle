import { describe, expect, test } from "vitest";
import {
  buildAttachmentReadyExpressionForTest,
  buildSendButtonTargetExpressionForTest,
} from "../../src/browser/actions/promptComposer.ts";
import {
  buildChatGptProDomProbeExpressionForTest,
  classifyGpt56SolProRouteProbeForTest,
} from "../../src/browser/providers/chatgptDomProvider.ts";

class FakeElement {
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[];
  readonly tagName: string;

  constructor(
    tagName: string,
    private readonly attributes: Record<string, string> = {},
    children: FakeElement[] = [],
    private readonly ownText = "",
  ) {
    this.tagName = tagName.toUpperCase();
    this.children = children;
    for (const child of children) {
      child.parentElement = this;
    }
  }

  get innerText(): string {
    return this.textContent;
  }

  get textContent(): string {
    return `${this.ownText}${this.children.map((child) => child.textContent).join("")}`;
  }

  get hidden(): boolean {
    return this.attributes.hidden === "true" || this.attributes["data-hidden"] === "true";
  }

  get isConnected(): boolean {
    return this.attributes["data-connected"] !== "false";
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  hasAttribute(name: string): boolean {
    return this.attributes[name] !== undefined;
  }

  getBoundingClientRect(): {
    width: number;
    height: number;
    left: number;
    top: number;
  } {
    const hidden = this.attributes["data-hidden"] === "true";
    return {
      width: hidden ? 0 : Number(this.attributes["data-width"] ?? 100),
      height: hidden ? 0 : Number(this.attributes["data-height"] ?? 40),
      left: Number(this.attributes["data-left"] ?? 0),
      top: Number(this.attributes["data-top"] ?? 0),
    };
  }

  contains(node: FakeElement): boolean {
    return node === this || flattenElements(this.children).includes(node);
  }

  scrollIntoView(): void {}

  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return flattenElements(this.children).filter((element) => matchesSelector(element, selector));
  }
}

class FakeInputElement extends FakeElement {
  constructor(readonly files: Array<{ name: string }>) {
    super("input", { type: "file" });
  }
}

class FakeDocument {
  readonly body: FakeElement;
  readonly documentElement: FakeElement;

  constructor(children: FakeElement[]) {
    this.body = new FakeElement("body", {}, children);
    this.documentElement = this.body;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  elementFromPoint(): FakeElement | null {
    return (
      flattenElements(this.body.children).find(
        (element) => element.getAttribute("data-hit-target") === "true",
      ) ?? null
    );
  }
}

function flattenElements(elements: FakeElement[]): FakeElement[] {
  return elements.flatMap((element) => [element, ...flattenElements(element.children)]);
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  return splitSelectorList(selector)
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchesSingleSelector(element, part));
}

function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (quote) {
      if (character === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    else if (character === "," && bracketDepth === 0 && parenthesisDepth === 0) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

function matchesSingleSelector(element: FakeElement, selector: string): boolean {
  const normalized = selector.replace(/:not\([^)]*\)/g, "");
  const tag = normalized.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;

  const id = normalized.match(/#([a-z0-9_-]+)/i)?.[1];
  if (id && element.getAttribute("id") !== id) return false;

  for (const classMatch of normalized.matchAll(/\.([a-z0-9_-]+)/gi)) {
    const classes = (element.getAttribute("class") ?? "").split(/\s+/u).filter(Boolean);
    if (!classes.includes(classMatch[1])) return false;
  }

  const attrPattern = /\[([^\]\s~|^$*!=]+)(\*?=)?(?:"([^"]*)"|'([^']*)')?\s*i?\]/g;
  for (const match of normalized.matchAll(attrPattern)) {
    const [, name, operator, doubleQuotedValue, singleQuotedValue] = match;
    const expected = doubleQuotedValue ?? singleQuotedValue ?? "";
    const actual = element.getAttribute(name);
    if (actual === null) return false;
    if (operator === "=" && actual !== expected) return false;
    if (operator === "*=" && !actual.toLowerCase().includes(expected.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function evaluateAttachmentReadyExpression(
  attachmentNames: Array<string | { name: string; generatedBundle?: boolean }>,
  document: FakeDocument,
  bindingToken?: string,
  bindToken = false,
): boolean {
  const expression = buildAttachmentReadyExpressionForTest(
    attachmentNames,
    bindingToken,
    bindToken,
  );
  const evaluate = new Function(
    "document",
    "HTMLElement",
    "HTMLInputElement",
    `return ${expression};`,
  ) as (
    document: FakeDocument,
    HTMLElement: typeof FakeElement,
    HTMLInputElement: typeof FakeInputElement,
  ) => boolean;
  return evaluate(document, FakeElement, FakeInputElement);
}

function evaluateSendButtonTargetExpression(
  document: FakeDocument,
  bindingToken?: string,
): { status?: string; reason?: string; x?: number; y?: number } {
  const expression = buildSendButtonTargetExpressionForTest(bindingToken);
  const evaluate = new Function(
    "document",
    "HTMLElement",
    "Node",
    "window",
    `return ${expression};`,
  ) as (
    document: FakeDocument,
    HTMLElement: typeof FakeElement,
    Node: typeof FakeElement,
    window: unknown,
  ) => { status?: string; reason?: string; x?: number; y?: number };
  return evaluate(document, FakeElement, FakeElement, {
    getComputedStyle: (node: FakeElement) => ({
      display: node.hidden ? "none" : (node.getAttribute("data-display") ?? "block"),
      visibility: node.getAttribute("data-visibility") ?? "visible",
      pointerEvents: node.getAttribute("data-pointer-events") ?? "auto",
    }),
  });
}

function evaluateBoundRouteProbe(
  document: FakeDocument,
  bindingToken: string,
): ReturnType<typeof classifyGpt56SolProRouteProbeForTest> {
  const expression = buildChatGptProDomProbeExpressionForTest(bindingToken);
  const evaluate = new Function("document", "window", `return ${expression};`) as (
    document: FakeDocument,
    window: unknown,
  ) => {
    routeModelSignals?: readonly string[];
    routeModeSignals?: readonly string[];
    hasProPill?: boolean;
    composerBindingVerified?: boolean;
  };
  const probe = evaluate(document, {
    location: { href: "https://chatgpt.com/" },
    getComputedStyle: (node: FakeElement) => ({
      display: node.hidden ? "none" : (node.getAttribute("data-display") ?? "block"),
      visibility: node.getAttribute("data-visibility") ?? "visible",
    }),
  });
  return classifyGpt56SolProRouteProbeForTest(probe);
}

function evaluateDispatchBoundRouteProbe(
  document: FakeDocument,
  composerBindingToken: string,
): ReturnType<typeof classifyGpt56SolProRouteProbeForTest> {
  const expression = buildChatGptProDomProbeExpressionForTest(undefined, composerBindingToken);
  const evaluate = new Function("document", "window", `return ${expression};`) as (
    document: FakeDocument,
    window: unknown,
  ) => {
    routeModelSignals?: readonly string[];
    routeModeSignals?: readonly string[];
    hasProPill?: boolean;
    composerBindingVerified?: boolean;
  };
  return classifyGpt56SolProRouteProbeForTest(
    evaluate(document, {
      location: { href: "https://chatgpt.com/" },
      getComputedStyle: (node: FakeElement) => ({
        display: node.hidden ? "none" : (node.getAttribute("data-display") ?? "block"),
        visibility: node.getAttribute("data-visibility") ?? "visible",
      }),
    }),
  );
}

function makeRouteComposer(args: {
  bindingToken?: string;
  composerBindingToken?: string;
  model?: string;
  secondaryModel?: string;
  mode?: string;
  proPill?: boolean;
  hidden?: boolean;
}): FakeElement {
  const children = [
    new FakeElement("div", {
      id: "prompt-textarea",
      contenteditable: "true",
      role: "textbox",
    }),
    new FakeElement(
      "button",
      { "data-testid": "model-switcher-dropdown-button" },
      [],
      args.model ?? "GPT-5.6 Sol",
    ),
  ];
  if (args.secondaryModel) {
    children.push(
      new FakeElement("div", { "data-testid": "composer-model-label" }, [], args.secondaryModel),
    );
  }
  if (args.mode) {
    children.push(
      new FakeElement("button", { "data-testid": "effort-picker-button" }, [], args.mode),
    );
  }
  if (args.proPill) {
    children.push(new FakeElement("button", { class: "__composer-pill" }, [], "Pro"));
  }
  children.push(new FakeElement("button", { "data-testid": "send-button" }, [], "Send"));
  return new FakeElement(
    "div",
    {
      "data-testid": "unified-composer",
      ...(args.bindingToken ? { "data-oracle-attachment-binding": args.bindingToken } : {}),
      ...(args.composerBindingToken
        ? { "data-oracle-send-composer-binding": args.composerBindingToken }
        : {}),
      ...(args.hidden ? { "data-hidden": "true" } : {}),
    },
    children,
  );
}

describe("prompt composer attachment expressions", () => {
  test("the fixture selector engine distinguishes bare class selectors", () => {
    const proseMirror = new FakeElement("div", { class: "ProseMirror" });
    const other = new FakeElement("div", { class: "not-the-editor" });
    const document = new FakeDocument([other, proseMirror]);

    expect(document.querySelectorAll(".ProseMirror")).toEqual([proseMirror]);
  });

  test("attachment ready check does not match prompt text", () => {
    const expression = buildAttachmentReadyExpressionForTest(["oracle-attach-verify.txt"]);
    expect(expression).toContain("closestComposerRoot(activePrompt)");
    expect(expression).toContain("firstComposerRoot()");
    expect(expression).not.toContain("document.querySelector('[data-testid*=\"composer\"]') ||");
    expect(expression).toContain("attachmentRoots");
    expect(expression).toContain('input[type="file"]');
    expect(expression).toContain('[aria-label*="Remove file"]');
    // Composer-internal nodes (the editable prompt itself) must not be treated as chips,
    // otherwise prompt text containing the filename would falsely satisfy the check.
    expect(expression).toContain("closest('textarea,[contenteditable=\"true\"]')");
    expect(expression).not.toContain("a,div,span");
    expect(expression).not.toContain(
      'document.querySelectorAll(\'[data-testid*="chip"],[data-testid*="attachment"],a,div,span\')',
    );
  });

  test("attachment ready check tolerates ChatGPT chip DOM that omits filename in attributes", () => {
    const expression = buildAttachmentReadyExpressionForTest(["paper1_plan_v3.md"]);
    // Walks into ancestor and descendant text so filenames buried in nested spans are still found.
    expect(expression).toContain("collectLabelHaystack");
    expect(expression).toContain("parentElement");
    // ChatGPT can rename duplicate uploads as e.g. README(1).md; matching on the
    // expected basename stem keeps the send check aligned with the upload check.
    expect(expression).toContain("item.stem");
    expect(expression).toContain("text.includes(item.stem + '(')");
    // Count-based fallback: when ChatGPT hides the filename entirely, accept that we
    // see at least as many chip-shaped nodes (each with a Remove affordance) as we
    // uploaded.
    expect(expression).toContain("countReady");
    expect(expression).toContain("removeAffordances");
  });

  test("attachment ready check stays scoped to the active composer", () => {
    const expression = buildAttachmentReadyExpressionForTest(["paper1_plan_v3.md"]);

    expect(expression).toContain("const attachmentRoots = Array.from(new Set([composer]))");
    expect(expression).not.toContain("new Set([composer, document])");
  });

  test("attachment binding fails closed when ChatGPT remounts the composer after upload", () => {
    const fileName = "oracle-remount-proof.txt";
    const makeComposer = () =>
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
        new FakeElement("div", {
          id: "prompt-textarea",
          contenteditable: "true",
          role: "textbox",
        }),
        new FakeElement("button", {
          "aria-label": "Send prompt",
          "data-testid": "send-button",
        }),
      ]);
    const originalComposer = makeComposer();
    const originalDocument = new FakeDocument([originalComposer]);

    expect(evaluateAttachmentReadyExpression([fileName], originalDocument, "binding-1", true)).toBe(
      true,
    );
    expect(originalComposer.getAttribute("data-oracle-attachment-binding")).toBe("binding-1");

    // Same visible chip text on a new DOM node is not enough. React can leave
    // stale-looking attachment UI after a model transition while its submit
    // controller has already been replaced.
    const remountedDocument = new FakeDocument([makeComposer()]);
    expect(
      evaluateAttachmentReadyExpression([fileName], remountedDocument, "binding-1", false),
    ).toBe(false);
    expect(evaluateSendButtonTargetExpression(remountedDocument, "binding-1")).toMatchObject({
      status: "binding-missing",
      reason: "attachment-composer-remounted",
    });
  });

  test("send target is the enabled hit-tested button inside the visible active composer", () => {
    const staleSend = new FakeElement("button", {
      "data-testid": "send-button",
      "data-left": "10",
      "data-top": "10",
    });
    const activeSend = new FakeElement("button", {
      "data-testid": "send-button",
      "data-left": "500",
      "data-top": "300",
      "data-hit-target": "true",
    });
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", {
          id: "prompt-textarea",
          contenteditable: "true",
          role: "textbox",
          "data-hidden": "true",
        }),
        staleSend,
      ]),
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", {
          id: "prompt-textarea",
          contenteditable: "true",
          role: "textbox",
        }),
        activeSend,
      ]),
    ]);

    expect(evaluateSendButtonTargetExpression(document)).toMatchObject({
      status: "point",
      x: 550,
      y: 320,
    });
  });

  test("attachment ready check ignores a composer-plus button before the real form", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("form", {}, [
        new FakeElement("button", { "data-testid": "composer-plus-btn" }),
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
        new FakeElement(
          "div",
          { id: "prompt-textarea", contenteditable: "true", role: "textbox" },
          [],
          "Diagnostic attachment send readiness repro. Reply exactly OK.",
        ),
        new FakeElement("button", {
          "aria-label": "Send prompt",
          "data-testid": "send-button",
        }),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(true);
  });

  test("attachment ready check fails closed when no active composer input identifies the right form", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("form", {}, [], "Search chats"),
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
        new FakeElement("button", {
          "aria-label": "Send prompt",
          "data-testid": "send-button",
        }),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document, "binding-1", true)).toBe(false);
  });

  test("attachment ready check uses send button composer wrapper before its form", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
        new FakeElement("form", {}, [
          new FakeElement("button", {
            "aria-label": "Send prompt",
            "data-testid": "send-button",
          }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(true);
  });

  test("attachment ready check skips footer action wrappers around send button", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], fileName),
          new FakeElement("button", { "aria-label": `Remove file 1: ${fileName}` }),
        ]),
        new FakeElement("div", { "data-testid": "composer-footer-actions" }, [
          new FakeElement("button", {
            "aria-label": "Send prompt",
            "data-testid": "send-button",
          }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(true);
  });

  test("attachment ready check tolerates duplicate-renamed chips", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README(1).md"),
          new FakeElement("button", { "aria-label": "Remove file 1: README(1).md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(true);
  });

  test("attachment ready check accepts generated bundle chips that expose only the bundle stem", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { role: "group", "aria-label": "attachments-bundle" }, [
          new FakeElement("span", {}, [], "Document"),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(true);
  });

  test("attachment ready check keeps stem-only fallback off for user bundle-named files", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { role: "group", "aria-label": "attachments-bundle" }, [
          new FakeElement("span", {}, [], "Document"),
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["attachments-bundle.txt"], document)).toBe(false);
  });

  test("attachment ready check accepts duplicate-renamed generated bundle chips", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "attachments-bundle(13).txt"),
          new FakeElement("button", { "aria-label": "Remove file 1: attachments-bundle(13).txt" }),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(true);
  });

  test("attachment ready check rejects duplicate-renamed generated bundle chips with the wrong extension", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "attachments-bundle(13).md"),
          new FakeElement("button", { "aria-label": "Remove file 1: attachments-bundle(13).md" }),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(false);
  });

  test("attachment ready check accepts generated zip bundle chips that expose only the bundle stem", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "attachments-bundle"),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.zip", generatedBundle: true }],
        document,
      ),
    ).toBe(true);
  });

  test("attachment ready check does not use stem-only fallback for non-bundle files", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README"),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(false);
  });

  test("attachment ready check does not match generated bundle stem inside another filename", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "not-attachments-bundle.txt"),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(false);
  });

  test("attachment ready check does not match generated bundle stem with a different extension", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "attachments-bundle.md"),
        ]),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        [{ name: "attachments-bundle.txt", generatedBundle: true }],
        document,
      ),
    ).toBe(false);
  });

  test("attachment ready check does not let one duplicate-renamed chip satisfy same-stem files", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README(1).md"),
          new FakeElement("button", { "aria-label": "Remove file 1: README(1).md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md", "README.txt"], document)).toBe(false);
  });

  test("attachment ready check does not match extension prefixes in duplicate-renamed chips", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README(1).mdx"),
          new FakeElement("button", { "aria-label": "Remove file 1: README(1).mdx" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(false);
  });

  test("attachment ready check does not match extension prefixes in visible chip names", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "README.mdx"),
          new FakeElement("button", { "aria-label": "Remove file 1: README.mdx" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["README.md"], document)).toBe(false);
  });

  test("attachment ready count fallback counts remove affordances inside one wrapper", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-list" }, [
          new FakeElement("div", { "data-testid": "attachment-chip" }, [
            new FakeElement("button", { "aria-label": "Remove file 1" }),
          ]),
          new FakeElement("div", { "data-testid": "attachment-chip" }, [
            new FakeElement("button", { "aria-label": "Remove file 2" }),
          ]),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt", "two.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback accepts generic remove controls under chips", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("button", { "aria-label": "Remove" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback allows mixed visible and hidden chip labels", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "one.txt"),
          new FakeElement("button", { "aria-label": "Remove file 1: one.txt" }),
        ]),
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("button", { "aria-label": "Remove file 2" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt", "two.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback ignores prompt text extensions", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement(
          "div",
          { id: "prompt-textarea", contenteditable: "true", role: "textbox" },
          [],
          "Please compare this with notes.md",
        ),
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback ignores decimal size text", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "1.2 MB"),
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(true);
  });

  test("attachment ready count fallback ignores unrelated remove controls", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("button", { "aria-label": "Remove item" }),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["one.txt"], document)).toBe(false);
  });

  test("attachment ready check tolerates ellipsized chip names", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "paper1…v3"),
          new FakeElement("button", { "aria-label": "Remove file 1: paper1…v3" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["paper1_plan_v3.md"], document)).toBe(true);
  });

  test("attachment ready check tolerates ellipsized chip names with extensions", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "paper1…v3.md"),
          new FakeElement("button", { "aria-label": "Remove file 1: paper1…v3.md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["paper1_plan_v3.md"], document)).toBe(true);
  });

  test("attachment ready check tolerates ellipsized chip names with spaced prefixes", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "my paper…v3.md"),
          new FakeElement("button", { "aria-label": "Remove file 1: my paper…v3.md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["my paper_plan_v3.md"], document)).toBe(true);
  });

  test("attachment ready check rejects ambiguous ellipsis placeholders", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "...md"),
          new FakeElement("button", { "aria-label": "Remove file 1: ...md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["paper.md"], document)).toBe(false);
  });

  test("attachment ready check rejects unrelated ellipsized chip names", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "ape…md"),
          new FakeElement("button", { "aria-label": "Remove file 1: ape…md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["scrapegoat.md"], document)).toBe(false);
  });

  test("attachment ready check rejects ambiguous short ellipsized prefixes", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "a…md"),
          new FakeElement("button", { "aria-label": "Remove file 1: a…md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["anything.md"], document)).toBe(false);
  });

  test("attachment ready check accepts short ellipsized prefixes with strong suffixes", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "qa…v1.md"),
          new FakeElement("button", { "aria-label": "Remove file 1: qa…v1.md" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["qa-quarterly-report-v1.md"], document)).toBe(true);
  });

  test("attachment ready count fallback allows prefix-only ellipsized labels", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeElement("div", { "data-testid": "attachment-chip" }, [
          new FakeElement("span", {}, [], "paper1…"),
          new FakeElement("button", { "aria-label": "Remove file 1" }),
        ]),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression(["paper1_plan_v3.md"], document)).toBe(true);
  });

  test("attachment ready check still rejects prompt-only filename matches", () => {
    const fileName = "oracle-diagnostic-unique-20260521.txt";
    const document = new FakeDocument([
      new FakeElement("form", {}, [
        new FakeElement("button", { "data-testid": "composer-plus-btn" }),
        new FakeElement(
          "div",
          { id: "prompt-textarea", contenteditable: "true", role: "textbox" },
          [],
          `Please mention ${fileName} without uploading it.`,
        ),
        new FakeElement("button", {
          "aria-label": "Send prompt",
          "data-testid": "send-button",
        }),
      ]),
    ]);

    expect(evaluateAttachmentReadyExpression([fileName], document)).toBe(false);
  });
});

describe("post-upload protected-route binding", () => {
  const bindingToken = "attachment-binding-exact-1";

  test("uses only visible route signals from the exact token-bound active composer", () => {
    const boundComposer = makeRouteComposer({ bindingToken, proPill: true });
    const hiddenStaleComposer = makeRouteComposer({
      bindingToken,
      model: "GPT-5.6 Sol Mini",
      mode: "Standard",
      hidden: true,
    });
    const documentStaleSignals = new FakeElement("div", {}, [
      new FakeElement(
        "div",
        {
          role: "menuitem",
          "data-testid": "model-switcher-stale",
          "aria-selected": "true",
        },
        [],
        "GPT-5.6 Sol Mini",
      ),
      new FakeElement("button", { class: "__composer-pill" }, [], "Standard"),
    ]);
    const document = new FakeDocument([hiddenStaleComposer, documentStaleSignals, boundComposer]);

    expect(evaluateBoundRouteProbe(document, bindingToken)).toMatchObject({
      verified: true,
      composerBindingVerified: true,
      modelVerified: true,
      modeVerified: true,
      modelSignals: ["gpt 5 6 sol"],
      modeSignals: ["pro"],
    });
  });

  test("rejects conflicting exact and lookalike model signals on the bound composer", () => {
    const document = new FakeDocument([
      makeRouteComposer({
        bindingToken,
        model: "GPT-5.6 Sol",
        secondaryModel: "GPT-5.6 Sol Mini",
        proPill: true,
      }),
    ]);

    const evidence = evaluateBoundRouteProbe(document, bindingToken);
    expect(evidence).toMatchObject({
      verified: false,
      composerBindingVerified: true,
      modelVerified: false,
      modeVerified: true,
    });
    expect(evidence.modelSignals).toEqual(
      expect.arrayContaining(["gpt 5 6 sol", "gpt 5 6 sol mini"]),
    );
  });

  test("rejects bound Standard even when a foreign global Pro pill exists", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "foreign-toolbar" }, [
        new FakeElement("button", { class: "__composer-pill" }, [], "Pro"),
      ]),
      makeRouteComposer({ bindingToken, mode: "Standard" }),
    ]);

    expect(evaluateBoundRouteProbe(document, bindingToken)).toMatchObject({
      verified: false,
      composerBindingVerified: true,
      modelVerified: true,
      modeVerified: false,
      modeSignals: ["standard"],
    });
  });

  test("text-only route proof cannot borrow Sol + Pro from a foreign visible composer", () => {
    const composerBindingToken = "dispatch-composer-exact-1";
    const selectedStandardComposer = makeRouteComposer({
      composerBindingToken,
      model: "GPT-5.6 Sol",
      mode: "Standard",
    });
    const foreignSolProComposer = makeRouteComposer({ proPill: true });
    const document = new FakeDocument([selectedStandardComposer, foreignSolProComposer]);

    expect(evaluateDispatchBoundRouteProbe(document, composerBindingToken)).toMatchObject({
      verified: false,
      composerBindingVerified: true,
      modelVerified: true,
      modeVerified: false,
      modeSignals: ["standard"],
    });
  });

  test("fails closed after a composer remount drops the exact attachment token", () => {
    const document = new FakeDocument([
      makeRouteComposer({ bindingToken: "replacement-composer", proPill: true }),
    ]);

    expect(evaluateBoundRouteProbe(document, bindingToken)).toMatchObject({
      verified: false,
      composerBindingVerified: false,
      modelVerified: false,
      modeVerified: false,
      modelSignals: [],
      modeSignals: [],
    });
  });

  test("route probe stays read-only", () => {
    const expression = buildChatGptProDomProbeExpressionForTest(bindingToken);
    expect(expression).not.toMatch(/\.click\(|dispatchClick|dispatchEvent|setAttribute/);
  });
});
