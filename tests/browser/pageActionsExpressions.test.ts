import { describe, expect, test, vi } from "vitest";
import {
  buildAssistantExtractorForTest,
  buildAssistantSnapshotExpressionForTest,
  buildConversationDebugExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildCopyExpressionForTest,
  captureAssistantMarkdown,
  buildUserTurnAttachmentExpressionForTest,
} from "../../src/browser/pageActions.ts";
import { buildResponseObserverExpressionForTest } from "../../src/browser/actions/assistantResponse.ts";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../../src/browser/constants.ts";

describe("browser automation expressions", () => {
  test("assistant extractor references constants", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(JSON.stringify(ASSISTANT_ROLE_SELECTOR));
    expect(expression).toContain("afterLatestUser");
    expect(expression).toContain("compareDocumentPosition");
  });

  test("assistant extractor treats image-only ChatGPT turns as responses", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain("/backend-api/estuary/content?id=file_");
    expect(expression).toContain("Generated image.");
    expect(expression).toContain("stopped thinking edit");
    expect(expression).toContain("thought for");
  });

  test("assistant extractor indexes top-level turns instead of nested role nodes", () => {
    class FakeElement {
      readonly dataset: Record<string, string> = {};

      constructor(
        private readonly attributes: Record<string, string>,
        readonly innerText = "",
        private readonly children: FakeElement[] = [],
      ) {}

      get textContent(): string {
        return this.innerText;
      }

      get innerHTML(): string {
        return this.innerText;
      }

      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }

      matches(): boolean {
        return false;
      }

      querySelector(selector: string): FakeElement | null {
        if (selector === ASSISTANT_ROLE_SELECTOR) {
          return (
            this.children.find(
              (child) => child.getAttribute("data-message-author-role") === "assistant",
            ) ?? null
          );
        }
        return null;
      }

      querySelectorAll(): FakeElement[] {
        return [];
      }
    }

    const nestedUser = new FakeElement({ "data-message-author-role": "user" }, "old prompt");
    const nestedAssistant = new FakeElement(
      { "data-message-author-role": "assistant" },
      "old answer",
    );
    const userTurn = new FakeElement({ "data-testid": "conversation-turn-1" }, "old prompt", [
      nestedUser,
    ]);
    const assistantTurn = new FakeElement({ "data-testid": "conversation-turn-2" }, "old answer", [
      nestedAssistant,
    ]);
    const document = {
      querySelectorAll: (selector: string) => {
        if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return [userTurn, assistantTurn];
        if (selector === CONVERSATION_TURN_SELECTOR) {
          return [userTurn, nestedUser, assistantTurn, nestedAssistant];
        }
        return [];
      },
    };
    const expression = buildAssistantExtractorForTest("capture");
    const result = Function(
      "document",
      "HTMLElement",
      `${expression}; return capture();`,
    )(document, FakeElement) as { text?: string; turnIndex?: number } | null;

    expect(result).toMatchObject({ text: "old answer", turnIndex: 1 });
  });

  test("conversation debug expression references conversation selector", () => {
    const expression = buildConversationDebugExpressionForTest();
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
  });

  test("assistant snapshot expression guards against conversation drift", () => {
    const expression = buildAssistantSnapshotExpressionForTest(4, "conv-123");
    expect(expression).toContain('const EXPECTED_CONVERSATION_ID = "conv-123"');
    expect(expression).toContain("currentConversationId !== EXPECTED_CONVERSATION_ID");
    expect(expression).toContain("return null;");
  });

  test.each([
    "https://chatgpt.com/",
    "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
    "https://evil.example/c/conv-123",
    "https://chatgpt.com/c/other-conversation",
  ])("durable assistant binding rejects a missing, provisional, or foreign route: %s", (href) => {
    const expression = buildAssistantSnapshotExpressionForTest(4, "conv-123");
    const result = Function("location", "URL", `return ${expression}`)({ href }, URL);

    expect(result).toBeNull();
  });

  test("observer and attachment guards require an exact durable current identity", () => {
    const observerExpression = buildResponseObserverExpressionForTest(60_000, 4, "conv-123");
    const attachmentExpression = buildUserTurnAttachmentExpressionForTest({
      expectedPromptPrefix: "expected prompt text",
      expectedConversationId: "conv-123",
    });

    expect(observerExpression).toContain("return currentId === EXPECTED_CONVERSATION_ID");
    expect(observerExpression).not.toContain(
      "return !currentId || currentId === EXPECTED_CONVERSATION_ID",
    );
    expect(attachmentExpression).toContain("currentConversationId !== EXPECTED_CONVERSATION_ID");
    expect(attachmentExpression).not.toContain(
      "currentConversationId &&\n      currentConversationId !== EXPECTED_CONVERSATION_ID",
    );
  });

  test.each(["WEB", "WEB:fee7a622-991a-497a-bac4-a878b86f82f3"])(
    "does not bind assistant capture to provisional conversation id %s",
    (provisionalId) => {
      const snapshotExpression = buildAssistantSnapshotExpressionForTest(4, provisionalId);
      const observerExpression = buildResponseObserverExpressionForTest(60_000, 4, provisionalId);

      expect(snapshotExpression).toContain("const EXPECTED_CONVERSATION_ID = null");
      expect(observerExpression).toContain("const EXPECTED_CONVERSATION_ID = null");
      expect(snapshotExpression).not.toContain(
        `const EXPECTED_CONVERSATION_ID = ${JSON.stringify(provisionalId)}`,
      );
      expect(observerExpression).not.toContain(
        `const EXPECTED_CONVERSATION_ID = ${JSON.stringify(provisionalId)}`,
      );
    },
  );

  test("markdown fallback filters user turns and respects assistant indicators", () => {
    const expression = buildMarkdownFallbackExtractorForTest("2");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
    expect(expression).toContain("role !== 'user'");
    expect(expression).toContain("copy-turn-action-button");
    expect(expression).toContain(CONVERSATION_TURN_SELECTOR);
    expect(expression).toContain("afterLatestUser");
    expect(expression).toContain("isAfterLatestUserTurn");
    expect(expression).toContain("turn.contains?.(node)");
  });

  test("markdown fallback does not self-reference MIN_TURN_INDEX literal", () => {
    const expression = buildMarkdownFallbackExtractorForTest("MIN_TURN_INDEX");
    expect(expression).toContain("MIN_TURN_INDEX");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
  });

  test("copy expression scopes to assistant turn buttons", () => {
    const expression = buildCopyExpressionForTest({});
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(ASSISTANT_ROLE_SELECTOR);
    expect(expression).toContain("isAssistantTurn");
    expect(expression).toContain("copy-turn-action-button");
  });

  test("copy expression never falls back to a later assistant when a hinted turn is missing", async () => {
    vi.useFakeTimers();
    try {
      const querySelector = vi.fn(() => null);
      const querySelectorAll = vi.fn(() => [
        {
          // If the expression reached the latest-assistant fallback this
          // foreign button would be available to click.
          closest: vi.fn(),
        },
      ]);
      const expression = buildCopyExpressionForTest({ messageId: "owned-message" });
      const run = new Function("document", `return ${expression};`) as (document: {
        querySelector: typeof querySelector;
        querySelectorAll: typeof querySelectorAll;
      }) => Promise<{ success: boolean; status: string }>;

      const pending = run({ querySelector, querySelectorAll });
      await vi.advanceTimersByTimeAsync(10_200);

      await expect(pending).resolves.toEqual({
        success: false,
        status: "hint-target-missing",
      });
      expect(querySelector).toHaveBeenCalled();
      expect(querySelectorAll).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("message-id copy binding reaches the exact outer turn's sibling copy control", async () => {
    vi.useFakeTimers();
    try {
      class FakeMouseEvent extends Event {
        constructor(type: string) {
          super(type, { bubbles: true, cancelable: true });
        }
      }
      class FakeButton extends EventTarget {
        readonly scrollIntoView = vi.fn();
        readonly dispatchSpy = vi.fn();

        override dispatchEvent(event: Event): boolean {
          this.dispatchSpy(event.type);
          return super.dispatchEvent(event);
        }
      }
      class FakeTurn {
        constructor(
          readonly parentElement: FakeTurn | null,
          private readonly buttons: FakeButton[],
        ) {}

        closest(): FakeTurn {
          return this;
        }

        querySelectorAll(selector: string): FakeButton[] {
          return selector.includes("copy-turn-action-button") ? this.buttons : [];
        }
      }

      const clipboard = {
        writeText: async (_value: string) => undefined,
        write: async (_items: unknown[]) => undefined,
      };
      const ownedButton = new FakeButton();
      const foreignButton = new FakeButton();
      const ownedOuterTurn = new FakeTurn(null, [ownedButton]);
      const ownedMessageNode = new FakeTurn(ownedOuterTurn, []);
      const foreignOuterTurn = new FakeTurn(null, [foreignButton]);
      ownedButton.addEventListener("click", () => {
        void clipboard.writeText("Owned **markdown**");
      });
      foreignButton.addEventListener("click", () => {
        void clipboard.writeText("Foreign markdown");
      });
      const querySelector = vi.fn((selector: string) =>
        selector.includes("owned-message") ? ownedMessageNode : null,
      );
      const querySelectorAll = vi.fn((selector: string) =>
        selector.includes("conversation-turn") ? [ownedOuterTurn, foreignOuterTurn] : [],
      );
      const expression = buildCopyExpressionForTest({ messageId: "owned-message" });
      const run = Function(
        "document",
        "navigator",
        "window",
        "EventTarget",
        "MouseEvent",
        "CSS",
        `return ${expression};`,
      ) as (
        document: {
          querySelector: typeof querySelector;
          querySelectorAll: typeof querySelectorAll;
        },
        navigator: { clipboard: typeof clipboard },
        window: object,
        eventTarget: typeof EventTarget,
        mouseEvent: typeof FakeMouseEvent,
        css: undefined,
      ) => Promise<{ success: boolean; markdown: string }>;

      const pending = run(
        { querySelector, querySelectorAll },
        { clipboard },
        {},
        EventTarget,
        FakeMouseEvent,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(700);

      await expect(pending).resolves.toMatchObject({
        success: true,
        markdown: "Owned **markdown**",
      });
      expect(ownedButton.dispatchSpy).toHaveBeenCalledWith("click");
      expect(foreignButton.dispatchSpy).not.toHaveBeenCalled();
      expect(querySelectorAll).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("bound copy capture retains validated text when the snapshot has no source id", async () => {
    const evaluate = vi.fn();
    const logger = vi.fn();

    await expect(
      captureAssistantMarkdown({ evaluate } as never, {}, logger as never, {
        requireSourceIdentity: true,
      }),
    ).resolves.toBeNull();

    expect(evaluate).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("retaining the validated text"));
  });

  test("user-turn attachment expression requires non-empty prompt text for prefix fallback", () => {
    const expression = buildUserTurnAttachmentExpressionForTest({
      expectedPromptPrefix: "expected prompt text",
    });
    expect(expression).toContain("const textPrefix = text.slice");
    expect(expression).toContain("text.length > 0");
    expect(expression).toContain("textPrefix.length > 0");
  });
});
