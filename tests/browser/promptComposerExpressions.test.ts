import { describe, expect, test } from "vitest";
import {
  buildAttachmentReadyExpressionForTest,
  buildSendButtonTargetExpressionForTest,
} from "../../src/browser/actions/promptComposer.ts";
import {
  buildChatGptProDomProbeExpressionForTest,
  buildGpt56SolProFinalDispatchGuard,
  classifyGpt56SolProRouteProbeForTest,
} from "../../src/browser/providers/chatgptDomProvider.ts";

interface FakeDomEvent {
  type: string;
  target: FakeElement;
  currentTarget: unknown;
  isTrusted: boolean;
  button: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  defaultPrevented: boolean;
  immediatePropagationStopped: boolean;
  propagationStopped: boolean;
  composedPath: () => unknown[];
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
  stopPropagation: () => void;
}

type FakeDomListener = (event: FakeDomEvent) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, FakeDomListener[]>();

  addEventListener(
    type: string,
    listener: FakeDomListener,
    _options?: boolean | { capture?: boolean; passive?: boolean },
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: FakeDomListener,
    _options?: boolean | { capture?: boolean },
  ): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  invokeListeners(event: FakeDomEvent): void {
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) ?? []) {
      if (event.immediatePropagationStopped) break;
      listener(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

class FakeElement extends FakeEventTarget {
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[];
  readonly tagName: string;

  constructor(
    tagName: string,
    private readonly attributes: Record<string, string> = {},
    children: FakeElement[] = [],
    private ownText = "",
  ) {
    super();
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

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  setText(value: string): void {
    this.ownText = value;
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

class FakeTextAreaElement extends FakeElement {}

class FakeButtonElement extends FakeElement {
  readonly disabled = false;
}

class FakeDocument extends FakeEventTarget {
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  activeElement: FakeElement | null;
  private hitTarget: FakeElement | null = null;

  constructor(children: FakeElement[]) {
    super();
    this.body = new FakeElement("body", {}, children);
    this.documentElement = this.body;
    const promptCandidates = flattenElements(this.body.children).filter(
      (element) =>
        (element.getAttribute("id") === "prompt-textarea" ||
          element.getAttribute("contenteditable") === "true" ||
          element.tagName.toLowerCase() === "textarea") &&
        element.getBoundingClientRect().width > 0 &&
        element.getBoundingClientRect().height > 0,
    );
    this.activeElement = promptCandidates.length === 1 ? promptCandidates[0] : null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  elementFromPoint(): FakeElement | null {
    return (
      this.hitTarget ??
      flattenElements(this.body.children).find(
        (element) => element.getAttribute("data-hit-target") === "true",
      ) ??
      null
    );
  }

  setHitTarget(target: FakeElement | null): void {
    this.hitTarget = target;
  }

  setActiveElement(target: FakeElement | null): void {
    this.activeElement = target;
  }
}

class FakeWindow extends FakeEventTarget {
  [key: string]: unknown;
  readonly location = { href: "https://chatgpt.com/" };
  private timerCallback: (() => void) | null = null;

  getComputedStyle(node: FakeElement): {
    display: string;
    visibility: string;
    pointerEvents: string;
  } {
    return {
      display: node.hidden ? "none" : (node.getAttribute("data-display") ?? "block"),
      visibility: node.getAttribute("data-visibility") ?? "visible",
      pointerEvents: node.getAttribute("data-pointer-events") ?? "auto",
    };
  }

  setTimeout(callback: () => void): number {
    this.timerCallback = callback;
    return 1;
  }

  clearTimeout(): void {
    this.timerCallback = null;
  }

  expireGuard(): void {
    const callback = this.timerCallback;
    this.timerCallback = null;
    callback?.();
  }

  dispatchDomEvent(
    document: FakeDocument,
    type: string,
    target: FakeElement,
    options: { isTrusted?: boolean; button?: number; pointerType?: string } = {},
  ): FakeDomEvent {
    const ancestors: FakeElement[] = [];
    let current: FakeElement | null = target;
    while (current) {
      ancestors.push(current);
      current = current.parentElement;
    }
    const path: unknown[] = [...ancestors, document, this];
    const event: FakeDomEvent = {
      type,
      target,
      currentTarget: null,
      isTrusted: options.isTrusted ?? true,
      button: options.button ?? 0,
      pointerType: options.pointerType ?? "mouse",
      clientX: 50,
      clientY: 20,
      defaultPrevented: false,
      immediatePropagationStopped: false,
      propagationStopped: false,
      composedPath: () => path,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
        this.propagationStopped = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
    };
    this.invokeListeners(event);
    if (!event.propagationStopped) document.invokeListeners(event);
    if (!event.propagationStopped) target.invokeListeners(event);
    return event;
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
  sendBindingToken?: string,
  exactSet = false,
): boolean {
  const expression = buildAttachmentReadyExpressionForTest(
    attachmentNames,
    bindingToken,
    bindToken,
    sendBindingToken,
    exactSet,
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

  test("exact attachment readiness rejects an extra uploading or unlabeled attachment", () => {
    const expectedName = "expected-review.md";
    const makeDocument = (extra: FakeElement) =>
      new FakeDocument([
        new FakeElement("div", { "data-testid": "unified-composer" }, [
          new FakeElement("div", { "data-testid": "attachment-chip" }, [
            new FakeElement("span", {}, [], expectedName),
            new FakeElement("button", { "aria-label": `Remove file 1: ${expectedName}` }),
          ]),
          extra,
          new FakeElement(
            "div",
            { id: "prompt-textarea", contenteditable: "true", role: "textbox" },
            [],
            "review",
          ),
          new FakeElement("button", { "data-testid": "send-button" }),
        ]),
      ]);

    const uploading = makeDocument(
      new FakeElement("div", {
        "data-testid": "attachment-upload",
        "data-state": "uploading",
      }),
    );
    expect(evaluateAttachmentReadyExpression([expectedName], uploading)).toBe(true);
    expect(
      evaluateAttachmentReadyExpression(
        [expectedName],
        uploading,
        undefined,
        false,
        undefined,
        true,
      ),
    ).toBe(false);

    const unlabeled = makeDocument(new FakeElement("div", { "data-testid": "attachment-chip" }));
    expect(
      evaluateAttachmentReadyExpression(
        [expectedName],
        unlabeled,
        undefined,
        false,
        undefined,
        true,
      ),
    ).toBe(false);
  });

  test("exact attachment readiness proves file multiplicity without reusing one match", () => {
    const document = new FakeDocument([
      new FakeElement("div", { "data-testid": "unified-composer" }, [
        new FakeInputElement([{ name: "same.md" }]),
        new FakeElement("div", {
          id: "prompt-textarea",
          contenteditable: "true",
          role: "textbox",
        }),
        new FakeElement("button", { "data-testid": "send-button" }),
      ]),
    ]);

    expect(
      evaluateAttachmentReadyExpression(
        ["same.md", "same.md"],
        document,
        undefined,
        false,
        undefined,
        true,
      ),
    ).toBe(false);
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

  function installDispatchGuard(exactPrompt?: string) {
    const composerBindingToken = "dispatch-race-guard-1";
    const composer = makeRouteComposer({ composerBindingToken, mode: "Pro" });
    const sendButton = composer.querySelector('[data-testid="send-button"]');
    const editor = composer.querySelector('[contenteditable="true"]');
    const modeButton = composer.querySelector('[data-testid="effort-picker-button"]');
    expect(sendButton).not.toBeNull();
    expect(editor).not.toBeNull();
    expect(modeButton).not.toBeNull();
    sendButton!.setAttribute("data-oracle-send-binding", composerBindingToken);
    editor!.setAttribute("data-oracle-send-editor-binding", composerBindingToken);
    if (exactPrompt !== undefined) editor!.setText(exactPrompt);
    const document = new FakeDocument([composer]);
    document.setActiveElement(editor);
    document.setHitTarget(sendButton);
    const windowStub = new FakeWindow();
    const evaluate = (expression: string): unknown =>
      new Function(
        "document",
        "window",
        "HTMLElement",
        "HTMLInputElement",
        "HTMLTextAreaElement",
        "HTMLButtonElement",
        "Node",
        `return ${expression};`,
      )(
        document,
        windowStub,
        FakeElement,
        FakeInputElement,
        FakeTextAreaElement,
        FakeButtonElement,
        FakeElement,
      );

    expect(evaluateDispatchBoundRouteProbe(document, composerBindingToken).verified).toBe(true);
    const guard = buildGpt56SolProFinalDispatchGuard(undefined, composerBindingToken, {
      exactSubmission:
        exactPrompt === undefined ? undefined : { prompt: exactPrompt, attachments: [] },
    });
    const bindingPayloads: string[] = [];
    expect(guard.verdictBinding).toBeDefined();
    windowStub[guard.verdictBinding!.name] = (payload: string) => bindingPayloads.push(payload);
    const installed = evaluate(guard.expression);
    expect((installed as { routeProof?: unknown }).routeProof).toMatchObject({
      composerBindingVerified: true,
      routeModelSignals: ["GPT-5.6 Sol"],
      routeModeSignals: ["Pro"],
    });
    expect(installed).toMatchObject({ installed: true, status: "armed", reason: null });
    expect(() => guard.assertResult(installed)).not.toThrow();
    return {
      bindingPayloads,
      composer,
      composerBindingToken,
      document,
      editor: editor!,
      evaluate,
      guard,
      modeButton: modeButton!,
      sendButton: sendButton!,
      windowStub,
    };
  }

  test("trusted-event guard blocks a same-node route-label change after preflight", () => {
    const fixture = installDispatchGuard();

    // The exact same selected-mode node changes after the async preflight but
    // before trusted CDP input reaches the button. The capture listener runs
    // synchronously inside the event and prevents every dispatch phase.
    fixture.modeButton.setText("Standard");
    for (const eventType of ["mousedown", "mouseup", "click"]) {
      expect(
        fixture.windowStub.dispatchDomEvent(fixture.document, eventType, fixture.sendButton)
          .defaultPrevented,
      ).toBe(true);
    }

    expect(fixture.bindingPayloads).toHaveLength(1);
    expect(
      fixture.guard.verdictBinding?.parsePayload(fixture.bindingPayloads[0] ?? ""),
    ).toMatchObject({ status: "blocked", reason: "protected-route-changed" });
    const verdict = fixture.evaluate(fixture.guard.afterDispatchExpression!);
    expect(fixture.guard.isDispatchDefinitelyBlocked?.(verdict)).toBe(true);
    let failure: unknown;
    try {
      fixture.guard.assertAfterDispatchResult?.(verdict);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "BrowserAutomationError",
      details: { code: "protected-route-dispatch-blocked", retryable: false },
    });
    expect(fixture.sendButton.getAttribute("data-oracle-send-binding")).toBeNull();
    expect(fixture.composer.getAttribute("data-oracle-send-composer-binding")).toBeNull();
    expect(fixture.document.listenerCount("click")).toBe(0);
    expect(fixture.windowStub.listenerCount("click")).toBe(0);
  });

  test("trusted-event guard binds the exact focused prompt, not a stale sibling editor", () => {
    const fixture = installDispatchGuard("complete expected prompt");
    fixture.editor.setText("truncated");
    const stale = new FakeElement(
      "div",
      {
        id: "prompt-textarea",
        contenteditable: "true",
        role: "textbox",
        "data-hidden": "true",
      },
      [],
      "complete expected prompt",
    );
    stale.parentElement = fixture.document.body;
    fixture.document.body.children.unshift(stale);

    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "blocked",
      reason: "exact-prompt-changed",
    });
  });

  test("only the final exact trusted click reaches application handlers and authorizes", () => {
    const fixture = installDispatchGuard();
    const observedByApplication: string[] = [];
    fixture.sendButton.addEventListener("mousedown", () => observedByApplication.push("mousedown"));
    fixture.sendButton.addEventListener("mouseup", () => observedByApplication.push("mouseup"));
    fixture.sendButton.addEventListener("click", () => {
      expect(fixture.bindingPayloads).toHaveLength(1);
      observedByApplication.push("click");
    });

    for (const eventType of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const event = fixture.windowStub.dispatchDomEvent(
        fixture.document,
        eventType,
        fixture.sendButton,
      );
      expect(event.defaultPrevented).toBe(false);
      expect(event.propagationStopped).toBe(true);
    }
    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(click.defaultPrevented).toBe(false);
    expect(observedByApplication).toEqual(["click"]);

    const verdict = fixture.evaluate(fixture.guard.afterDispatchExpression!);
    expect(verdict).toMatchObject({ status: "allowed", lastEvent: "click" });
    expect(() => fixture.guard.assertAfterDispatchResult?.(verdict)).not.toThrow();
  });

  test("an untrusted or non-primary click cannot authorize protected dispatch", () => {
    for (const options of [{ isTrusted: false }, { isTrusted: true, button: 1 }]) {
      const fixture = installDispatchGuard();
      const click = fixture.windowStub.dispatchDomEvent(
        fixture.document,
        "click",
        fixture.sendButton,
        options,
      );
      expect(click.defaultPrevented).toBe(true);
      const verdict = fixture.evaluate(fixture.guard.afterDispatchExpression!);
      expect(verdict).toMatchObject({ status: "blocked" });
    }
  });

  test("a blocked precursor remains latched even when the route label is repaired", () => {
    const fixture = installDispatchGuard();
    fixture.modeButton.setText("Standard");
    expect(
      fixture.windowStub.dispatchDomEvent(fixture.document, "mousedown", fixture.sendButton)
        .defaultPrevented,
    ).toBe(true);
    fixture.modeButton.setText("Pro");
    expect(
      fixture.windowStub.dispatchDomEvent(fixture.document, "click", fixture.sendButton)
        .defaultPrevented,
    ).toBe(true);
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "blocked",
      reason: "protected-route-changed",
    });
  });

  test("composer, send candidate, and hit-target identity are revalidated at each event", () => {
    const mutations: Array<(fixture: ReturnType<typeof installDispatchGuard>) => void> = [
      (fixture) =>
        fixture.composer.setAttribute("data-oracle-send-composer-binding", "replacement"),
      (fixture) => fixture.sendButton.setAttribute("aria-disabled", "true"),
      (fixture) => fixture.document.setHitTarget(new FakeElement("div")),
      (fixture) => fixture.sendButton.setAttribute("data-oracle-send-binding", "replacement"),
      (fixture) => {
        const competingSend = new FakeElement("button", { "data-testid": "send-button" });
        competingSend.parentElement = fixture.composer;
        fixture.composer.children.unshift(competingSend);
      },
    ];
    for (const mutate of mutations) {
      const fixture = installDispatchGuard();
      mutate(fixture);
      const event = fixture.windowStub.dispatchDomEvent(
        fixture.document,
        "click",
        fixture.sendButton,
      );
      expect(event.defaultPrevented).toBe(true);
      expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
        status: "blocked",
      });
    }
  });

  test("moving the same bound button under an exact-label replacement composer is blocked", () => {
    const fixture = installDispatchGuard();
    const replacement = makeRouteComposer({
      composerBindingToken: fixture.composerBindingToken,
      mode: "Pro",
    });
    const replacementSend = replacement.querySelector('[data-testid="send-button"]');
    expect(replacementSend).not.toBeNull();
    replacement.children.splice(replacement.children.indexOf(replacementSend!), 1);
    fixture.composer.children.splice(fixture.composer.children.indexOf(fixture.sendButton), 1);
    replacement.children.push(fixture.sendButton);
    fixture.sendButton.parentElement = replacement;
    fixture.composer.parentElement = null;
    replacement.parentElement = fixture.document.body;
    fixture.document.body.children.splice(0, 1, replacement);

    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "blocked",
    });
  });

  test("a replacement send button cannot inherit the old binding token", () => {
    const fixture = installDispatchGuard();
    const replacement = new FakeElement("button", {
      "data-testid": "send-button",
      "data-oracle-send-binding": fixture.composerBindingToken,
    });
    const index = fixture.composer.children.indexOf(fixture.sendButton);
    fixture.composer.children.splice(index, 1, replacement);
    fixture.sendButton.parentElement = null;
    replacement.parentElement = fixture.composer;
    fixture.document.setHitTarget(replacement);

    const click = fixture.windowStub.dispatchDomEvent(fixture.document, "click", replacement);
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "blocked",
    });
  });

  test("an expired page guard remains fail-closed through the first late click", () => {
    const fixture = installDispatchGuard();
    expect(fixture.windowStub.listenerCount("click")).toBe(1);
    expect(fixture.document.listenerCount("click")).toBe(1);

    fixture.windowStub.expireGuard();

    expect(fixture.bindingPayloads).toHaveLength(1);
    expect(
      fixture.guard.verdictBinding?.parsePayload(fixture.bindingPayloads[0] ?? ""),
    ).toMatchObject({ status: "blocked", reason: "dispatch-guard-expired" });
    expect(fixture.windowStub.listenerCount("click")).toBe(1);
    expect(fixture.document.listenerCount("click")).toBe(1);
    expect(
      fixture.windowStub.dispatchDomEvent(fixture.document, "click", fixture.sendButton)
        .defaultPrevented,
    ).toBe(true);
    expect(fixture.evaluate(fixture.guard.immediatelyBeforeDispatchExpression!)).toMatchObject({
      status: "blocked",
      reason: "dispatch-guard-expired",
    });
    expect(() =>
      fixture.guard.assertImmediatelyBeforeDispatchResult?.(
        fixture.evaluate(fixture.guard.immediatelyBeforeDispatchExpression!),
      ),
    ).toThrow(/no longer armed/i);
    // The stale guard retires only after it has consumed the complete first
    // late click sequence, so a crashed controller cannot wedge manual use.
    fixture.windowStub.expireGuard();
    expect(fixture.windowStub.listenerCount("click")).toBe(0);
    expect(fixture.document.listenerCount("click")).toBe(0);
    expect(fixture.sendButton.getAttribute("data-oracle-send-binding")).toBeNull();
    expect(fixture.composer.getAttribute("data-oracle-send-composer-binding")).toBeNull();
  });
});
