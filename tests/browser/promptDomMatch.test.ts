import { describe, expect, test, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";

import { buildSubmittedUserMessageProbeExpressionForTest } from "../../src/browser/actions/captureBinding.js";
import {
  buildPromptRecoveryOwnershipPreview,
  computeRenderedPromptDomSha256,
  normalizePromptForDomMatch,
  normalizeExactComposerPromptIdentity,
  normalizeRenderedPromptDomIdentity,
  PROMPT_DOM_IDENTITY_NORMALIZER_DECLARATION,
  PROMPT_DOM_NORMALIZER_DECLARATION,
  readExactComposerPromptText,
  readRenderedPromptDomIdentity,
} from "../../src/browser/promptDomMatch.js";
import { __test__ as reattachTest } from "../../src/browser/reattach.js";
import { waitForPromptPreview } from "../../src/browser/reattachHelpers.js";
import type { ChromeClient } from "../../src/browser/types.js";

const HEADING = "# Recovery ownership heading\n";
const INLINE_CODE = `inline ownership token ${"q".repeat(48)}`;
const INLINE_CODE_OPEN_INDEX = 116;
const PADDING = "p".repeat(INLINE_CODE_OPEN_INDEX - HEADING.length);
const MARKDOWN_PREVIEW = `${HEADING}${PADDING}\`${INLINE_CODE}\` trailing text`;
const RENDERED_PREVIEW = `Recovery ownership heading\n${PADDING}${INLINE_CODE} trailing text`;
const RAW_SAVED_PREVIEW = MARKDOWN_PREVIEW.slice(0, 160);
const LINK_PADDING = "p".repeat(100);
const LINK_LABEL = "ownership-link-token";
const LINK_DESTINATION = `https://example.com/${"deep/".repeat(24)}artifact`;
const MARKDOWN_LINK_PREVIEW = `${LINK_PADDING} [${LINK_LABEL}](${LINK_DESTINATION}) trailing text`;
const RENDERED_LINK_PREVIEW = `${LINK_PADDING} ${LINK_LABEL} trailing text`;
const RAW_SAVED_LINK_PREVIEW = MARKDOWN_LINK_PREVIEW.slice(0, 160);

function makeExactTextHarness(options: {
  logicalText: string;
  innerText?: string;
  anchorOffset?: number;
  focusOffset?: number;
  rangeCount?: number;
  shadowRoot?: boolean;
  unsupportedShadowRoot?: boolean;
  throwOnRead?: boolean;
}) {
  let selectedNode: { logicalText: string } | null = null;
  const editor = {
    tagName: "DIV",
    innerText: options.innerText ?? options.logicalText,
    logicalText: options.logicalText,
    ownerDocument: null as unknown,
    getRootNode: () => root,
  };
  const anchorOffset = options.anchorOffset ?? options.logicalText.length;
  const focusOffset = options.focusOffset ?? options.logicalText.length;
  const range = {
    cloneRange: () => ({ ...range }),
  };
  const selection = {
    rangeCount: options.rangeCount ?? 1,
    anchorNode: editor as unknown,
    anchorOffset,
    focusNode: editor as unknown,
    focusOffset,
    getRangeAt: vi.fn(() => range),
    removeAllRanges: vi.fn(() => {
      selection.rangeCount = 0;
      selection.anchorNode = null as unknown as typeof editor;
      selection.anchorOffset = 0;
      selection.focusNode = null as unknown as typeof editor;
      selection.focusOffset = 0;
    }),
    addRange: vi.fn(
      (candidate: {
        selectedNode?: { logicalText: string };
        startContainer?: typeof editor;
        startOffset?: number;
        endContainer?: typeof editor;
        endOffset?: number;
      }) => {
        selectedNode = candidate.selectedNode ?? null;
        selection.rangeCount = 1;
        selection.anchorNode = candidate.startContainer ?? editor;
        selection.anchorOffset = candidate.startOffset ?? 0;
        selection.focusNode = candidate.endContainer ?? editor;
        selection.focusOffset = candidate.endOffset ?? options.logicalText.length;
      },
    ),
    setBaseAndExtent: vi.fn(
      (
        restoredAnchorNode: typeof editor,
        restoredAnchorOffset: number,
        restoredFocusNode: typeof editor,
        restoredFocusOffset: number,
      ) => {
        selectedNode = null;
        selection.rangeCount = 1;
        selection.anchorNode = restoredAnchorNode;
        selection.anchorOffset = restoredAnchorOffset;
        selection.focusNode = restoredFocusNode;
        selection.focusOffset = restoredFocusOffset;
      },
    ),
    toString: vi.fn(() => {
      if (options.throwOnRead) throw new Error("injected selection read failure");
      return selectedNode?.logicalText ?? "";
    }),
  };
  const document = {
    activeElement: editor,
    createRange: () => {
      const temporaryRange = {
        selectedNode: null as { logicalText: string } | null,
        startContainer: editor,
        startOffset: 0,
        endContainer: editor,
        endOffset: options.logicalText.length,
        selectNodeContents(node: { logicalText: string }) {
          this.selectedNode = node;
        },
      };
      return temporaryRange;
    },
    getSelection: () => selection,
  };
  const root = options.unsupportedShadowRoot
    ? {}
    : options.shadowRoot
      ? { activeElement: editor, getSelection: () => selection }
      : document;
  editor.ownerDocument = document;
  return { document, editor, selection };
}

describe("exact composer editing-host plaintext", () => {
  test("reads textarea and input values without requiring Selection APIs", () => {
    expect(readExactComposerPromptText({ tagName: "TEXTAREA", value: "a\n\nb" })).toEqual({
      ok: true,
      value: "a\n\nb",
      reason: null,
      selectionRestored: true,
      focusPreserved: true,
    });
    expect(readExactComposerPromptText({ tagName: "INPUT", value: "one line" })).toMatchObject({
      ok: true,
      value: "one line",
    });
  });

  test("uses editing-host plaintext instead of distorted innerText and restores direction", () => {
    const harness = makeExactTextHarness({
      logicalText: "a\n\nb",
      innerText: "a\n\n\nb",
      anchorOffset: 4,
      focusOffset: 1,
    });

    expect(readExactComposerPromptText(harness.editor)).toEqual({
      ok: true,
      value: "a\n\nb",
      reason: null,
      selectionRestored: true,
      focusPreserved: true,
    });
    expect(harness.document.activeElement).toBe(harness.editor);
    expect(harness.selection).toMatchObject({
      rangeCount: 1,
      anchorNode: harness.editor,
      anchorOffset: 4,
      focusNode: harness.editor,
      focusOffset: 1,
    });
    expect(harness.selection.setBaseAndExtent).toHaveBeenCalledWith(
      harness.editor,
      4,
      harness.editor,
      1,
    );
  });

  test("uses a supported shadow-root selection and rejects unsupported roots before mutation", () => {
    const supported = makeExactTextHarness({ logicalText: "shadow text", shadowRoot: true });
    expect(readExactComposerPromptText(supported.editor)).toMatchObject({
      ok: true,
      value: "shadow text",
    });

    const unsupported = makeExactTextHarness({
      logicalText: "shadow text",
      unsupportedShadowRoot: true,
    });
    expect(readExactComposerPromptText(unsupported.editor)).toMatchObject({
      ok: false,
      reason: "selection-api-unavailable",
    });
    expect(unsupported.selection.removeAllRanges).not.toHaveBeenCalled();
  });

  test("rejects unsupported multi-range state before mutation", () => {
    const harness = makeExactTextHarness({ logicalText: "text", rangeCount: 2 });
    expect(readExactComposerPromptText(harness.editor)).toMatchObject({
      ok: false,
      reason: "selection-state-unsupported",
    });
    expect(harness.selection.removeAllRanges).not.toHaveBeenCalled();
  });

  test("refuses an unfocused contenteditable before mutating Selection", () => {
    const harness = makeExactTextHarness({ logicalText: "text" });
    harness.document.activeElement = { tagName: "BUTTON" } as unknown as typeof harness.editor;
    expect(readExactComposerPromptText(harness.editor)).toMatchObject({
      ok: false,
      reason: "editor-not-focused",
      selectionRestored: true,
      focusPreserved: true,
    });
    expect(harness.selection.removeAllRanges).not.toHaveBeenCalled();
    expect(harness.selection.addRange).not.toHaveBeenCalled();
  });

  test("restores selection and focus when the plaintext read throws", () => {
    const harness = makeExactTextHarness({
      logicalText: "text",
      anchorOffset: 3,
      focusOffset: 1,
      throwOnRead: true,
    });
    expect(readExactComposerPromptText(harness.editor)).toEqual({
      ok: false,
      value: "",
      reason: "selection-read-failed",
      selectionRestored: true,
      focusPreserved: true,
    });
    expect(harness.selection).toMatchObject({
      anchorNode: harness.editor,
      anchorOffset: 3,
      focusNode: harness.editor,
      focusOffset: 1,
    });
  });
});

describe("exact composer prompt identity", () => {
  test("normalizes browser line endings without trimming composer content", () => {
    expect(normalizeExactComposerPromptIdentity(" x \r\n")).toBe(" x \n");
    expect(normalizeExactComposerPromptIdentity("x\r")).toBe("x\n");
  });

  test("preserves zero-width and joiner characters used by exact input", () => {
    const value = "\u200B\u200C👩‍💻\uFEFF";
    expect(normalizeExactComposerPromptIdentity(value)).toBe(value);
  });
});

class FakeHTMLElement {}

class FakePromptContent extends FakeHTMLElement {
  readonly parentElement = null;
  readonly textContent: string;
  readonly innerText: string;

  constructor(text: string) {
    super();
    this.textContent = text;
    this.innerText = text;
  }

  contains(other: unknown): boolean {
    return other === this;
  }

  querySelectorAll(): [] {
    return [];
  }
}

class FakeUserTurn extends FakeHTMLElement {
  readonly dataset = { turn: "user" };
  readonly parentElement = null;
  readonly textContent: string;
  readonly innerText: string;

  constructor(
    text: string,
    private readonly index: number,
    private readonly promptContent = [new FakePromptContent(text)],
  ) {
    super();
    this.textContent = text;
    this.innerText = text;
  }

  getAttribute(name: string): string {
    if (name === "data-message-author-role" || name === "data-turn") return "user";
    if (name === "data-message-id") return `user-message-${this.index}`;
    if (name === "data-testid") return `conversation-turn-${this.index}`;
    return "";
  }

  matches(selector: string): boolean {
    return selector === "[data-message-id]";
  }

  querySelector(): null {
    return null;
  }

  querySelectorAll(selector: string): FakePromptContent[] {
    return selector.includes("[data-message-content]") ? this.promptContent : [];
  }
}

type FakeUserTurnSpec = string | { text: string; promptContent: string[] };

function runtimeWithUserTurns(userTexts: FakeUserTurnSpec[]): ChromeClient["Runtime"] {
  const turns = userTexts.map((spec, index) => {
    const text = typeof spec === "string" ? spec : spec.text;
    const promptContent =
      typeof spec === "string"
        ? [new FakePromptContent(text)]
        : spec.promptContent.map((candidate) => new FakePromptContent(candidate));
    return new FakeUserTurn(text, index, promptContent);
  });
  const root = { querySelectorAll: () => turns };
  const document = {
    querySelector: () => root,
    querySelectorAll: () => turns,
  };
  return {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: await Function(
          "document",
          "location",
          "HTMLElement",
          "crypto",
          "TextEncoder",
          `return ${expression}`,
        )(
          document,
          { href: "https://chatgpt.com/c/recovery-conversation" },
          FakeHTMLElement,
          webcrypto,
          TextEncoder,
        ),
      },
    })),
  } as unknown as ChromeClient["Runtime"];
}

describe("prompt Markdown ownership matching", () => {
  test("normalizes headings and inline code before taking the 120-character prefix", () => {
    const openingTick = MARKDOWN_PREVIEW.indexOf("`");
    const closingTick = MARKDOWN_PREVIEW.lastIndexOf("`");
    expect(openingTick).toBeLessThan(120);
    expect(closingTick).toBeGreaterThan(160);

    const expectedPrefix = normalizePromptForDomMatch(RENDERED_PREVIEW).slice(0, 120);
    expect(normalizePromptForDomMatch(MARKDOWN_PREVIEW).slice(0, 120)).toBe(expectedPrefix);
    expect(normalizePromptForDomMatch(MARKDOWN_PREVIEW.slice(0, 120))).not.toBe(expectedPrefix);
  });

  test("normalizes a 160-character raw preview whose inline-code close was truncated", () => {
    expect(RAW_SAVED_PREVIEW).toHaveLength(160);
    expect(RAW_SAVED_PREVIEW).toContain("`");
    expect(RAW_SAVED_PREVIEW.match(/`/g)).toHaveLength(1);

    const normalizedSaved = normalizePromptForDomMatch(RAW_SAVED_PREVIEW);
    const normalizedRendered = normalizePromptForDomMatch(RENDERED_PREVIEW);
    expect(normalizedRendered.slice(0, normalizedSaved.length)).toBe(normalizedSaved);
  });

  test.each([
    { imageMarker: "", kind: "link" },
    { imageMarker: "!", kind: "image" },
  ])(
    "normalizes a 160-character raw preview cut inside a Markdown $kind destination",
    ({ imageMarker }) => {
      const markdown = `${LINK_PADDING} ${imageMarker}[${LINK_LABEL}](${LINK_DESTINATION}) trailing text`;
      const rendered = `${LINK_PADDING} ${LINK_LABEL} trailing text`;
      const saved = markdown.slice(0, 160);

      expect(saved).toHaveLength(160);
      expect(saved).toContain(`${imageMarker}[${LINK_LABEL}](`);
      expect(saved).not.toContain(") trailing text");

      const normalizedSaved = normalizePromptForDomMatch(saved);
      const normalizedRendered = normalizePromptForDomMatch(rendered);
      expect(normalizedRendered.slice(0, normalizedSaved.length)).toBe(normalizedSaved);
    },
  );

  test("persists recovery ownership after normalizing the complete submitted prompt", () => {
    expect(MARKDOWN_LINK_PREVIEW.indexOf(")")).toBeGreaterThan(160);
    const persisted = buildPromptRecoveryOwnershipPreview(MARKDOWN_LINK_PREVIEW);

    expect(persisted).toBe(normalizePromptForDomMatch(RENDERED_LINK_PREVIEW).slice(0, 120));
    expect(persisted).not.toContain("example.com");
    expect(persisted).not.toContain("[");
  });

  test("normalization is stable when a persisted ownership prefix is normalized again", () => {
    const once = normalizePromptForDomMatch("# Ownership &amp;amp; `token_value`");
    expect(normalizePromptForDomMatch(once)).toBe(once);
  });

  test("preserves content-significant literal underscore, glob, and home-path markers", () => {
    expect(normalizePromptForDomMatch("foo_bar")).not.toBe(normalizePromptForDomMatch("foobar"));
    expect(normalizePromptForDomMatch("*.ts")).not.toBe(normalizePromptForDomMatch(".ts"));
    expect(normalizePromptForDomMatch("~/.oracle")).not.toBe(
      normalizePromptForDomMatch("/.oracle"),
    );
  });

  test("strips paired Markdown emphasis without deleting literal marker characters", () => {
    expect(normalizePromptForDomMatch("Use **bold**, _italic_, and ~~removed~~ text")).toBe(
      normalizePromptForDomMatch("Use bold, italic, and removed text"),
    );
    expect(normalizePromptForDomMatch("token_value *.ts ~/.oracle")).toContain(
      "token_value *.ts ~/.oracle",
    );
  });

  test("rendered DOM identity preserves case, punctuation, and significant whitespace", () => {
    expect(normalizeRenderedPromptDomIdentity("  Token_Value\r\n*.ts  ")).toBe("Token_Value\n*.ts");
    expect(computeRenderedPromptDomSha256("Token_Value")).not.toBe(
      computeRenderedPromptDomSha256("tokenvalue"),
    );
    expect(computeRenderedPromptDomSha256("a  b")).not.toBe(computeRenderedPromptDomSha256("a b"));
  });

  test("rendered DOM identity includes stable Markdown hrefs but excludes attachment/UI hrefs", () => {
    class FakeAnchor {
      readonly innerText = "same label";
      readonly textContent = "same label";

      constructor(
        private readonly href: string,
        readonly parentElement: unknown = null,
      ) {}

      getAttribute(name: string): string {
        return name === "href" ? this.href : "";
      }

      hasAttribute(): boolean {
        return false;
      }
    }

    class FakeContent {
      readonly innerText = "Read same label";
      readonly textContent = this.innerText;

      constructor(private readonly anchors: FakeAnchor[]) {}

      matches(): boolean {
        return false;
      }

      contains(): boolean {
        return false;
      }

      querySelectorAll(selector: string): FakeAnchor[] {
        return selector === "a[href]" ? this.anchors : [];
      }
    }

    const attachmentOwner = {
      parentElement: null,
      getAttribute: (name: string) => (name === "data-testid" ? "attachment-chip" : ""),
      hasAttribute: () => false,
    };
    const buildTurn = (href: string) => {
      const stable = new FakeAnchor(href);
      const volatileBlob = new FakeAnchor("blob:https://chatgpt.com/transient", attachmentOwner);
      const volatileAttachment = new FakeAnchor(
        "https://chatgpt.com/backend-api/files/transient/download",
        attachmentOwner,
      );
      const volatileUi = new FakeAnchor("https://chatgpt.com/c/transient-ui-route");
      const content = new FakeContent([stable, volatileBlob, volatileAttachment]);
      return {
        innerText: "Read same label\nattachment.pdf\nEdit",
        textContent: "Read same label attachment.pdf Edit",
        matches: (selector: string) => selector === '[data-message-author-role="user"]',
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
          selector.includes(".whitespace-pre-wrap")
            ? [content]
            : selector === "a[href]"
              ? [volatileUi]
              : [],
      };
    };

    const first = readRenderedPromptDomIdentity(buildTurn("https://example.com/one"));
    const second = readRenderedPromptDomIdentity(buildTurn("https://example.com/two"));
    expect(first).toContain("https://example.com/one");
    expect(first).not.toContain("blob:");
    expect(first).not.toContain("backend-api/files");
    expect(first).not.toContain("transient-ui-route");
    expect(first).not.toContain("attachment.pdf");
    expect(first).not.toContain("Edit");
    expect(computeRenderedPromptDomSha256(first)).not.toBe(computeRenderedPromptDomSha256(second));
  });

  test("identity declaration reads the same message node used by Node", () => {
    const declarationRead = Function(
      `${PROMPT_DOM_IDENTITY_NORMALIZER_DECLARATION}; return readRenderedPromptDomIdentity;`,
    )() as (node: unknown) => string;
    const node = new FakeUserTurn("Token_Value", 0);

    expect(declarationRead(node)).toBe(readRenderedPromptDomIdentity(node));
  });

  test("normalizer declaration evaluates without module-scoped dependencies", () => {
    const evaluate = Function(
      `${PROMPT_DOM_NORMALIZER_DECLARATION}; return normalizePromptForDomMatch;`,
    )() as (value: unknown) => string;

    expect(evaluate("# Heading\n\n- **value** and `code` &amp; more")).toBe(
      normalizePromptForDomMatch("Heading\nvalue and code & more"),
    );
  });

  test("capture binding locates the rendered user turn from the Markdown prompt", () => {
    const runtime = runtimeWithUserTurns([RENDERED_PREVIEW]);
    const expression = buildSubmittedUserMessageProbeExpressionForTest(MARKDOWN_PREVIEW);

    return expect(runtime.evaluate({ expression, returnByValue: true })).resolves.toMatchObject({
      result: {
        value: {
          found: true,
          matchedPrompt: true,
          userMessageId: "user-message-0",
          userTurnTestId: "conversation-turn-0",
        },
      },
    });
  });

  test("capture binding tolerates attachment labels only after the complete prompt matches", async () => {
    const prompt = "review the attached implementation";
    const runtime = runtimeWithUserTurns([`${prompt}\nimplementation.ts`]);
    const expression = buildSubmittedUserMessageProbeExpressionForTest(prompt, undefined, [
      "implementation.ts",
    ]);

    await expect(runtime.evaluate({ expression, returnByValue: true })).resolves.toMatchObject({
      result: { value: { found: true, matchedPrompt: true } },
    });
  });

  test("capture binding rejects an unsupplied attachment-like suffix", async () => {
    const prompt = "review the attached implementation";
    const runtime = runtimeWithUserTurns([`${prompt}\nimplementation.ts`]);
    const expression = buildSubmittedUserMessageProbeExpressionForTest(prompt);

    await expect(runtime.evaluate({ expression, returnByValue: true })).resolves.toMatchObject({
      result: { value: { found: true, matchedPrompt: false } },
    });
  });

  test.each([
    (prompt: string) => `Quoted request: ${prompt}`,
    (prompt: string) => `> ${prompt}\nForeign wrapper`,
    (prompt: string) => `${prompt}\nForeign wrapper`,
  ])("capture binding rejects a foreign turn that merely wraps the prompt", async (wrap) => {
    const prompt = "explain the ownership invariant";
    const runtime = runtimeWithUserTurns([wrap(prompt)]);
    const expression = buildSubmittedUserMessageProbeExpressionForTest(prompt);

    await expect(runtime.evaluate({ expression, returnByValue: true })).resolves.toMatchObject({
      result: { value: { found: true, matchedPrompt: false } },
    });
  });

  test("capture binding does not elevate a foreign turn sharing only 120 characters", async () => {
    const sharedPrefix = "shared ownership prefix ".repeat(8);
    const expected = `${sharedPrefix}expected ending`;
    const foreign = `${sharedPrefix}foreign ending`;
    const runtime = runtimeWithUserTurns([foreign]);
    const expression = buildSubmittedUserMessageProbeExpressionForTest(expected);

    await expect(runtime.evaluate({ expression, returnByValue: true })).resolves.toMatchObject({
      result: { value: { found: true, matchedPrompt: false } },
    });
  });

  test("capture binding does not fall back to an older exact prompt when the latest turn is foreign", async () => {
    const prompt = "the exact submitted prompt";
    const runtime = runtimeWithUserTurns([prompt, "a newer foreign prompt"]);
    const expression = buildSubmittedUserMessageProbeExpressionForTest(prompt);

    await expect(runtime.evaluate({ expression, returnByValue: true })).resolves.toMatchObject({
      result: {
        value: {
          found: true,
          matchedPrompt: false,
          isLatestUserTurn: true,
          userMessageId: "user-message-1",
        },
      },
    });
  });

  test("capture binding locates a rendered link turn from its truncated raw preview", () => {
    const runtime = runtimeWithUserTurns([RENDERED_LINK_PREVIEW]);
    const expression = buildSubmittedUserMessageProbeExpressionForTest(
      RAW_SAVED_LINK_PREVIEW,
      computeRenderedPromptDomSha256(RENDERED_LINK_PREVIEW),
    );

    return expect(runtime.evaluate({ expression, returnByValue: true })).resolves.toMatchObject({
      result: {
        value: {
          found: true,
          matchedPrompt: true,
          userMessageId: "user-message-0",
          userTurnTestId: "conversation-turn-0",
        },
      },
    });
  });

  test("sidebar/open-target ownership proof finds the rendered Markdown turn", async () => {
    await expect(
      waitForPromptPreview(runtimeWithUserTurns([RENDERED_PREVIEW]), MARKDOWN_PREVIEW, 1_000),
    ).resolves.toBe(true);
  });

  test("reattach ownership proof finds a rendered link from its truncated raw preview", async () => {
    await expect(
      waitForPromptPreview(
        runtimeWithUserTurns([RENDERED_LINK_PREVIEW]),
        RAW_SAVED_LINK_PREVIEW,
        1_000,
      ),
    ).resolves.toBe(true);
  });

  test("turn binding retains unique/latest evidence after Markdown normalization", async () => {
    const readBinding = reattachTest.readPromptPreviewTurnBinding;

    await expect(
      readBinding(runtimeWithUserTurns(["unrelated", RENDERED_PREVIEW]), MARKDOWN_PREVIEW),
    ).resolves.toEqual({ matchedIndex: 1, latestUserIndex: 1, matchCount: 1 });
    await expect(
      readBinding(runtimeWithUserTurns([RENDERED_PREVIEW, RENDERED_PREVIEW]), MARKDOWN_PREVIEW),
    ).resolves.toEqual({ matchedIndex: 1, latestUserIndex: 1, matchCount: 2 });
    await expect(
      readBinding(
        runtimeWithUserTurns([RENDERED_PREVIEW, "newer foreign prompt"]),
        MARKDOWN_PREVIEW,
      ),
    ).resolves.toEqual({ matchedIndex: 0, latestUserIndex: 1, matchCount: 1 });
    await expect(
      readBinding(runtimeWithUserTurns(["recovery"]), MARKDOWN_PREVIEW),
    ).resolves.toBeNull();
  });

  test("full rendered DOM digest disambiguates prompts with the same ownership prefix", async () => {
    const readBinding = reattachTest.readPromptPreviewTurnBinding;
    const sharedPrefix = "shared recovery ownership ".repeat(8);
    const expected = `${sharedPrefix}expected suffix`;
    const foreign = `${sharedPrefix}foreign suffix`;
    const preview = buildPromptRecoveryOwnershipPreview(expected);
    const digest = computeRenderedPromptDomSha256(expected);

    await expect(
      readBinding(runtimeWithUserTurns([foreign, expected]), preview, digest),
    ).resolves.toEqual({ matchedIndex: 1, latestUserIndex: 1, matchCount: 1 });
    await expect(readBinding(runtimeWithUserTurns([foreign]), preview, digest)).resolves.toBeNull();
  });

  test("full rendered DOM digest can bind a non-first prompt-content candidate", async () => {
    const readBinding = reattachTest.readPromptPreviewTurnBinding;
    const prompt = "the actual submitted prompt";

    await expect(
      readBinding(
        runtimeWithUserTurns([
          {
            text: `attachment.pdf\n${prompt}`,
            promptContent: ["attachment.pdf", prompt],
          },
        ]),
        buildPromptRecoveryOwnershipPreview(prompt),
        computeRenderedPromptDomSha256(prompt),
      ),
    ).resolves.toEqual({ matchedIndex: 0, latestUserIndex: 0, matchCount: 1 });
  });

  test("duplicate matching content nodes count as one matching user turn", async () => {
    const readBinding = reattachTest.readPromptPreviewTurnBinding;
    const prompt = "one turn with duplicated rendered content";

    await expect(
      readBinding(
        runtimeWithUserTurns([
          {
            text: `${prompt}\n${prompt}`,
            promptContent: [prompt, prompt],
          },
        ]),
        buildPromptRecoveryOwnershipPreview(prompt),
        computeRenderedPromptDomSha256(prompt),
      ),
    ).resolves.toEqual({ matchedIndex: 0, latestUserIndex: 0, matchCount: 1 });
  });

  test("full rendered DOM digest keeps repeated identical prompts ambiguous", async () => {
    const readBinding = reattachTest.readPromptPreviewTurnBinding;
    const prompt = "repeat this exact recovery prompt";

    await expect(
      readBinding(
        runtimeWithUserTurns([prompt, prompt]),
        buildPromptRecoveryOwnershipPreview(prompt),
        computeRenderedPromptDomSha256(prompt),
      ),
    ).resolves.toEqual({ matchedIndex: 1, latestUserIndex: 1, matchCount: 2 });
  });
});
