import { describe, expect, test } from "vitest";
import {
  buildAttachmentReadyExpressionForTest,
  buildSendButtonTargetExpressionForTest,
} from "../../src/browser/actions/promptComposer.ts";
import {
  buildChatGptProDomProbeExpressionForTest,
  buildGpt56SolProFinalDispatchGuard,
  buildGpt56SolProPublicRouteProofExpressionForTest,
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

interface FakeMutationRecord {
  type: "attributes" | "characterData" | "childList";
  target: unknown;
  attributeName?: string;
  addedNodes?: unknown[];
  removedNodes?: unknown[];
}

class FakeMutationObserver {
  private static readonly observers = new Set<FakeMutationObserver>();
  private records: FakeMutationRecord[] = [];
  private target: unknown = null;
  private options: {
    subtree?: boolean;
    attributes?: boolean;
    characterData?: boolean;
    childList?: boolean;
    attributeFilter?: string[];
  } = {};
  private scheduled = false;

  constructor(private readonly callback: (records: FakeMutationRecord[]) => void) {}

  observe(
    target: unknown,
    options: {
      subtree?: boolean;
      attributes?: boolean;
      characterData?: boolean;
      childList?: boolean;
      attributeFilter?: string[];
    },
  ): void {
    this.target = target;
    this.options = options;
    FakeMutationObserver.observers.add(this);
  }

  disconnect(): void {
    FakeMutationObserver.observers.delete(this);
    this.target = null;
    this.records = [];
  }

  takeRecords(): FakeMutationRecord[] {
    const records = this.records;
    this.records = [];
    return records;
  }

  static notify(record: FakeMutationRecord): void {
    for (const observer of this.observers) observer.enqueue(record);
  }

  private enqueue(record: FakeMutationRecord): void {
    const target = record.target as { contains?: (node: unknown) => boolean } | null;
    const observed = this.target as { contains?: (node: unknown) => boolean } | null;
    if (
      !observed ||
      (target !== observed && !(this.options.subtree && observed.contains?.(target)))
    ) {
      return;
    }
    if (record.type === "attributes") {
      if (!this.options.attributes) return;
      if (
        this.options.attributeFilter &&
        record.attributeName &&
        !this.options.attributeFilter.includes(record.attributeName)
      ) {
        return;
      }
    }
    if (record.type === "characterData" && !this.options.characterData) return;
    if (record.type === "childList" && !this.options.childList) return;
    this.records.push(record);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const records = this.takeRecords();
      if (records.length > 0) this.callback(records);
    });
  }
}

class FakeElement extends FakeEventTarget {
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[];
  readonly tagName: string;
  private clickHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private hoverHandler: (() => void) | null = null;

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
    FakeMutationObserver.notify({ type: "attributes", target: this, attributeName: name });
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
    FakeMutationObserver.notify({ type: "attributes", target: this, attributeName: name });
  }

  setText(value: string): void {
    this.ownText = value;
    FakeMutationObserver.notify({ type: "characterData", target: this });
  }

  setClickHandler(handler: () => void): void {
    this.clickHandler = handler;
  }

  setFocusHandler(handler: () => void): void {
    this.focusHandler = handler;
  }

  setHoverHandler(handler: () => void): void {
    this.hoverHandler = handler;
  }

  click(): void {
    this.clickHandler?.();
  }

  focus(): void {
    this.focusHandler?.();
  }

  dispatchEvent(event: { type?: string }): boolean {
    if (event.type === "click") this.click();
    if (event.type === "pointerover") this.hoverHandler?.();
    return true;
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

  getClientRects(): Array<ReturnType<FakeElement["getBoundingClientRect"]>> {
    const rect = this.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
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
  private nextTimerId = 1;
  private readonly longTimers = new Map<number, () => void>();

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

  requestAnimationFrame(callback: () => void): number {
    queueMicrotask(callback);
    return 1;
  }

  setTimeout(callback: () => void, delay = 0): number {
    const id = this.nextTimerId++;
    if (delay >= 1_000) {
      this.longTimers.set(id, callback);
    } else {
      queueMicrotask(() => {
        if (!this.longTimers.has(id)) callback();
      });
    }
    return id;
  }

  clearTimeout(id?: number): void {
    if (id !== undefined) this.longTimers.delete(id);
  }

  expireGuard(): void {
    const timers = Array.from(this.longTimers.values());
    this.longTimers.clear();
    for (const callback of timers) callback();
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

class FakeMouseEvent {
  constructor(
    readonly type: string,
    readonly options: Record<string, unknown> = {},
  ) {}
}

class FakeKeyboardEvent extends FakeMouseEvent {}

interface PublicRouteFixtureOptions {
  additionalMenuPill?: boolean;
  additionalProPill?: boolean;
  attachmentToken?: string;
  composerBindingToken?: string;
  duplicateParentId?: boolean;
  duplicateSolRow?: "visible" | "hidden";
  fallbackOwnership?: boolean;
  fallbackPollution?: boolean;
  hiddenUnmarkedOtherModel?: boolean;
  modelCheckedLabel?: "GPT-5.6 Sol" | "GPT-5.6 Sol Mini";
  modelMarkerMissing?: boolean;
  modelOptionalMarkerConflict?: boolean;
  modelStateContradiction?: boolean;
  prompt?: string;
  proChecked?: boolean;
  proMarkerMissing?: boolean;
  proOptionalMarkerConflict?: boolean;
  proRowText?: string;
  proStateContradiction?: boolean;
  remountParentMenuOnModelOpen?: boolean;
  remountPillOnClose?: boolean;
  remountPillOnOpen?: boolean;
  remountSolTriggerOnOpen?: boolean;
  solRowText?: string;
  solOpensOnDelayedHover?: boolean;
  solTriggerText?: string;
  wrapComposerInForm?: boolean;
}

function makePublicRouteFixture(options: PublicRouteFixtureOptions = {}) {
  const composerBindingToken = options.composerBindingToken ?? "public-route-binding-1";
  const attachmentToken = options.attachmentToken;
  const prompt = options.prompt ?? "exact protected prompt";
  const editor = new FakeElement(
    "div",
    {
      id: "prompt-textarea",
      contenteditable: "true",
      role: "textbox",
      "data-oracle-send-editor-binding": composerBindingToken,
    },
    [],
    prompt,
  );
  let pill = new FakeElement(
    "button",
    {
      class: "__composer-pill",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      ...(options.fallbackOwnership ? {} : { "aria-controls": "intelligence-menu" }),
    },
    [],
    "Pro",
  );
  const sendButton = new FakeElement("button", {
    "data-testid": "send-button",
    "data-oracle-send-binding": composerBindingToken,
  });
  const additionalPill =
    options.additionalMenuPill || options.additionalProPill
      ? new FakeElement(
          "button",
          {
            class: "__composer-pill",
            "aria-haspopup": "menu",
            "aria-expanded": "false",
          },
          [],
          options.additionalProPill ? "Pro" : "Canvas",
        )
      : null;
  const composer = new FakeElement(
    "div",
    {
      "data-testid": "unified-composer",
      "data-oracle-send-composer-binding": composerBindingToken,
      ...(attachmentToken ? { "data-oracle-attachment-binding": attachmentToken } : {}),
    },
    [editor, pill, ...(additionalPill ? [additionalPill] : []), sendButton],
  );
  const form = options.wrapComposerInForm ? new FakeElement("form", {}, [composer]) : composer;

  const proChecked = options.proChecked !== false;
  const proRow = new FakeElement(
    "button",
    {
      role: "menuitemradio",
      "aria-checked": proChecked ? "true" : "false",
      ...(options.proMarkerMissing
        ? {}
        : {
            "data-state": options.proStateContradiction
              ? proChecked
                ? "unchecked"
                : "checked"
              : proChecked
                ? "checked"
                : "unchecked",
          }),
      ...(options.proOptionalMarkerConflict
        ? { "aria-selected": proChecked ? "false" : "true" }
        : {}),
    },
    [],
    options.proRowText ?? "Pro",
  );
  const standardRow = new FakeElement(
    "button",
    { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
    [],
    "Standard",
  );
  let solTrigger = new FakeElement(
    "button",
    {
      role: "menuitem",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      ...(options.fallbackOwnership ? {} : { "aria-controls": "sol-model-menu" }),
    },
    [],
    options.solTriggerText ?? "GPT-5.6 Sol",
  );
  let parentMenu = new FakeElement(
    "div",
    {
      id: "intelligence-menu",
      role: "menu",
      "data-hidden": "true",
    },
    [proRow, standardRow, solTrigger],
  );

  const selectedLabel = options.modelCheckedLabel ?? "GPT-5.6 Sol";
  const solChecked = selectedLabel === "GPT-5.6 Sol";
  const solRow = new FakeElement(
    "button",
    {
      role: "menuitemradio",
      "aria-checked": solChecked ? "true" : "false",
      ...(options.modelMarkerMissing
        ? {}
        : {
            "data-state": options.modelStateContradiction
              ? solChecked
                ? "unchecked"
                : "checked"
              : solChecked
                ? "checked"
                : "unchecked",
          }),
      ...(options.modelOptionalMarkerConflict
        ? { "data-selected": solChecked ? "false" : "true" }
        : {}),
    },
    [],
    options.solRowText ?? "GPT-5.6 Sol",
  );
  const miniRow = new FakeElement(
    "button",
    {
      role: "menuitemradio",
      ...(options.hiddenUnmarkedOtherModel
        ? { "data-hidden": "true" }
        : {
            "aria-checked": solChecked ? "false" : "true",
            "data-state": solChecked ? "unchecked" : "checked",
          }),
    },
    [],
    "GPT-5.6 Sol Mini",
  );
  const modelRows = [solRow, miniRow];
  if (options.duplicateSolRow) {
    modelRows.push(
      new FakeElement(
        "button",
        {
          role: "menuitemradio",
          "aria-checked": "false",
          "data-state": "unchecked",
          ...(options.duplicateSolRow === "hidden" ? { "data-hidden": "true" } : {}),
        },
        [],
        "GPT-5.6 Sol",
      ),
    );
  }
  const modelMenu = new FakeElement(
    "div",
    { id: "sol-model-menu", role: "menu", "data-hidden": "true" },
    modelRows,
  );
  const pollutionMenu = new FakeElement(
    "div",
    { id: "pollution-menu", role: "menu", "data-hidden": "true" },
    [
      new FakeElement(
        "button",
        { role: "menuitemradio", "aria-checked": "true", "data-state": "checked" },
        [],
        "Unrelated",
      ),
    ],
  );
  const duplicateParent = new FakeElement(
    "div",
    {
      id: "intelligence-menu",
      role: "menu",
      "data-hidden": "true",
    },
    [],
  );
  const document = new FakeDocument([
    form,
    parentMenu,
    modelMenu,
    ...(options.fallbackPollution ? [pollutionMenu] : []),
    ...(options.duplicateParentId ? [duplicateParent] : []),
  ]);
  const windowStub = new FakeWindow();
  document.setHitTarget(sendButton);
  editor.setFocusHandler(() => document.setActiveElement(editor));
  document.setActiveElement(editor);

  const closeAllMenus = () => {
    pill.setAttribute("aria-expanded", "false");
    solTrigger.setAttribute("aria-expanded", "false");
    parentMenu.setAttribute("data-hidden", "true");
    modelMenu.setAttribute("data-hidden", "true");
    pollutionMenu.setAttribute("data-hidden", "true");
  };
  let pillRemounted = false;
  const replacePill = (target: FakeElement, expanded: boolean) => {
    const replacement = new FakeElement(
      "button",
      {
        class: "__composer-pill",
        "aria-haspopup": "menu",
        "aria-expanded": String(expanded),
        ...(options.fallbackOwnership ? {} : { "aria-controls": "intelligence-menu" }),
      },
      [],
      "Pro",
    );
    installPillHandler(replacement);
    const index = composer.children.indexOf(target);
    composer.children[index] = replacement;
    replacement.parentElement = composer;
    target.setAttribute("data-connected", "false");
    pill = replacement;
  };
  const installPillHandler = (target: FakeElement) =>
    target.setClickHandler(() => {
      if (target.getAttribute("aria-expanded") === "true") {
        closeAllMenus();
        if (options.remountPillOnClose) replacePill(target, false);
        return;
      }
      target.setAttribute("aria-expanded", "true");
      parentMenu.setAttribute("data-hidden", "false");
      if (options.fallbackPollution) pollutionMenu.setAttribute("data-hidden", "false");
      if (options.remountPillOnOpen && !pillRemounted) {
        pillRemounted = true;
        replacePill(target, true);
      }
    });
  installPillHandler(pill);

  let solTriggerRemounted = false;
  let parentMenuRemounted = false;
  let delayedHoverScheduled = false;
  const installSolTriggerHandler = (target: FakeElement) => {
    const open = () => {
      target.setAttribute("aria-expanded", "true");
      modelMenu.setAttribute("data-hidden", "false");
      if (options.remountSolTriggerOnOpen && !solTriggerRemounted) {
        solTriggerRemounted = true;
        const replacement = new FakeElement(
          "button",
          {
            role: "menuitem",
            "aria-haspopup": "menu",
            "aria-expanded": "true",
            ...(options.fallbackOwnership ? {} : { "aria-controls": "sol-model-menu" }),
          },
          [],
          options.solTriggerText ?? "GPT-5.6 Sol",
        );
        installSolTriggerHandler(replacement);
        const index = parentMenu.children.indexOf(target);
        parentMenu.children[index] = replacement;
        replacement.parentElement = parentMenu;
        target.setAttribute("data-connected", "false");
        solTrigger = replacement;
      }
      if (options.remountParentMenuOnModelOpen && !parentMenuRemounted) {
        parentMenuRemounted = true;
        const oldParent = parentMenu;
        const replacement = new FakeElement(
          "div",
          {
            id: "intelligence-menu",
            role: "menu",
            "data-hidden": "false",
          },
          [proRow, standardRow, solTrigger],
        );
        const index = document.body.children.indexOf(oldParent);
        document.body.children[index] = replacement;
        replacement.parentElement = document.body;
        oldParent.setAttribute("data-connected", "false");
        parentMenu = replacement;
      }
    };
    target.setClickHandler(() => {
      if (!options.solOpensOnDelayedHover) open();
    });
    if (options.solOpensOnDelayedHover) {
      target.setHoverHandler(() => {
        if (delayedHoverScheduled) return;
        delayedHoverScheduled = true;
        windowStub.setTimeout(open, 150);
      });
    }
  };
  installSolTriggerHandler(solTrigger);

  const evaluate = (expression: string): unknown =>
    new Function(
      "document",
      "window",
      "HTMLElement",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLButtonElement",
      "Node",
      "MutationObserver",
      "MouseEvent",
      "KeyboardEvent",
      "EventTarget",
      `return ${expression};`,
    )(
      document,
      windowStub,
      FakeElement,
      FakeInputElement,
      FakeTextAreaElement,
      FakeButtonElement,
      FakeElement,
      FakeMutationObserver,
      FakeMouseEvent,
      FakeKeyboardEvent,
      FakeEventTarget,
    );
  const mint = async () =>
    await evaluate(
      buildGpt56SolProPublicRouteProofExpressionForTest(attachmentToken, composerBindingToken),
    );
  return {
    attachmentToken,
    composer,
    composerBindingToken,
    document,
    editor,
    evaluate,
    mint,
    modelMenu,
    parentMenu,
    pill,
    pollutionMenu,
    proRow,
    sendButton,
    solRow,
    solTrigger,
    form,
    windowStub,
  };
}

async function installPublicRouteDispatchGuard(options: PublicRouteFixtureOptions = {}) {
  const fixture = makePublicRouteFixture(options);
  const minted = await fixture.mint();
  expect(minted).toMatchObject({
    verified: true,
    proofMinted: true,
    modelSignals: ["GPT-5.6 Sol"],
    modeSignals: ["Pro"],
  });
  const guard = buildGpt56SolProFinalDispatchGuard(
    fixture.attachmentToken,
    fixture.composerBindingToken,
    {
      exactSubmission: {
        prompt: options.prompt ?? "exact protected prompt",
        attachments: [],
      },
    },
  );
  const bindingPayloads: string[] = [];
  windowStubSetBinding(fixture.windowStub, guard.verdictBinding!.name, bindingPayloads);
  const installed = fixture.evaluate(guard.expression);
  expect(installed).toMatchObject({ installed: true, status: "armed", reason: null });
  expect(() => guard.assertResult(installed)).not.toThrow();
  return { ...fixture, bindingPayloads, guard, installed };
}

function windowStubSetBinding(
  windowStub: FakeWindow,
  name: string,
  bindingPayloads: string[],
): void {
  windowStub[name] = (payload: string) => bindingPayloads.push(payload);
}

describe("public controlled-submenu protected-route proof", () => {
  test("removes React/Fiber from every authorization expression", () => {
    const probe = buildChatGptProDomProbeExpressionForTest(undefined, "bound-composer");
    const mint = buildGpt56SolProPublicRouteProofExpressionForTest(undefined, "bound-composer");
    const guard = buildGpt56SolProFinalDispatchGuard(undefined, "bound-composer");
    expect(probe).not.toMatch(/reactFiber|composerIntelligencePickerState/i);
    expect(mint).not.toMatch(/reactFiber|composerIntelligencePickerState/i);
    expect(guard.expression).not.toMatch(/reactFiber|composerIntelligencePickerState/i);
  });

  test("mints from unique checked Pro and Sol rows in causally controlled menus", async () => {
    const fixture = makePublicRouteFixture();
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: true,
      proofMinted: true,
      composerBindingVerified: true,
      modelVerified: true,
      modeVerified: true,
      modelSignals: ["GPT-5.6 Sol"],
      modeSignals: ["Pro"],
    });
    expect(fixture.pill.getAttribute("aria-expanded")).toBe("false");
    expect(fixture.parentMenu.hidden).toBe(true);
    expect(fixture.modelMenu.hidden).toBe(true);
    expect(fixture.document.activeElement).toBe(fixture.editor);
  });

  test("latches and blocks Send attempts before the complete guard handoff", async () => {
    const fixture = makePublicRouteFixture({ wrapComposerInForm: true });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: true,
      proofMinted: true,
    });
    const applicationClicks: string[] = [];
    fixture.sendButton.addEventListener("click", () => applicationClicks.push("click"));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const preGuardClick = fixture.windowStub.dispatchDomEvent(
        fixture.document,
        "click",
        fixture.sendButton,
      );
      expect(preGuardClick.defaultPrevented).toBe(true);
    }
    const preGuardSubmit = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "submit",
      fixture.form,
    );
    expect(preGuardSubmit.defaultPrevented).toBe(true);
    expect(applicationClicks).toEqual([]);

    const guard = buildGpt56SolProFinalDispatchGuard(
      fixture.attachmentToken,
      fixture.composerBindingToken,
      {
        exactSubmission: {
          prompt: "exact protected prompt",
          attachments: [],
        },
      },
    );
    const bindingPayloads: string[] = [];
    windowStubSetBinding(fixture.windowStub, guard.verdictBinding!.name, bindingPayloads);
    expect(fixture.evaluate(guard.expression)).toMatchObject({
      installed: false,
      status: "blocked",
      reason: "public-route-proof-dispatch-before-guard",
    });
    expect(bindingPayloads).toHaveLength(0);
  });

  test("keeps a split pre-guard pointer gesture blocked after handoff refusal", async () => {
    const fixture = makePublicRouteFixture();
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: true,
      proofMinted: true,
    });
    const applicationClicks: string[] = [];
    fixture.sendButton.addEventListener("click", () => applicationClicks.push("click"));
    const pointerDown = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "pointerdown",
      fixture.sendButton,
    );
    expect(pointerDown.defaultPrevented).toBe(true);

    const guard = buildGpt56SolProFinalDispatchGuard(
      fixture.attachmentToken,
      fixture.composerBindingToken,
      {
        exactSubmission: {
          prompt: "exact protected prompt",
          attachments: [],
        },
      },
    );
    const bindingPayloads: string[] = [];
    windowStubSetBinding(fixture.windowStub, guard.verdictBinding!.name, bindingPayloads);
    expect(fixture.evaluate(guard.expression)).toMatchObject({
      installed: false,
      status: "blocked",
      reason: "public-route-proof-dispatch-before-guard",
    });

    for (const type of ["mouseup", "click"]) {
      const event = fixture.windowStub.dispatchDomEvent(fixture.document, type, fixture.sendButton);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(applicationClicks).toEqual([]);
  });

  test("blocks an ancestor-form submit while an armed click guard awaits dispatch", async () => {
    const fixture = await installPublicRouteDispatchGuard({ wrapComposerInForm: true });
    const applicationSubmits: string[] = [];
    fixture.form.addEventListener("submit", () => applicationSubmits.push("submit"));

    const submit = fixture.windowStub.dispatchDomEvent(fixture.document, "submit", fixture.form);
    expect(submit.defaultPrevented).toBe(true);
    expect(applicationSubmits).toEqual([]);
    expect(fixture.evaluate(fixture.guard.immediatelyBeforeDispatchExpression!)).toMatchObject({
      status: "blocked",
      reason: "public-route-proof-alternate-submit",
    });
  });

  test.each([
    { remountPillOnOpen: true },
    { remountSolTriggerOnOpen: true },
    { remountParentMenuOnModelOpen: true },
  ])(
    "reacquires controlled public route nodes after a normal open-time remount: %o",
    async (options) => {
      const fixture = makePublicRouteFixture(options);
      await expect(fixture.mint()).resolves.toMatchObject({
        verified: true,
        proofMinted: true,
      });
    },
  );

  test("waits for a Sol submenu that opens only after delayed hover intent", async () => {
    const fixture = makePublicRouteFixture({ solOpensOnDelayedHover: true });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: true,
      proofMinted: true,
      modelVerified: true,
      modeVerified: true,
    });
  });

  test("ignores an unrelated composer menu pill", async () => {
    const fixture = makePublicRouteFixture({ additionalMenuPill: true });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: true,
      proofMinted: true,
    });
  });

  test("rejects a second exact Pro composer pill", async () => {
    const fixture = makePublicRouteFixture({ additionalProPill: true });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: false,
      proofMinted: false,
      reason: "exact-dispatch-composer-unavailable",
    });
  });

  test("retries and refuses when the proved pill remounts while the menus close", async () => {
    const fixture = makePublicRouteFixture({ remountPillOnClose: true });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: false,
      proofMinted: false,
      reason: "dispatch-composer-remounted-during-proof",
    });
  });

  test("ignores marker state on hidden non-target rows while retaining exact-label ambiguity vetoes", async () => {
    const fixture = makePublicRouteFixture({ hiddenUnmarkedOtherModel: true });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: true,
      proofMinted: true,
    });
  });

  test("an unchecked availability trigger cannot stand in for the checked model submenu row", async () => {
    const fixture = makePublicRouteFixture({ modelCheckedLabel: "GPT-5.6 Sol Mini" });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: false,
      proofMinted: false,
      modelVerified: false,
    });
  });

  test.each(["visible", "hidden"] as const)(
    "rejects a %s duplicate exact Sol row in the owned submenu",
    async (duplicateSolRow) => {
      const fixture = makePublicRouteFixture({ duplicateSolRow });
      await expect(fixture.mint()).resolves.toMatchObject({
        verified: false,
        proofMinted: false,
      });
    },
  );

  test.each([
    { proStateContradiction: true },
    { modelStateContradiction: true },
    { proMarkerMissing: true },
    { modelMarkerMissing: true },
    { proOptionalMarkerConflict: true },
    { modelOptionalMarkerConflict: true },
    { proChecked: false },
  ] satisfies PublicRouteFixtureOptions[])(
    "fails closed on contradictory or wrong checked-state evidence: %o",
    async (options) => {
      const fixture = makePublicRouteFixture(options);
      await expect(fixture.mint()).resolves.toMatchObject({
        verified: false,
        proofMinted: false,
      });
    },
  );

  test.each([
    { solRowText: "GPT-5.6 Sol Pro" },
    { solRowText: "gpt-5.6 sol" },
    { solTriggerText: "GPT-5.6 Sol Mini" },
    { proRowText: "Pro Max" },
  ] satisfies PublicRouteFixtureOptions[])(
    "rejects route label lookalikes: %o",
    async (options) => {
      const fixture = makePublicRouteFixture(options);
      await expect(fixture.mint()).resolves.toMatchObject({
        verified: false,
        proofMinted: false,
      });
    },
  );

  test("accepts unique newly-visible causal owners when aria-controls is absent", async () => {
    const fixture = makePublicRouteFixture({ fallbackOwnership: true });
    await expect(fixture.mint()).resolves.toMatchObject({ verified: true, proofMinted: true });
  });

  test("rejects newly-visible fallback ownership when a second menu appears", async () => {
    const fixture = makePublicRouteFixture({
      fallbackOwnership: true,
      fallbackPollution: true,
    });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: false,
      proofMinted: false,
    });
  });

  test("rejects duplicate aria-controls ids instead of accepting getElementById's first match", async () => {
    const fixture = makePublicRouteFixture({ duplicateParentId: true });
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: false,
      proofMinted: false,
    });
  });

  test("keeps a unique token-bound composer scoped when another editor is visible", async () => {
    const fixture = makePublicRouteFixture();
    const foreignComposer = new FakeElement("div", { "data-testid": "unified-composer" }, [
      new FakeElement("div", { contenteditable: "true", role: "textbox" }),
    ]);
    foreignComposer.parentElement = fixture.document.body;
    fixture.document.body.children.push(foreignComposer);
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: true,
      proofMinted: true,
    });
  });

  test("the trusted button capture consumes the proof before application click handlers", async () => {
    const fixture = await installPublicRouteDispatchGuard();
    const applicationObservations: string[] = [];
    fixture.sendButton.addEventListener("click", () => {
      const status = fixture.evaluate(fixture.guard.immediatelyBeforeDispatchExpression!);
      expect(status).toMatchObject({ status: "allowed", routeProofStatus: "consumed" });
      applicationObservations.push("click");
    });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const event = fixture.windowStub.dispatchDomEvent(fixture.document, type, fixture.sendButton);
      expect(event.defaultPrevented).toBe(false);
    }
    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(click.defaultPrevented).toBe(false);
    expect(applicationObservations).toEqual(["click"]);
    expect(fixture.bindingPayloads).toHaveLength(1);
    expect(
      fixture.guard.verdictBinding?.parsePayload(fixture.bindingPayloads[0] ?? ""),
    ).toMatchObject({ status: "allowed", lastEvent: "click" });
    const verdict = fixture.evaluate(fixture.guard.afterDispatchExpression!);
    expect(verdict).toMatchObject({ status: "allowed", lastEvent: "click" });
    expect(() => fixture.guard.assertAfterDispatchResult?.(verdict)).not.toThrow();
  });

  test.each([
    { name: "middle-button", options: { button: 1 } },
    { name: "touch-pointer", options: { pointerType: "touch" } },
  ])("a $name click cannot authorize protected dispatch", async ({ options }) => {
    const fixture = await installPublicRouteDispatchGuard();
    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
      options,
    );
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.bindingPayloads).toHaveLength(1);
    expect(
      fixture.guard.verdictBinding?.parsePayload(fixture.bindingPayloads[0] ?? ""),
    ).toMatchObject({ status: "blocked", reason: "non-primary-dispatch-event" });
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "blocked",
      reason: "non-primary-dispatch-event",
    });
  });

  test("does not burn the proof on cosmetic Send hover state or tooltip children", async () => {
    const fixture = await installPublicRouteDispatchGuard();
    fixture.sendButton.setAttribute("data-state", "hover");
    const tooltip = new FakeElement("span", { role: "tooltip" }, [], "Send");
    tooltip.parentElement = fixture.sendButton;
    fixture.sendButton.children.push(tooltip);
    FakeMutationObserver.notify({
      type: "childList",
      target: fixture.sendButton,
      addedNodes: [tooltip],
      removedNodes: [],
    });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const event = fixture.windowStub.dispatchDomEvent(fixture.document, type, fixture.sendButton);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "allowed",
      lastEvent: "click",
    });
  });

  test.each([
    {
      name: "prompt edit",
      mutate: (fixture: Awaited<ReturnType<typeof installPublicRouteDispatchGuard>>) =>
        fixture.editor.setText("changed prompt"),
    },
    {
      name: "pill route mutation",
      mutate: (fixture: Awaited<ReturnType<typeof installPublicRouteDispatchGuard>>) =>
        fixture.pill.setText("Standard"),
    },
    {
      name: "menu reopening",
      mutate: (fixture: Awaited<ReturnType<typeof installPublicRouteDispatchGuard>>) =>
        fixture.pill.click(),
    },
    {
      name: "composer binding replacement",
      mutate: (fixture: Awaited<ReturnType<typeof installPublicRouteDispatchGuard>>) =>
        fixture.composer.setAttribute("data-oracle-send-composer-binding", "replacement"),
    },
    {
      name: "composer remount or detachment",
      mutate: (fixture: Awaited<ReturnType<typeof installPublicRouteDispatchGuard>>) =>
        fixture.composer.setAttribute("data-connected", "false"),
    },
    {
      name: "navigation",
      mutate: (fixture: Awaited<ReturnType<typeof installPublicRouteDispatchGuard>>) => {
        fixture.windowStub.location.href = "https://chatgpt.com/c/replaced";
      },
    },
    {
      name: "relevant key event",
      mutate: (fixture: Awaited<ReturnType<typeof installPublicRouteDispatchGuard>>) => {
        fixture.windowStub.dispatchDomEvent(fixture.document, "keydown", fixture.editor);
      },
    },
  ])("burns on $name before the trusted click", async ({ mutate }) => {
    const fixture = await installPublicRouteDispatchGuard();
    mutate(fixture);
    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.bindingPayloads).toHaveLength(1);
    const verdict = fixture.evaluate(fixture.guard.afterDispatchExpression!);
    expect(verdict).toMatchObject({ status: "blocked" });
    expect(fixture.guard.isDispatchDefinitelyBlocked?.(verdict)).toBe(true);
  });

  test("binds focus to the exact editor instead of borrowing a stale sibling", async () => {
    const fixture = await installPublicRouteDispatchGuard();
    const staleSibling = new FakeElement(
      "div",
      {
        id: "prompt-textarea",
        contenteditable: "true",
        role: "textbox",
      },
      [],
      "exact protected prompt",
    );
    staleSibling.parentElement = fixture.document.body;
    fixture.document.body.children.unshift(staleSibling);
    fixture.document.setActiveElement(staleSibling);

    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "blocked",
      reason: "exact-editor-focus-changed",
    });
  });

  test("rejects a trusted click when hit testing no longer resolves to the bound Send", async () => {
    const fixture = await installPublicRouteDispatchGuard();
    fixture.document.setHitTarget(new FakeElement("div"));

    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "blocked",
      reason: "trusted-event-target-changed",
    });
  });

  test("a replacement Send button cannot inherit the old binding token", async () => {
    const fixture = await installPublicRouteDispatchGuard();
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

  test("moving the same bound nodes under a replacement composer is blocked", async () => {
    const fixture = await installPublicRouteDispatchGuard();
    for (const node of [fixture.editor, fixture.pill, fixture.sendButton]) {
      const index = fixture.composer.children.indexOf(node);
      fixture.composer.children.splice(index, 1);
    }
    const replacementComposer = new FakeElement(
      "div",
      {
        "data-testid": "unified-composer",
        "data-oracle-send-composer-binding": fixture.composerBindingToken,
      },
      [fixture.editor, fixture.pill, fixture.sendButton],
    );
    const composerIndex = fixture.document.body.children.indexOf(fixture.composer);
    fixture.document.body.children.splice(composerIndex, 1, replacementComposer);
    replacementComposer.parentElement = fixture.document.body;
    fixture.composer.parentElement = null;
    fixture.document.setActiveElement(fixture.editor);
    fixture.document.setHitTarget(fixture.sendButton);

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

  test("a blocked precursor remains latched after the visible route label is repaired", async () => {
    const fixture = await installPublicRouteDispatchGuard();
    fixture.pill.setText("Standard");
    const precursor = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "mousedown",
      fixture.sendButton,
    );
    expect(precursor.defaultPrevented).toBe(true);
    expect(fixture.bindingPayloads).toHaveLength(1);
    const blockedPrecursor = fixture.guard.verdictBinding?.parsePayload(
      fixture.bindingPayloads[0] ?? "",
    ) as { status?: unknown; reason?: unknown } | undefined;
    expect(blockedPrecursor).toMatchObject({ status: "blocked" });
    fixture.pill.setText("Pro");

    const click = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(click.defaultPrevented).toBe(true);
    expect(fixture.bindingPayloads).toHaveLength(1);
    expect(fixture.evaluate(fixture.guard.afterDispatchExpression!)).toMatchObject({
      status: "blocked",
      reason: blockedPrecursor?.reason,
    });
  });

  test("a proof cannot be replayed after a blocked untrusted attempt", async () => {
    const fixture = await installPublicRouteDispatchGuard();
    const untrusted = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
      { isTrusted: false },
    );
    expect(untrusted.defaultPrevented).toBe(true);
    const firstVerdict = fixture.evaluate(fixture.guard.afterDispatchExpression!);
    expect(firstVerdict).toMatchObject({ status: "blocked", reason: "untrusted-dispatch-event" });

    const replayGuard = buildGpt56SolProFinalDispatchGuard(undefined, fixture.composerBindingToken);
    const replayPayloads: string[] = [];
    windowStubSetBinding(fixture.windowStub, replayGuard.verdictBinding!.name, replayPayloads);
    const replayInstall = fixture.evaluate(replayGuard.expression);
    expect(replayInstall).toMatchObject({ installed: false, status: "blocked" });
  });

  test("binds the attachment-marked composer identity through trusted dispatch", async () => {
    const fixture = await installPublicRouteDispatchGuard({
      attachmentToken: "exact-attachment-composer-1",
    });
    fixture.composer.setAttribute("data-oracle-attachment-binding", "replacement");
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

  test("an expired guard blocks the complete first late click and then releases its hooks", async () => {
    const fixture = await installPublicRouteDispatchGuard();
    expect(fixture.windowStub.listenerCount("click")).toBe(2);
    expect(fixture.document.listenerCount("click")).toBe(1);

    fixture.windowStub.expireGuard();
    const status = fixture.evaluate(fixture.guard.immediatelyBeforeDispatchExpression!);
    expect(status).toMatchObject({ status: "blocked", reason: "dispatch-guard-expired" });
    expect(fixture.windowStub.listenerCount("click")).toBe(1);
    expect(fixture.document.listenerCount("click")).toBe(1);

    const lateClick = fixture.windowStub.dispatchDomEvent(
      fixture.document,
      "click",
      fixture.sendButton,
    );
    expect(lateClick.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(fixture.windowStub.listenerCount("click")).toBe(0);
    expect(fixture.document.listenerCount("click")).toBe(0);
    expect(fixture.sendButton.listenerCount("click")).toBe(0);
    expect(fixture.sendButton.getAttribute("data-oracle-send-binding")).toBeNull();
    expect(fixture.composer.getAttribute("data-oracle-send-composer-binding")).toBeNull();
    expect(fixture.editor.getAttribute("data-oracle-send-editor-binding")).toBeNull();
  });

  test("an expired unguarded proof releases its registry-held DOM references", async () => {
    const fixture = makePublicRouteFixture();
    await expect(fixture.mint()).resolves.toMatchObject({
      verified: true,
      proofMinted: true,
    });
    const registryKey = "__oracleProtectedPublicRouteProofsV1";
    const registry = fixture.windowStub[registryKey] as Map<string, unknown>;
    expect(registry).toBeInstanceOf(Map);
    expect(registry.size).toBe(1);

    fixture.windowStub.expireGuard();
    await Promise.resolve();
    expect(registry.size).toBe(0);
    expect(fixture.windowStub[registryKey]).toBeUndefined();
  });
});
