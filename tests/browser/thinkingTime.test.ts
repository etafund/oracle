import { describe, expect, it } from "vitest";
import {
  buildThinkingTimeExpressionForTest,
  ensureThinkingTime,
  inferThinkingTargetModelKindForTest,
} from "../../src/browser/actions/thinkingTime.js";
import { loadBrowserFixture } from "../_helpers/browserFixture.js";

async function evaluateGpt56SolProIntelligenceMenu(options: {
  proChecked?: boolean;
  solChecked?: boolean;
  includePro?: boolean;
  includeSolTrigger?: boolean;
  includeSolRow?: boolean;
  solTriggerLabel?: string;
  solRowLabel?: string;
  useControlledParent?: boolean;
  useControlledModel?: boolean;
  duplicateParentId?: boolean;
  duplicateModelId?: boolean;
  duplicateVisiblePro?: boolean;
  duplicateHiddenPro?: boolean;
  duplicateVisibleSolTrigger?: boolean;
  duplicateHiddenSolTrigger?: boolean;
  duplicateVisibleSolRow?: boolean;
  duplicateHiddenSolRow?: boolean;
  effortMarkerConflict?: boolean;
  modelMarkerConflict?: boolean;
  effortMarkerMissing?: boolean;
  modelMarkerMissing?: boolean;
  effortOptionalMarkerConflict?: boolean;
  modelOptionalMarkerConflict?: boolean;
  extraEffortChecked?: boolean;
  extraModelChecked?: boolean;
  foreignMenuOnly?: boolean;
  causalExtraParentMenu?: boolean;
  causalExtraModelMenu?: boolean;
  uncheckProOnSolSwitch?: boolean;
  disconnectParentWhenModelOpens?: boolean;
  disconnectModelWhenOpened?: boolean;
  delayedControlledParentOwner?: boolean;
  delayedControlledModelOwner?: boolean;
  modelOpensOnHover?: boolean;
  remountParentMenuOnProSwitch?: boolean;
  remountModelMenuOnSolSwitch?: boolean;
  additionalComposerPill?: boolean;
  additionalProPill?: boolean;
  currentPillLabel?: string;
  fiberNoise?: boolean;
}): Promise<unknown> {
  class FakeEventTarget {
    dispatchEvent(_event: unknown): boolean {
      return true;
    }
  }

  class FakeMouseEvent {
    constructor(
      readonly type: string,
      readonly init?: unknown,
    ) {}
  }

  class FakeElement extends FakeEventTarget {
    public parentElement: FakeElement | null = null;
    public readonly tagName: string;
    public isConnected = true;
    private visible: boolean;
    private hiddenVisibilityChecks = 0;

    constructor(
      public textContent: string,
      private readonly attributes: Record<string, string> = {},
      private readonly children: FakeElement[] = [],
      private readonly onDispatch?: () => void,
      visible = true,
      private readonly onHover?: () => void,
    ) {
      super();
      this.tagName = attributes.tagName ?? "DIV";
      this.visible = visible;
      for (const child of children) child.parentElement = this;
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

    setVisible(visible: boolean): void {
      this.visible = visible;
    }

    delayVisibility(checks: number): void {
      this.hiddenVisibilityChecks = Math.max(0, checks);
    }

    replaceChild(target: FakeElement, replacement: FakeElement): void {
      const index = this.children.indexOf(target);
      if (index < 0) throw new Error("fixture child not found");
      this.children[index] = replacement;
      replacement.parentElement = this;
      target.parentElement = null;
    }

    querySelector(selector: string): FakeElement | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
      const descendants = this.children.flatMap((child) => [
        child,
        ...child.querySelectorAll(selector),
      ]);
      return descendants.filter((child) => child.matches(selector));
    }

    matches(selector: string): boolean {
      const role = this.attributes.role;
      const testId = this.attributes["data-testid"] ?? "";
      if (selector === "[id]") return this.attributes.id !== undefined;
      if (
        selector.includes("button.__composer-pill") &&
        this.tagName === "BUTTON" &&
        this.attributes.class?.split(/\s+/).includes("__composer-pill")
      ) {
        return true;
      }
      if (selector.includes('[role="menuitemradio"]') && role === "menuitemradio") return true;
      if (selector.includes('[role="menuitem"]') && role === "menuitem") return true;
      if (selector.includes('[role="option"]') && role === "option") return true;
      if (selector.includes('[role="radio"]') && role === "radio") return true;
      if (selector.includes('[role="menu"]') && role === "menu") return true;
      if (
        selector.includes("data-radix-collection-root") &&
        this.attributes["data-radix-collection-root"] !== undefined
      ) {
        return true;
      }
      if (
        selector.includes("composer-intelligence-picker-content") &&
        testId === "composer-intelligence-picker-content"
      ) {
        return true;
      }
      if (
        selector.includes("model-switcher-dropdown-button") &&
        testId === "model-switcher-dropdown-button"
      ) {
        return true;
      }
      if (
        (selector.includes("prompt-textarea") ||
          selector.includes("contenteditable") ||
          selector.includes("ProseMirror")) &&
        (this.attributes.id === "prompt-textarea" || this.attributes.contenteditable === "true")
      ) {
        return true;
      }
      if (selector.includes('[data-testid*="composer"]') && testId.includes("composer"))
        return true;
      if (selector.includes("[data-testid]") && testId) return true;
      if (selector.includes("button") && this.tagName === "BUTTON") return true;
      return false;
    }

    private isEffectivelyVisible(): boolean {
      if (this.visible && this.hiddenVisibilityChecks > 0) {
        this.hiddenVisibilityChecks -= 1;
        return false;
      }
      return (
        this.visible && this.isConnected && (this.parentElement?.isEffectivelyVisible() ?? true)
      );
    }

    getBoundingClientRect(): { width: number; height: number } {
      return this.isEffectivelyVisible() ? { width: 120, height: 36 } : { width: 0, height: 0 };
    }

    contains(node: unknown): boolean {
      return node === this || this.children.some((child) => child.contains(node));
    }

    closest(selector: string): FakeElement | null {
      if (
        selector.includes('[data-testid*="composer"]') &&
        this.attributes["data-testid"]?.includes("composer")
      ) {
        return this;
      }
      if (selector === "form" && this.tagName.toLowerCase() === "form") return this;
      return this.parentElement?.closest(selector) ?? null;
    }

    override dispatchEvent(event: unknown): boolean {
      const type = (event as { type?: string })?.type;
      if (type === "click") this.onDispatch?.();
      if (type === "pointerover") this.onHover?.();
      return super.dispatchEvent(event);
    }
  }

  const proChecked = options.proChecked ?? true;
  const solChecked = options.solChecked ?? true;
  const useControlledParent = options.useControlledParent ?? true;
  const useControlledModel = options.useControlledModel ?? true;
  const parentId = "oracle-intelligence-menu";
  const modelId = "oracle-sol-submenu";
  const setChecked = (row: FakeElement, checked: boolean): void => {
    row.setAttribute("aria-checked", String(checked));
    row.setAttribute("data-state", checked ? "checked" : "unchecked");
  };

  let parentMenu: FakeElement;
  let modelMenu: FakeElement;
  let modelButton: FakeElement;
  let solTrigger: FakeElement;
  let extraParentMenu: FakeElement | null = null;
  let extraModelMenu: FakeElement | null = null;

  let remountParentSelection = (): void => {};
  let remountModelSelection = (): void => {};
  let standardMode = new FakeElement("Standard", {
    role: "menuitemradio",
    "aria-checked": String(!proChecked || options.extraEffortChecked === true),
    "data-state": !proChecked || options.extraEffortChecked ? "checked" : "unchecked",
  });
  let proMode = new FakeElement(
    "Pro",
    {
      role: "menuitemradio",
      "aria-checked": String(proChecked),
      ...(options.effortMarkerMissing
        ? {}
        : {
            "data-state": options.effortMarkerConflict
              ? proChecked
                ? "unchecked"
                : "checked"
              : proChecked
                ? "checked"
                : "unchecked",
          }),
      ...(options.effortOptionalMarkerConflict ? { "aria-selected": String(!proChecked) } : {}),
    },
    [],
    () => {
      setChecked(standardMode, false);
      setChecked(proMode, true);
      modelButton.textContent = "Pro";
      parentMenu.setVisible(false);
      modelMenu.setVisible(false);
      modelButton.setAttribute("aria-expanded", "false");
      solTrigger.setAttribute("aria-expanded", "false");
      if (options.remountParentMenuOnProSwitch) remountParentSelection();
    },
  );

  let oldModel = new FakeElement("GPT-5.5", {
    role: "menuitemradio",
    "aria-checked": String(!solChecked || options.extraModelChecked === true),
    "data-state": !solChecked || options.extraModelChecked ? "checked" : "unchecked",
  });
  let solModel = new FakeElement(
    options.solRowLabel ?? "GPT-5.6 Sol",
    {
      role: "menuitemradio",
      "aria-checked": String(solChecked),
      ...(options.modelMarkerMissing
        ? {}
        : {
            "data-state": options.modelMarkerConflict
              ? solChecked
                ? "unchecked"
                : "checked"
              : solChecked
                ? "checked"
                : "unchecked",
          }),
      ...(options.modelOptionalMarkerConflict ? { "data-selected": String(!solChecked) } : {}),
    },
    [],
    () => {
      setChecked(oldModel, false);
      setChecked(solModel, true);
      if (options.uncheckProOnSolSwitch) {
        setChecked(proMode, false);
        setChecked(standardMode, true);
      }
      parentMenu.setVisible(false);
      modelMenu.setVisible(false);
      modelButton.setAttribute("aria-expanded", "false");
      solTrigger.setAttribute("aria-expanded", "false");
      if (options.remountModelMenuOnSolSwitch) remountModelSelection();
    },
  );

  const modelRows: FakeElement[] = [
    oldModel,
    ...(options.includeSolRow === false ? [] : [solModel]),
  ];
  if (options.duplicateVisibleSolRow) {
    modelRows.push(
      new FakeElement("GPT-5.6 Sol", {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      }),
    );
  }
  if (options.duplicateHiddenSolRow) {
    modelRows.push(
      new FakeElement(
        "GPT-5.6 Sol",
        { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
        [],
        undefined,
        false,
      ),
    );
  }
  modelMenu = new FakeElement(
    "Models GPT-5.5 GPT-5.6 Sol",
    { role: "menu", ...(useControlledModel ? { id: modelId } : {}) },
    modelRows,
    undefined,
    false,
  );

  const setModelMenuOpen = (opening: boolean): void => {
    solTrigger.setAttribute("aria-expanded", String(opening));
    modelMenu.setVisible(opening);
    if (opening && options.delayedControlledModelOwner) modelMenu.delayVisibility(3);
    extraModelMenu?.setVisible(opening);
    if (opening && options.disconnectParentWhenModelOpens) parentMenu.isConnected = false;
    if (opening && options.disconnectModelWhenOpened) modelMenu.isConnected = false;
  };

  solTrigger = new FakeElement(
    options.solTriggerLabel ?? "GPT-5.6 Sol",
    {
      tagName: "BUTTON",
      role: "menuitem",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      ...(useControlledModel ? { "aria-controls": modelId } : {}),
    },
    [],
    options.modelOpensOnHover
      ? undefined
      : () => setModelMenuOpen(solTrigger.getAttribute("aria-expanded") !== "true"),
    true,
    options.modelOpensOnHover ? () => setModelMenuOpen(true) : undefined,
  );

  const parentRows: FakeElement[] = [
    standardMode,
    ...(options.includePro === false ? [] : [proMode]),
    ...(options.includeSolTrigger === false ? [] : [solTrigger]),
  ];
  if (options.duplicateVisiblePro) {
    parentRows.push(
      new FakeElement("Pro", {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      }),
    );
  }
  if (options.duplicateHiddenPro) {
    parentRows.push(
      new FakeElement(
        "Pro",
        { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
        [],
        undefined,
        false,
      ),
    );
  }
  if (options.duplicateVisibleSolTrigger) {
    parentRows.push(
      new FakeElement("GPT-5.6 Sol", {
        tagName: "BUTTON",
        role: "menuitem",
        "aria-haspopup": "menu",
      }),
    );
  }
  if (options.duplicateHiddenSolTrigger) {
    parentRows.push(
      new FakeElement(
        "GPT-5.6 Sol",
        { tagName: "BUTTON", role: "menuitem", "aria-haspopup": "menu" },
        [],
        undefined,
        false,
      ),
    );
  }
  const intelligenceOwner = new FakeElement(
    "Intelligence Standard Pro GPT-5.6 Sol",
    { role: "group", "data-testid": "composer-intelligence-picker-content" },
    parentRows,
  );
  parentMenu = new FakeElement(
    "Intelligence Standard Pro GPT-5.6 Sol",
    { role: "menu", ...(useControlledParent ? { id: parentId } : {}) },
    [intelligenceOwner],
    undefined,
    false,
  );

  modelButton = new FakeElement(
    options.currentPillLabel ?? (proChecked ? "Pro" : "Standard"),
    {
      tagName: "BUTTON",
      class: "__composer-pill",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      ...(useControlledParent ? { "aria-controls": parentId } : {}),
    },
    [],
    () => {
      const opening = modelButton.getAttribute("aria-expanded") !== "true";
      modelButton.setAttribute("aria-expanded", String(opening));
      parentMenu.setVisible(opening && !options.foreignMenuOnly);
      if (opening && options.delayedControlledParentOwner) parentMenu.delayVisibility(3);
      modelMenu.setVisible(false);
      solTrigger.setAttribute("aria-expanded", "false");
      extraParentMenu?.setVisible(opening);
    },
  );
  const prompt = new FakeElement("", {
    tagName: "DIV",
    id: "prompt-textarea",
    contenteditable: "true",
  });
  const composer = new FakeElement("", { tagName: "FORM", "data-testid": "composer-root" }, [
    prompt,
    modelButton,
    ...(options.additionalComposerPill || options.additionalProPill
      ? [
          new FakeElement(options.additionalProPill ? "Pro" : "Canvas", {
            tagName: "BUTTON",
            class: "__composer-pill",
            "aria-haspopup": "menu",
          }),
        ]
      : []),
  ]);

  const foreignOwner = new FakeElement(
    "Intelligence Standard Pro GPT-5.6 Sol",
    { role: "group", "data-testid": "composer-intelligence-picker-content" },
    [
      new FakeElement("Pro", {
        role: "menuitemradio",
        "aria-checked": "true",
        "data-state": "checked",
      }),
      new FakeElement("GPT-5.6 Sol", {
        tagName: "BUTTON",
        role: "menuitem",
        "aria-haspopup": "menu",
      }),
    ],
  );
  const foreignMenu = new FakeElement(
    "Foreign Intelligence Pro GPT-5.6 Sol",
    { role: "menu" },
    [foreignOwner],
    undefined,
    options.foreignMenuOnly === true,
  );
  if (options.causalExtraParentMenu) {
    extraParentMenu = new FakeElement("Unrelated menu", { role: "menu" }, [], undefined, false);
  }
  if (options.causalExtraModelMenu) {
    extraModelMenu = new FakeElement("Unrelated submenu", { role: "menu" }, [], undefined, false);
  }
  const duplicateIdNodes = [
    ...(options.duplicateParentId
      ? [
          new FakeElement(
            "duplicate parent id",
            { role: "menu", id: parentId },
            [],
            undefined,
            false,
          ),
        ]
      : []),
    ...(options.duplicateModelId
      ? [new FakeElement("duplicate model id", { role: "menu", id: modelId }, [], undefined, false)]
      : []),
  ];
  if (options.fiberNoise) {
    (modelButton as unknown as Record<string, unknown>)["__reactFiber$oracle"] = {
      memoizedProps: {
        children: Array.from({ length: 300 }, (_, index) => ({
          composerIntelligencePickerState: {
            selectedVersionEntry: { displayTextForIntelligence: `wrong-${index}` },
          },
        })),
      },
    };
  }

  const body = new FakeElement("", { tagName: "BODY" }, [
    composer,
    parentMenu,
    modelMenu,
    foreignMenu,
    ...(extraParentMenu ? [extraParentMenu] : []),
    ...(extraModelMenu ? [extraModelMenu] : []),
    ...duplicateIdNodes,
  ]);
  remountParentSelection = () => {
    const oldParent = parentMenu;
    standardMode = new FakeElement("Standard", {
      role: "menuitemradio",
      "aria-checked": "false",
      "data-state": "unchecked",
    });
    proMode = new FakeElement("Pro", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const replacementOwner = new FakeElement(
      "Intelligence Standard Pro GPT-5.6 Sol",
      { role: "group", "data-testid": "composer-intelligence-picker-content" },
      [standardMode, proMode, solTrigger],
    );
    parentMenu = new FakeElement(
      "Intelligence Standard Pro GPT-5.6 Sol",
      { role: "menu", ...(useControlledParent ? { id: parentId } : {}) },
      [replacementOwner],
      undefined,
      false,
    );
    body.replaceChild(oldParent, parentMenu);
    oldParent.isConnected = false;
  };
  remountModelSelection = () => {
    const oldMenu = modelMenu;
    oldModel = new FakeElement("GPT-5.5", {
      role: "menuitemradio",
      "aria-checked": "false",
      "data-state": "unchecked",
    });
    solModel = new FakeElement(options.solRowLabel ?? "GPT-5.6 Sol", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    modelMenu = new FakeElement(
      "Models GPT-5.5 GPT-5.6 Sol",
      { role: "menu", ...(useControlledModel ? { id: modelId } : {}) },
      [oldModel, solModel],
      undefined,
      false,
    );
    body.replaceChild(oldMenu, modelMenu);
    oldMenu.isConnected = false;
  };
  const documentStub = {
    body,
    activeElement: prompt,
    getElementById: (id: string) =>
      body.querySelectorAll("[id]").find((node) => node.getAttribute("id") === id) ?? null,
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    dispatchEvent: () => true,
  };
  let now = 0;
  const expression = buildThinkingTimeExpressionForTest("extended", "GPT-5.6 Sol");
  const evaluate = new Function(
    "document",
    "performance",
    "setTimeout",
    "window",
    "EventTarget",
    "PointerEvent",
    "MouseEvent",
    "HTMLElement",
    `return ${expression};`,
  ) as (...args: unknown[]) => unknown;
  return await Promise.resolve(
    evaluate(
      documentStub,
      { now: () => (now += 100) },
      (handler: () => void) => handler(),
      { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
      FakeEventTarget,
      FakeMouseEvent,
      FakeMouseEvent,
      FakeElement,
    ),
  );
}

describe("browser thinking-time selection expression", () => {
  it("captures the live unselected Sol availability trigger plus checked bare Pro owner shape", async () => {
    const fixture = await loadBrowserFixture("chatgpt", "gpt-5-6-sol-pro");
    const model = fixture.elements.find((element) => element.role === "chatgpt-model-trigger");
    const mode = fixture.elements.find((element) => element.role === "chatgpt-intelligence-option");
    expect(fixture.html).toContain(
      'role="group" data-testid="composer-intelligence-picker-content"',
    );
    expect(model).toMatchObject({ text: "GPT-5.6 Sol", selected: false });
    expect(model?.attrs["aria-haspopup"]).toBe("menu");
    expect(mode).toMatchObject({ text: "Pro", selected: true });
  });

  it("uses centralized menu selectors and normalized matching", () => {
    const expression = buildThinkingTimeExpressionForTest();
    expect(expression).toContain("const MENU_CONTAINER_SELECTOR");
    expect(expression).toContain("const MENU_ITEM_SELECTOR");
    expect(expression).toContain('role=\\"menu\\"');
    expect(expression).toContain("data-radix-collection-root");
    expect(expression).toContain('role=\\"menuitem\\"');
    expect(expression).toContain('role=\\"menuitemradio\\"');
    expect(expression).toContain("normalize");
    expect(expression).toContain("extended");
    expect(expression).toContain("standard");
  });

  it("targets the requested thinking time level", () => {
    const levels = ["light", "standard", "extended", "heavy"] as const;
    for (const level of levels) {
      const expression = buildThinkingTimeExpressionForTest(level);
      expect(expression).toContain("const TARGET_LEVEL");
      expect(expression).toContain(`"${level}"`);
    }
  });

  it("supports ChatGPT's model-menu thinking effort control", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("MODEL_BUTTON_SELECTOR");
    expect(expression).toContain("data-model-picker-thinking-effort-action");
    expect(expression).toContain("data-model-picker-thinking-effort-row");
    expect(expression).toContain("aria-controls");
    expect(expression).toContain("LEVEL_TOKENS");
    expect(expression).toContain("return selectAndVerify(trailing");
  });

  it("maps ChatGPT's new Intelligence labels onto existing thinking levels", () => {
    expect(buildThinkingTimeExpressionForTest("light")).toContain("light: ['light', 'instant'");
    expect(buildThinkingTimeExpressionForTest("standard")).toContain(
      "standard: ['standard', 'medium'",
    );
    expect(buildThinkingTimeExpressionForTest("extended")).toContain(
      "extended: ['extended', 'high'",
    );
    expect(buildThinkingTimeExpressionForTest("heavy")).toContain("heavy: ['heavy', 'extra high'");
  });

  it("accepts standard selected-state markers when verifying effort", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("aria-selected");
    expect(expression).toContain("aria-current");
    expect(expression).toContain("data-selected");
  });

  it("targets the selected model row before opening the effort menu", () => {
    const expression = buildThinkingTimeExpressionForTest("extended");
    expect(expression).toContain("const findEffortRow");
    expect(expression).toContain("const rowIsSelected");
    expect(expression).toContain("if (rowIsSelected(row)) return t;");
    expect(expression).toContain("modelKindFromTrailing");
    expect(expression).toContain("model-kind-not-found");
  });

  it("preserves Chinese thinking-effort labels while normalizing", () => {
    const expression = buildThinkingTimeExpressionForTest("heavy");
    expect(expression).toContain("\\u4e00-\\u9fa5");
    expect(expression).toContain("'重度'");
  });

  it("infers target mode kind without conflating GPT-5.6 Sol with Pro", () => {
    expect(inferThinkingTargetModelKindForTest("GPT-5.6 Sol")).toBeNull();
    expect(inferThinkingTargetModelKindForTest("gpt-5.5-pro")).toBe("pro");
    expect(inferThinkingTargetModelKindForTest("Thinking 5.5")).toBe("thinking");
    expect(inferThinkingTargetModelKindForTest("Instant")).toBe("instant");
    expect(inferThinkingTargetModelKindForTest("gpt-5.5")).toBeNull();
    expect(inferThinkingTargetModelKindForTest("profile")).toBeNull();
    expect(inferThinkingTargetModelKindForTest("prototype")).toBeNull();
    expect(inferThinkingTargetModelKindForTest("project")).toBeNull();
  });

  it("proves checked Pro and Sol through both live controlled menus", async () => {
    await expect(evaluateGpt56SolProIntelligenceMenu({})).resolves.toMatchObject({
      status: "already-selected",
      label: "Pro",
      modelKind: "pro",
      modelLabel: "GPT-5.6 Sol",
      modelVerified: true,
      modeLabel: "Pro",
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    });
  });

  it("uses unique newly-visible menu deltas when both triggers lack aria-controls", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({
        useControlledParent: false,
        useControlledModel: false,
      }),
    ).resolves.toMatchObject({
      status: "already-selected",
      modelVerified: true,
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    });
  });

  it("opens a controlled Sol submenu that responds to pointer hover instead of click", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({ modelOpensOnHover: true }),
    ).resolves.toMatchObject({
      status: "already-selected",
      modelVerified: true,
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    });
  });

  it.each([{ delayedControlledParentOwner: true }, { delayedControlledModelOwner: true }])(
    "polls fresh controlled owner handles through delayed portal visibility: %o",
    async (options) => {
      await expect(evaluateGpt56SolProIntelligenceMenu(options)).resolves.toMatchObject({
        status: "already-selected",
        modelVerified: true,
        modeVerified: true,
        verifiedBeforePromptSubmit: true,
      });
    },
  );

  it("keeps arbitrary React fiber state out of the authorization result", async () => {
    expect(buildThinkingTimeExpressionForTest("extended", "GPT-5.6 Sol")).not.toContain(
      "__reactFiber",
    );
    await expect(evaluateGpt56SolProIntelligenceMenu({ fiberNoise: true })).resolves.toMatchObject({
      status: "already-selected",
      modelVerified: true,
      modeVerified: true,
    });
  });

  it("selects bare Pro, discards old handles, then fully re-proves both axes", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({
        proChecked: false,
        remountParentMenuOnProSwitch: true,
      }),
    ).resolves.toMatchObject({
      status: "switched",
      modelLabel: "GPT-5.6 Sol",
      modelVerified: true,
      modeLabel: "Pro",
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    });
  });

  it.each(["Instant5.5", "Instant 5.5"])(
    "repairs the live non-Pro picker label %s to checked Pro",
    async (currentPillLabel) => {
      await expect(
        evaluateGpt56SolProIntelligenceMenu({
          proChecked: false,
          currentPillLabel,
        }),
      ).resolves.toMatchObject({
        status: "switched",
        modelLabel: "GPT-5.6 Sol",
        modelVerified: true,
        modeLabel: "Pro",
        modeVerified: true,
        verifiedBeforePromptSubmit: true,
      });
    },
  );

  it("selects Sol in the owned submenu, discards old handles, then fully re-proves both axes", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({
        solChecked: false,
        remountModelMenuOnSolSwitch: true,
      }),
    ).resolves.toMatchObject({
      status: "switched",
      modelLabel: "GPT-5.6 Sol",
      modelVerified: true,
      modeLabel: "Pro",
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    });
  });

  it("re-proves and repairs Pro when switching Sol invalidates the parent axis", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({
        solChecked: false,
        uncheckProOnSolSwitch: true,
      }),
    ).resolves.toMatchObject({
      status: "switched",
      modelVerified: true,
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    });
  });

  it.each([
    { solTriggerLabel: "GPT-5.6 Sol Mini" },
    { solTriggerLabel: "GPT-5.6 Luna" },
    { solTriggerLabel: "GPT-6.5 Sol" },
    { solRowLabel: "GPT-5.6 Sol Mini" },
    { solRowLabel: "GPT-5.6 Luna" },
    { solRowLabel: "GPT-6.5 Sol" },
  ])("rejects exact-model lookalikes: %o", async (lookalike) => {
    await expect(evaluateGpt56SolProIntelligenceMenu(lookalike)).resolves.toMatchObject({
      modelVerified: false,
      modeVerified: false,
      verifiedBeforePromptSubmit: false,
    });
  });

  it("requires an exact unique Sol submenu trigger in the owned parent", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({ includeSolTrigger: false }),
    ).resolves.toMatchObject({
      modelVerified: false,
      modeVerified: false,
      verifiedBeforePromptSubmit: false,
    });
  });

  it.each([{ includePro: false }, { includeSolRow: false }])(
    "requires the exact target row on both axes: %o",
    async (missingRow) => {
      await expect(evaluateGpt56SolProIntelligenceMenu(missingRow)).resolves.toMatchObject({
        modelVerified: false,
        modeVerified: false,
        verifiedBeforePromptSubmit: false,
      });
    },
  );

  it.each([
    { duplicateVisiblePro: true },
    { duplicateHiddenPro: true },
    { duplicateVisibleSolTrigger: true },
    { duplicateHiddenSolTrigger: true },
    { duplicateVisibleSolRow: true },
    { duplicateHiddenSolRow: true },
  ])("fails closed on visible or hidden exact-label duplicates: %o", async (duplicate) => {
    await expect(evaluateGpt56SolProIntelligenceMenu(duplicate)).resolves.toMatchObject({
      modelVerified: false,
      modeVerified: false,
      verifiedBeforePromptSubmit: false,
    });
  });

  it.each([
    { effortMarkerConflict: true },
    { modelMarkerConflict: true },
    { effortMarkerMissing: true },
    { modelMarkerMissing: true },
    { effortOptionalMarkerConflict: true },
    { modelOptionalMarkerConflict: true },
  ])("requires complete, mutually agreeing public selection markers: %o", async (conflict) => {
    await expect(evaluateGpt56SolProIntelligenceMenu(conflict)).resolves.toMatchObject({
      modelVerified: false,
      modeVerified: false,
      verifiedBeforePromptSubmit: false,
    });
  });

  it.each([{ extraEffortChecked: true }, { extraModelChecked: true }])(
    "requires exactly one checked row across the owned selection group: %o",
    async (extraChecked) => {
      await expect(evaluateGpt56SolProIntelligenceMenu(extraChecked)).resolves.toMatchObject({
        modelVerified: false,
        modeVerified: false,
        verifiedBeforePromptSubmit: false,
      });
    },
  );

  it.each([{ duplicateParentId: true }, { duplicateModelId: true }])(
    "vetoes duplicate aria-controls target ids: %o",
    async (duplicateId) => {
      await expect(evaluateGpt56SolProIntelligenceMenu(duplicateId)).resolves.toMatchObject({
        modelVerified: false,
        modeVerified: false,
        verifiedBeforePromptSubmit: false,
      });
    },
  );

  it("does not borrow a sole visible Intelligence menu from a foreign portal", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({
        useControlledParent: false,
        foreignMenuOnly: true,
      }),
    ).resolves.toMatchObject({
      status: "menu-not-found",
      modelVerified: false,
      modeVerified: false,
      verifiedBeforePromptSubmit: false,
    });
  });

  it.each([
    { useControlledParent: false, causalExtraParentMenu: true },
    { useControlledModel: false, causalExtraModelMenu: true },
  ])("vetoes ambiguous causal menu deltas: %o", async (ambiguousDelta) => {
    await expect(evaluateGpt56SolProIntelligenceMenu(ambiguousDelta)).resolves.toMatchObject({
      modelVerified: false,
      modeVerified: false,
      verifiedBeforePromptSubmit: false,
    });
  });

  it.each([{ disconnectParentWhenModelOpens: true }, { disconnectModelWhenOpened: true }])(
    "vetoes stale owner handles after an async submenu open: %o",
    async (staleOwner) => {
      await expect(evaluateGpt56SolProIntelligenceMenu(staleOwner)).resolves.toMatchObject({
        modelVerified: false,
        modeVerified: false,
        verifiedBeforePromptSubmit: false,
      });
    },
  );

  it("ignores a separate non-Pro composer menu pill", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({ additionalComposerPill: true }),
    ).resolves.toMatchObject({
      status: "already-selected",
      modelVerified: true,
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    });
  });

  it("requires exactly one visible Pro Intelligence pill in the active composer", async () => {
    await expect(
      evaluateGpt56SolProIntelligenceMenu({ additionalProPill: true }),
    ).resolves.toMatchObject({
      status: "chip-not-found",
      modelVerified: false,
      modeVerified: false,
      verifiedBeforePromptSubmit: false,
    });
  });

  it("returns structured pre-submit evidence for GPT-5.6 Sol + Pro", async () => {
    const runtime = {
      evaluate: async () => ({
        result: {
          value: {
            status: "already-selected",
            label: "Pro",
            modelKind: "pro",
            modelLabel: "GPT-5.6 Sol",
            modelVerified: true,
            modeLabel: "Pro",
            modeVerified: true,
            verifiedBeforePromptSubmit: true,
          },
        },
      }),
    };

    await expect(
      ensureThinkingTime(runtime as never, "extended", (() => {}) as never, "GPT-5.6 Sol"),
    ).resolves.toEqual({
      requestedModelLabel: "GPT-5.6 Sol",
      resolvedModelLabel: "GPT-5.6 Sol",
      modelVerified: true,
      requestedMode: "Pro",
      resolvedModeLabel: "Pro",
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    });
  });

  it("rejects bare Pro evidence without owned model-submenu Sol proof", async () => {
    const runtime = {
      evaluate: async () => ({
        result: {
          value: {
            status: "already-selected",
            label: "Pro",
            modelKind: "pro",
            modeLabel: "Pro",
            modeVerified: true,
            modelVerified: false,
            verifiedBeforePromptSubmit: false,
          },
        },
      }),
    };

    await expect(
      ensureThinkingTime(runtime as never, "extended", (() => {}) as never, "GPT-5.6 Sol"),
    ).rejects.toThrow(/owned Intelligence menu plus a checked exact GPT-5.6 Sol row/);
  });

  it("waits for the model button when current Pro effort rows render first", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }

    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly parent: FakeElement | null = null,
        private readonly onDispatch?: () => void,
      ) {
        super();
      }

      get parentElement(): FakeElement | null {
        return this.parent;
      }

      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }

      querySelector(selector: string): FakeElement | null {
        if (selector.includes("data-model-picker-thinking-effort-menu-item")) {
          return this.attributes["aria-checked"] ? this : null;
        }
        return null;
      }

      querySelectorAll(_selector: string): FakeElement[] {
        return [];
      }

      closest(_selector: string): FakeElement | null {
        return this.parent;
      }

      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }

      getBoundingClientRect(): { width: number; height: number } {
        return { width: 24, height: 24 };
      }

      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }

    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let proClicks = 0;
    let thinkingClicks = 0;
    let now = 0;
    let modelButtonClicks = 0;
    let firstModelButtonClickAt: number | null = null;
    const modelButton = new FakeElement(
      "Extended",
      {
        "data-testid": "model-switcher-dropdown-button",
        "aria-expanded": "false",
      },
      null,
      () => {
        modelButtonClicks += 1;
        firstModelButtonClickAt ??= now;
      },
    );
    const unrelatedComposerPill = new FakeElement("Canvas", {
      class: "__composer-pill",
    });
    const thinkingRow = new FakeElement("", {
      "data-model-picker-thinking-effort-row": "true",
      "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
    });
    const thinkingTrailing = new FakeElement(
      "",
      {
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-thinking-thinking-effort",
      },
      thinkingRow,
      () => {
        thinkingClicks += 1;
      },
    );
    const proRow = new FakeElement("", {
      "data-model-picker-thinking-effort-row": "true",
      "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
    });
    const proTrailing = new FakeElement(
      "",
      {
        "data-model-picker-thinking-effort-action": "true",
        "data-testid": "model-switcher-gpt-5-5-pro-thinking-effort",
      },
      proRow,
      () => {
        proClicks += 1;
      },
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) =>
        selector.includes("model-switcher-dropdown-button") && now >= 1_000 ? modelButton : null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [unrelatedComposerPill];
        return selector.includes("data-model-picker-thinking-effort-action")
          ? [thinkingTrailing, proTrailing]
          : [];
      },
      dispatchEvent: () => true,
    };
    const performanceStub = {
      now: () => {
        now += 500;
        return now;
      },
    };
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const windowStub = {
      PointerEvent: FakeMouseEvent,
      MouseEvent: FakeMouseEvent,
      Event: FakeMouseEvent,
    };
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        windowStub,
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toMatchObject({ status: "menu-not-found" });
    expect(modelButtonClicks).toBeGreaterThan(0);
    expect(firstModelButtonClickAt).not.toBeNull();
    expect(firstModelButtonClickAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2_000);
    expect(proClicks).toBeGreaterThan(0);
    expect(thinkingClicks).toBe(0);
  });

  it("does not trust the model button label as Pro Extended effort proof", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).not.toContain("const modelButtonLabel = normalize");
    expect(expression).not.toContain("hasToken(modelButtonLabel, 'extended')");
  });

  it("fails closed for any unconfirmed Pro Extended effort status", async () => {
    const statuses = [
      "chip-not-found",
      "menu-not-found",
      "option-not-found",
      "selection-unverified",
      "model-kind-not-found",
      "unknown-status",
      undefined,
    ] as const;

    for (const status of statuses) {
      const runtime = {
        evaluate: async () => ({
          result: {
            value:
              status === undefined
                ? undefined
                : status === "model-kind-not-found"
                  ? { status, modelKind: "pro" }
                  : { status },
          },
        }),
      };

      await expect(
        ensureThinkingTime(runtime as never, "extended", (() => {}) as never, "gpt-5.5-pro"),
      ).rejects.toThrow(/refusing to submit without confirmed Pro Extended/);
    }
  });

  it("fails closed when the current model is inferred as Pro", async () => {
    const runtime = {
      evaluate: async () => ({
        result: { value: { status: "selection-unverified", modelKind: "pro" } },
      }),
    };

    await expect(
      ensureThinkingTime(runtime as never, "extended", (() => {}) as never, null),
    ).rejects.toThrow(/refusing to submit without confirmed Pro Extended/);
  });

  it("keeps thinking effort best-effort when no target model kind is provided", async () => {
    const runtime = {
      evaluate: async () => ({
        result: { value: { status: "model-kind-not-found", modelKind: null } },
      }),
    };
    const logs: string[] = [];

    await expect(
      ensureThinkingTime(
        runtime as never,
        "extended",
        ((message: string) => logs.push(message)) as never,
        null,
      ),
    ).resolves.toBeUndefined();

    expect(logs.at(-1)).toContain("continuing with ChatGPT default");
  });

  it("drives ChatGPT's new Intelligence effort picker for Pro Extended", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain("composer-intelligence-picker-content");
    expect(expression).toContain("matchesProExtended");
    expect(expression).toContain("INTELLIGENCE_WAIT_MS");
    expect(expression).toContain("menu?.querySelector?.(INTELLIGENCE_MENU_SELECTOR)");
    expect(expression).toContain("itemText === 'pro'");
    expect(expression).toContain("!document.querySelector(PRO_EFFORT_TRIGGER_SELECTOR)");
  });

  it("accepts checked Pro in GPT-5.6's wrapped Intelligence menu", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly children: FakeElement[] = [],
        private readonly nestedIntelligence: FakeElement | null = null,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("composer-intelligence-picker-content")) {
          return this.nestedIntelligence;
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const proRadio = new FakeElement("Pro", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const effortItems = [
      new FakeElement("极速5.5", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("中", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("高", { role: "menuitemradio", "aria-checked": "false" }),
      new FakeElement("极高", { role: "menuitemradio", "aria-checked": "false" }),
      proRadio,
      new FakeElement("GPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
    ];
    const intelligenceGroup = new FakeElement(
      "智能 极速5.5 中 高 极高 Pro GPT-5.6 Sol",
      { "data-testid": "composer-intelligence-picker-content", role: "group" },
      effortItems,
    );
    const outerMenu = new FakeElement(
      intelligenceGroup.textContent,
      { role: "menu" },
      effortItems,
      intelligenceGroup,
    );
    const modelButton = new FakeElement("Pro", {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceGroup;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [outerMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "already-selected", label: "Pro" });
  });

  it("selects exact Chinese Intelligence tiers without prefix collisions", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly nestedIntelligence: FakeElement | null = null,
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("composer-intelligence-picker-content")) {
          return this.nestedIntelligence;
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const cases: Array<{
      level: "light" | "standard" | "extended" | "heavy";
      label: string;
      reverseAmbiguousPair?: boolean;
      omitExtraHigh?: boolean;
    }> = [
      { level: "light", label: "极速5.5" },
      { level: "standard", label: "中" },
      { level: "extended", label: "高", reverseAmbiguousPair: true },
      { level: "heavy", label: "极高" },
      { level: "heavy", label: "极高", reverseAmbiguousPair: true },
      { level: "heavy", label: "高", omitExtraHigh: true },
    ];

    for (const testCase of cases) {
      let clickedLabel: string | null = null;
      let unrelatedPillClicks = 0;
      // Exact GPT-5.6 Sol + extended is the protected two-axis Pro route and
      // has dedicated fail-closed tests above. Keep the generic Chinese
      // "High" collision case on the legacy Thinking model while retaining
      // exact-Sol coverage for the other Intelligence tiers.
      const desiredModel = testCase.level === "extended" ? "Thinking 5.5" : "GPT-5.6 Sol";
      const proRadio = new FakeElement("Pro 深度模式", {
        role: "menuitemradio",
        "aria-checked": "true",
        "data-state": "checked",
      });
      const makeRadio = (label: string) => {
        const radio = new FakeElement(
          label,
          { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
          [],
          null,
          () => {
            clickedLabel = label;
            radio.setAttribute("aria-checked", "true");
            radio.setAttribute("data-state", "checked");
            proRadio.setAttribute("aria-checked", "false");
            proRadio.setAttribute("data-state", "unchecked");
          },
        );
        return radio;
      };
      const instant = makeRadio("极速5.5");
      const medium = makeRadio("中");
      const high = makeRadio("高");
      const extraHigh = makeRadio("极高");
      const ambiguousPair = testCase.omitExtraHigh
        ? [high]
        : testCase.reverseAmbiguousPair
          ? [extraHigh, high]
          : [high, extraHigh];
      const orderedEfforts = [instant, medium, ...ambiguousPair];
      const effortItems = [
        ...orderedEfforts,
        proRadio,
        new FakeElement("GPT-5.6 Sol", { role: "menuitem", "aria-haspopup": "menu" }),
      ];
      const intelligenceGroup = new FakeElement(
        `智能 ${orderedEfforts.map((item) => item.textContent).join(" ")} Pro 深度模式 GPT-5.6 Sol`,
        { "data-testid": "composer-intelligence-picker-content", role: "group" },
        effortItems,
      );
      const outerMenu = new FakeElement(
        intelligenceGroup.textContent,
        { role: "menu" },
        effortItems,
        intelligenceGroup,
      );
      const modelButton = new FakeElement(testCase.level === "extended" ? "Thinking" : "Pro", {
        class: "__composer-pill",
        "aria-expanded": "true",
        "aria-haspopup": "menu",
      });
      const unrelatedPill = new FakeElement(
        "Canvas",
        { class: "__composer-pill" },
        [],
        null,
        () => {
          unrelatedPillClicks += 1;
        },
      );
      const documentStub = {
        body: new FakeElement(""),
        querySelector: (selector: string) => {
          if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) return null;
          if (selector.includes("composer-intelligence-picker-content")) return intelligenceGroup;
          if (
            selector.includes("model-switcher-dropdown-button") ||
            selector.includes("__composer-pill")
          ) {
            return modelButton;
          }
          return null;
        },
        querySelectorAll: (selector: string) => {
          if (selector.includes("__composer-pill")) return [unrelatedPill, modelButton];
          if (selector.includes('role="menu"') || selector.includes("data-radix")) {
            return [outerMenu];
          }
          return [];
        },
        dispatchEvent: () => true,
      };
      let now = 0;
      const performanceStub = { now: () => (now += 100) };
      const expression = buildThinkingTimeExpressionForTest(testCase.level, desiredModel);
      const evaluate = new Function(
        "document",
        "performance",
        "setTimeout",
        "window",
        "EventTarget",
        "PointerEvent",
        "MouseEvent",
        "HTMLElement",
        `return ${expression};`,
      ) as (
        document: unknown,
        performance: unknown,
        setTimeout: unknown,
        window: unknown,
        EventTarget: unknown,
        PointerEvent: unknown,
        MouseEvent: unknown,
        HTMLElement: unknown,
      ) => Promise<unknown>;

      await expect(
        evaluate(
          documentStub,
          performanceStub,
          (callback: () => void) => callback(),
          { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
          FakeEventTarget,
          FakeMouseEvent,
          FakeMouseEvent,
          FakeElement,
        ),
      ).resolves.toEqual({ status: "switched", label: testCase.label });
      expect(clickedLabel).toBe(testCase.label);
      expect(unrelatedPillClicks).toBe(0);
    }
  });

  it("selects Extended from the current standalone Pro composer pill", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(_selector: string): FakeElement | null {
        return null;
      }
      querySelectorAll(selector: string): FakeElement[] {
        return selector.includes("menuitem") || selector === "button" ? this.children : [];
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return selector === "button.__composer-pill" && this.attributes.class === "__composer-pill";
      }
      contains(_node: unknown): boolean {
        return false;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const proPill = new FakeElement(
      "Pro",
      {
        class: "__composer-pill",
        "aria-controls": "pro-effort-menu",
        "aria-expanded": "false",
        "aria-haspopup": "menu",
      },
      [],
      () => proPill.setAttribute("aria-expanded", "true"),
    );
    const standard = new FakeElement("Standard", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const extended = new FakeElement(
      "Extended",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        standard.setAttribute("aria-checked", "false");
        standard.setAttribute("data-state", "unchecked");
        extended.setAttribute("aria-checked", "true");
        extended.setAttribute("data-state", "checked");
        proPill.setAttribute("aria-expanded", "false");
      },
    );
    const effortMenu = new FakeElement(
      "Pro thinking effort Standard Extended",
      { role: "menu", "data-state": "open" },
      [standard, extended],
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (_selector: string) => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("form button.__composer-pill")) return [proPill];
        if (selector.includes("composer-footer-actions")) return [proPill];
        if (selector.includes("__composer-pill-composite")) return [proPill];
        if (selector.includes('[role="menu"]')) {
          return proPill.getAttribute("aria-expanded") === "true" ? [effortMenu] : [];
        }
        return [];
      },
      getElementById: (id: string) =>
        id === "pro-effort-menu" && proPill.getAttribute("aria-expanded") === "true"
          ? effortMenu
          : null,
      dispatchEvent: () => true,
    };
    let now = 0;
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        { now: () => (now += 100) },
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Extended" });
    expect(extended.getAttribute("aria-checked")).toBe("true");
  });

  it("selects Standard from the current standalone Pro composer pill", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(_selector: string): FakeElement | null {
        return null;
      }
      querySelectorAll(selector: string): FakeElement[] {
        return selector.includes("menuitem") || selector === "button" ? this.children : [];
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return selector === "button.__composer-pill" && this.attributes.class === "__composer-pill";
      }
      contains(_node: unknown): boolean {
        return false;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const proPill = new FakeElement(
      "Pro",
      {
        class: "__composer-pill",
        "aria-controls": "pro-effort-menu",
        "aria-expanded": "false",
        "aria-haspopup": "menu",
      },
      [],
      () => proPill.setAttribute("aria-expanded", "true"),
    );
    const standard = new FakeElement(
      "Standard",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        standard.setAttribute("aria-checked", "true");
        standard.setAttribute("data-state", "checked");
        extended.setAttribute("aria-checked", "false");
        extended.setAttribute("data-state", "unchecked");
        proPill.setAttribute("aria-expanded", "false");
      },
    );
    const extended = new FakeElement("Extended", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const effortMenu = new FakeElement(
      "Pro thinking effort Standard Extended",
      { role: "menu", "data-state": "open" },
      [standard, extended],
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (_selector: string) => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("form button.__composer-pill")) return [proPill];
        if (selector.includes("composer-footer-actions")) return [proPill];
        if (selector.includes("__composer-pill-composite")) return [proPill];
        if (selector.includes('[role="menu"]')) {
          return proPill.getAttribute("aria-expanded") === "true" ? [effortMenu] : [];
        }
        return [];
      },
      getElementById: (id: string) =>
        id === "pro-effort-menu" && proPill.getAttribute("aria-expanded") === "true"
          ? effortMenu
          : null,
      dispatchEvent: () => true,
    };
    let now = 0;
    const expression = buildThinkingTimeExpressionForTest("standard", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        { now: () => (now += 100) },
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Standard" });
    expect(standard.getAttribute("aria-checked")).toBe("true");
  });

  it("waits for a delayed Intelligence pill when its model button and menu appear first", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(_selector: string): FakeElement | null {
        return null;
      }
      querySelectorAll(selector: string): FakeElement[] {
        return selector.includes("menuitem") || selector === "button" ? this.children : [];
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return selector.includes("__composer-pill") && this.attributes.class === "__composer-pill";
      }
      contains(_node: unknown): boolean {
        return false;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let pillVisible = false;
    let modelButtonClicks = 0;
    const modelButton = new FakeElement(
      "Thinking",
      {
        "data-testid": "model-switcher-dropdown-button",
        "aria-expanded": "false",
        "aria-haspopup": "menu",
      },
      [],
      () => {
        modelButtonClicks += 1;
      },
    );
    const intelligencePill = new FakeElement(
      "Medium",
      {
        class: "__composer-pill",
        "aria-controls": "intelligence-menu",
        "aria-expanded": "false",
        "aria-haspopup": "menu",
      },
      [],
      () => intelligencePill.setAttribute("aria-expanded", "true"),
    );
    const medium = new FakeElement("Medium", {
      role: "menuitemradio",
      "aria-checked": "true",
      "data-state": "checked",
    });
    const extraHigh = new FakeElement(
      "Extra High",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        medium.setAttribute("aria-checked", "false");
        medium.setAttribute("data-state", "unchecked");
        extraHigh.setAttribute("aria-checked", "true");
        extraHigh.setAttribute("data-state", "checked");
        intelligencePill.textContent = "Extra High";
        intelligencePill.setAttribute("aria-expanded", "false");
      },
    );
    const effortMenu = new FakeElement(
      "Intelligence Instant Medium High Extra High",
      { role: "menu", "data-state": "open" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        medium,
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        extraHigh,
      ],
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("model-switcher-dropdown-button")) return modelButton;
        if (selector === '[data-testid="composer-intelligence-picker-content"]') return effortMenu;
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (
          selector.includes("form button.__composer-pill") ||
          selector.includes("composer-footer-actions") ||
          selector.includes("__composer-pill-composite")
        ) {
          return pillVisible ? [intelligencePill] : [];
        }
        if (selector.includes('[role="menu"]')) {
          return intelligencePill.getAttribute("aria-expanded") === "true" ? [effortMenu] : [];
        }
        return [];
      },
      getElementById: (id: string) =>
        id === "intelligence-menu" && intelligencePill.getAttribute("aria-expanded") === "true"
          ? effortMenu
          : null,
      dispatchEvent: () => true,
    };
    for (const targetModel of [null, "gpt-5.5"] as const) {
      pillVisible = false;
      modelButtonClicks = 0;
      intelligencePill.textContent = "Medium";
      intelligencePill.setAttribute("aria-expanded", "false");
      medium.setAttribute("aria-checked", "true");
      medium.setAttribute("data-state", "checked");
      extraHigh.setAttribute("aria-checked", "false");
      extraHigh.setAttribute("data-state", "unchecked");
      let now = 0;
      let timers = 0;
      const expression = buildThinkingTimeExpressionForTest("heavy", targetModel);
      const evaluate = new Function(
        "document",
        "performance",
        "setTimeout",
        "window",
        "EventTarget",
        "PointerEvent",
        "MouseEvent",
        "HTMLElement",
        `return ${expression};`,
      ) as (
        document: unknown,
        performance: unknown,
        setTimeout: unknown,
        window: unknown,
        EventTarget: unknown,
        PointerEvent: unknown,
        MouseEvent: unknown,
        HTMLElement: unknown,
      ) => Promise<unknown>;

      await expect(
        evaluate(
          documentStub,
          { now: () => (now += 100) },
          (callback: () => void) => {
            timers += 1;
            if (timers >= 40) pillVisible = true;
            callback();
          },
          { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
          FakeEventTarget,
          FakeMouseEvent,
          FakeMouseEvent,
          FakeElement,
        ),
      ).resolves.toEqual({ status: "switched", label: "Extra High" });
      expect(intelligencePill.textContent).toBe("Extra High");
      expect(modelButtonClicks).toBeGreaterThan(0);
    }
  });

  it("captures a model-picker diagnostic on failure outcomes", () => {
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    expect(expression).toContain("collectPickerDiagnostic");
    expect(expression).toContain("describeMenu");
    expect(expression).toContain("diagnostic: collectPickerDiagnostic()");
  });

  it("bounds and redacts model-picker diagnostic text", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly children: FakeElement[] = [],
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      querySelector(_selector: string): FakeElement | null {
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(_selector: string): boolean {
        return false;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 120, height: 30 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const secret = "abcdefghijklmnopqrstuvwxyz0123456789TOKEN";
    const item = new FakeElement(`Pro user@example.com ${secret}`, {
      role: "menuitemradio",
      "aria-label": `user@example.com ${secret}`,
    });
    const menu = new FakeElement(`Pro user@example.com ${secret}`, { role: "menu" }, [item]);
    const composerButton = new FakeElement(`user@example.com ${secret}`, {
      "aria-haspopup": "menu",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (_selector: string) => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [];
        if (selector.includes("composer-footer-actions")) return [];
        if (selector.includes("data-model-picker-thinking-effort")) return [];
        if (selector.includes('data-testid*="model-switcher"')) return [];
        if (selector.includes("form button[aria-haspopup")) return [composerButton];
        if (selector.includes('[role="menu"]')) return [menu];
        return [];
      },
      dispatchEvent: () => true,
    };
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    let now = 0;
    const result = await evaluate(
      documentStub,
      { now: () => (now += 500) },
      (callback: () => void) => callback(),
      { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
      FakeEventTarget,
      FakeMouseEvent,
      FakeMouseEvent,
      FakeElement,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("[redacted-email]");
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain(secret);
  });

  it("preserves current Pro Extended when no target model kind is supplied", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly children: FakeElement[] = [],
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      querySelector(_selector: string): FakeElement | null {
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const highRadio = new FakeElement("High", {
      role: "menuitemradio",
      "aria-checked": "false",
    });
    const proExtendedRadio = new FakeElement("Pro Extended", {
      role: "menuitemradio",
      "aria-checked": "true",
    });
    const intelligenceMenu = new FakeElement(
      "InstantMediumHighExtra HighPro Extended",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [highRadio, proExtendedRadio],
    );
    const modelButton = new FakeElement("Pro Extended", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (selector.includes("model-switcher-dropdown-button")) return null;
        if (selector.includes("__composer-pill") && !selector.includes("aria-haspopup")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) {
          return selector.includes("aria-haspopup") ? [] : [modelButton];
        }
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extended", null);
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "already-selected", label: "Pro Extended" });

    const genericOnlyMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra High",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [highRadio],
    );
    const genericOnlyDocument = {
      ...documentStub,
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return genericOnlyMenu;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [genericOnlyMenu];
        }
        return [];
      },
    };

    await expect(
      evaluate(
        genericOnlyDocument,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toMatchObject({ status: "option-not-found", modelKind: "pro" });
  });

  it("opens the Pro effort submenu before selecting Pro Standard", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let proSubmenuOpen = false;
    const mediumRadio = new FakeElement("Medium", {
      role: "menuitemradio",
      "aria-checked": "false",
      "data-state": "unchecked",
    });
    const proTrigger = new FakeElement(
      "",
      {
        role: "menuitem",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "data-state": "closed",
        "data-testid": "composer-intelligence-pro-thinking-effort-trigger",
      },
      [],
      () => {
        proSubmenuOpen = true;
        proTrigger.setAttribute("aria-expanded", "true");
        proTrigger.setAttribute("data-state", "open");
      },
    );
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra HighPro ExtendedGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        mediumRadio,
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "true" }),
        proTrigger,
        new FakeElement("GPT-5.5", { role: "menuitem", "aria-haspopup": "menu" }),
      ],
    );
    const proStandardRadio = new FakeElement(
      "Pro Standard",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        proStandardRadio.setAttribute("aria-checked", "true");
        proStandardRadio.setAttribute("data-state", "checked");
        mediumRadio.setAttribute("aria-checked", "false");
        mediumRadio.setAttribute("data-state", "unchecked");
      },
    );
    const proSubmenu = new FakeElement("Pro StandardPro Extended", { role: "menu" }, [
      proStandardRadio,
      new FakeElement("Pro Extended", {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      }),
    ]);
    const modelButton = new FakeElement("Pro Extended", {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) {
          return proTrigger;
        }
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return proSubmenuOpen ? [intelligenceMenu, proSubmenu] : [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("standard", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Pro Standard" });
  });

  it("verifies Pro Extended when the submenu closes after selection", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      focus(): void {}
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let intelligenceMenuOpen = true;
    let proSubmenuOpen = false;
    const proTrigger = new FakeElement(
      "",
      {
        role: "menuitem",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "data-state": "closed",
        "data-testid": "composer-intelligence-pro-thinking-effort-trigger",
      },
      [],
      () => {
        proSubmenuOpen = true;
        proTrigger.setAttribute("aria-expanded", "true");
        proTrigger.setAttribute("data-state", "open");
      },
    );
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra HighProGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Pro", { role: "menuitemradio", "aria-checked": "true" }),
        proTrigger,
        new FakeElement("GPT-5.5", { role: "menuitem", "aria-haspopup": "menu" }),
      ],
    );
    const modelButton = new FakeElement("Pro", {
      class: "__composer-pill",
      "aria-expanded": "true",
      "aria-haspopup": "menu",
    });
    const proExtendedRadio = new FakeElement(
      "Pro Extended",
      {
        role: "menuitemradio",
        "aria-checked": "false",
        "data-state": "unchecked",
      },
      [],
      () => {
        modelButton.textContent = "Pro Extended";
        modelButton.setAttribute("aria-expanded", "false");
        intelligenceMenuOpen = false;
        proSubmenuOpen = false;
      },
    );
    const proSubmenu = new FakeElement("Pro StandardPro Extended", { role: "menu" }, [
      new FakeElement("Pro Standard", {
        role: "menuitemradio",
        "aria-checked": "true",
        "data-state": "checked",
      }),
      proExtendedRadio,
    ]);
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-pro-thinking-effort-trigger")) {
          return intelligenceMenuOpen ? proTrigger : null;
        }
        if (selector.includes("composer-intelligence-picker-content")) {
          return intelligenceMenuOpen ? intelligenceMenu : null;
        }
        if (
          selector.includes("model-switcher-dropdown-button") ||
          selector.includes("__composer-pill")
        ) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) return [modelButton];
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          if (!intelligenceMenuOpen) return [];
          return proSubmenuOpen ? [intelligenceMenu, proSubmenu] : [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extended", "gpt-5.5-pro");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Pro Extended" });
  });

  it("confirms Extra High from an effort-only pill without aria-haspopup", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Readonly<Record<string, string>> = {},
        private readonly children: FakeElement[] = [],
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const extraHighRadio = new FakeElement("Extra High", {
      role: "menuitemradio",
      "aria-checked": "true",
    });
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra HighPro ExtendedGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        extraHighRadio,
        new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "false" }),
      ],
    );
    const modelButton = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (selector.includes("model-switcher-dropdown-button")) return null;
        if (selector.includes("__composer-pill") && !selector.includes("aria-haspopup")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) {
          return selector.includes("aria-haspopup") ? [] : [modelButton];
        }
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("heavy", "Thinking 5.5");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "already-selected", label: "Extra High" });
  });

  it("selects High for Thinking extended without matching Extra High", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    const highRadio = new FakeElement(
      "High",
      { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
      [],
      () => {
        highRadio.setAttribute("aria-checked", "true");
        highRadio.setAttribute("data-state", "checked");
      },
    );
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumExtra HighHighPro ExtendedGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        new FakeElement("Instant", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "false" }),
        highRadio,
        new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "false" }),
      ],
    );
    const modelButton = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) return intelligenceMenu;
        if (selector.includes("model-switcher-dropdown-button")) return null;
        if (selector.includes("__composer-pill") && !selector.includes("aria-haspopup")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) {
          return selector.includes("aria-haspopup") ? [] : [modelButton];
        }
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return [intelligenceMenu];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("extended", "Thinking 5.5");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "High" });
  });

  it("verifies non-Pro Intelligence selection from a replacement pill when the menu closes", async () => {
    class FakeEventTarget {
      dispatchEvent(_event: unknown): boolean {
        return true;
      }
    }
    class FakeElement extends FakeEventTarget {
      public isConnected = true;

      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
        private readonly onDispatch?: () => void,
      ) {
        super();
      }
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
      }
      querySelector(selector: string): FakeElement | null {
        if (selector.includes("menu-label")) {
          return new FakeElement("Intelligence");
        }
        return null;
      }
      querySelectorAll(_selector: string): FakeElement[] {
        return this.children;
      }
      closest(_selector: string): FakeElement | null {
        return null;
      }
      matches(selector: string): boolean {
        return (
          selector.includes("__composer-pill") &&
          this.attributes.class?.includes("__composer-pill") === true
        );
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 144, height: 36 };
      }
      override dispatchEvent(event: unknown): boolean {
        this.onDispatch?.();
        return super.dispatchEvent(event);
      }
    }
    class FakeMouseEvent {
      constructor(
        public readonly type: string,
        public readonly init?: unknown,
      ) {}
    }

    let intelligenceMenuOpen = true;
    let modelButton = new FakeElement("Extra High", {
      class: "__composer-pill",
      "aria-expanded": "true",
    });
    const instantRadio = new FakeElement(
      "Instant",
      { role: "menuitemradio", "aria-checked": "false", "data-state": "unchecked" },
      [],
      () => {
        if (!intelligenceMenuOpen) return;
        modelButton.isConnected = false;
        modelButton = new FakeElement("Instant", {
          class: "__composer-pill",
          "aria-expanded": "false",
        });
        intelligenceMenuOpen = false;
      },
    );
    const intelligenceMenu = new FakeElement(
      "IntelligenceInstantMediumHighExtra HighPro ExtendedGPT-5.5",
      { "data-testid": "composer-intelligence-picker-content", role: "menu" },
      [
        instantRadio,
        new FakeElement("Medium", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("High", { role: "menuitemradio", "aria-checked": "false" }),
        new FakeElement("Extra High", { role: "menuitemradio", "aria-checked": "true" }),
        new FakeElement("Pro Extended", { role: "menuitemradio", "aria-checked": "false" }),
      ],
    );
    const documentStub = {
      body: new FakeElement(""),
      querySelector: (selector: string) => {
        if (selector.includes("composer-intelligence-picker-content")) {
          return intelligenceMenuOpen ? intelligenceMenu : null;
        }
        if (selector.includes("model-switcher-dropdown-button")) return null;
        if (selector.includes("__composer-pill") && !selector.includes("aria-haspopup")) {
          return modelButton;
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("__composer-pill")) {
          return selector.includes("aria-haspopup") ? [] : [modelButton];
        }
        if (selector.includes('role="menu"') || selector.includes("data-radix")) {
          return intelligenceMenuOpen ? [intelligenceMenu] : [];
        }
        return [];
      },
      dispatchEvent: () => true,
    };
    let now = 0;
    const performanceStub = { now: () => (now += 100) };
    const expression = buildThinkingTimeExpressionForTest("light", "Thinking 5.5");
    const evaluate = new Function(
      "document",
      "performance",
      "setTimeout",
      "window",
      "EventTarget",
      "PointerEvent",
      "MouseEvent",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      performance: unknown,
      setTimeout: unknown,
      window: unknown,
      EventTarget: unknown,
      PointerEvent: unknown,
      MouseEvent: unknown,
      HTMLElement: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluate(
        documentStub,
        performanceStub,
        (callback: () => void) => callback(),
        { PointerEvent: FakeMouseEvent, MouseEvent: FakeMouseEvent, Event: FakeMouseEvent },
        FakeEventTarget,
        FakeMouseEvent,
        FakeMouseEvent,
        FakeElement,
      ),
    ).resolves.toEqual({ status: "switched", label: "Instant" });
  });
});
