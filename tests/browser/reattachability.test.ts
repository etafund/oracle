import { describe, expect, test } from "vitest";
import {
  hasRecoverableChatGptConversation,
  isRecoverableChatGptConversationUrl,
} from "../../src/browser/reattachability.js";

describe("hasRecoverableChatGptConversation", () => {
  test("accepts explicit conversation ids", () => {
    expect(hasRecoverableChatGptConversation({ conversationId: "abc" })).toBe(true);
  });

  test("accepts ChatGPT conversation URLs", () => {
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/c/abc123" })).toBe(
      true,
    );
    expect(
      hasRecoverableChatGptConversation({
        tabUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc123",
      }),
    ).toBe(true);
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chat.openai.com/c/abc123" })).toBe(
      true,
    );
  });

  test("rejects ChatGPT home and project shell URLs", () => {
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/" })).toBe(false);
    expect(
      hasRecoverableChatGptConversation({
        tabUrl: "https://chatgpt.com/g/g-p-demo/project",
      }),
    ).toBe(false);
    expect(
      hasRecoverableChatGptConversation({
        tabUrl: "https://chatgpt.com/c/WEB:32229414-5afa-4478-890c-9ca80aa82430",
      }),
    ).toBe(false);
  });

  test("rejects malformed or non-ChatGPT URLs", () => {
    expect(hasRecoverableChatGptConversation({ tabUrl: "not a url" })).toBe(false);
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://example.com/c/abc" })).toBe(false);
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/?next=/c/abc" })).toBe(
      false,
    );
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/#/c/abc" })).toBe(
      false,
    );
  });

  test("rejects ChatGPT's transient WEB conversation identity", () => {
    const transient = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
    expect(isRecoverableChatGptConversationUrl(transient)).toBe(false);
    expect(hasRecoverableChatGptConversation({ tabUrl: transient })).toBe(false);
    expect(hasRecoverableChatGptConversation({ conversationId: "WEB" })).toBe(false);
    expect(
      hasRecoverableChatGptConversation({
        conversationId: "WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
      }),
    ).toBe(false);
  });
});
