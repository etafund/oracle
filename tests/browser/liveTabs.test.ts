import { describe, expect, test } from "vitest";
import {
  buildTabInspectionExpressionForTest,
  classifyTabState,
  formatBrowserTabState,
  isChatGptConversationUrlForTest,
  isChatGptUrlForTest,
  resolveChatGptTabFromSummariesForTest,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

function makeTab(overrides: Partial<ChatGptTabSummary> = {}): ChatGptTabSummary {
  return {
    targetId: "target-1",
    title: "ChatGPT",
    url: "https://chatgpt.com/c/abc",
    currentModelLabel: "ChatGPT + Pro",
    stopExists: false,
    sendExists: true,
    promptReady: true,
    loginButtonExists: false,
    authenticated: true,
    assistantCount: 1,
    lastAssistantText: "Answer",
    assistantFollowsLatestUser: true,
    lastAssistantTurnIndex: 1,
    lastUserTurnIndex: 0,
    lastAssistantSnippet: "Answer",
    lastUserText: "Question",
    lastUserSnippet: "Question",
    focused: true,
    visibilityState: "visible",
    conversationId: "abc",
    fingerprint: "fp",
    state: "completed",
    lastAssistantMarkdown: "Answer",
    ...overrides,
  };
}

describe("liveTabs helpers", () => {
  test("excludes fallback answer nodes contained by the latest user turn", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("!lastUserTurn.contains?.(node)");
    expect(expression).toContain("!node.contains?.(lastUserTurn)");
    expect(expression).toContain("assistantCandidates.reduce");
  });

  test("classifies running/completed/detached states", () => {
    expect(
      classifyTabState({
        authenticated: true,
        stopExists: true,
        sendExists: false,
        promptReady: false,
        assistantCount: 0,
      }),
    ).toBe("running");
    expect(
      classifyTabState({
        authenticated: true,
        stopExists: false,
        sendExists: true,
        promptReady: true,
        assistantCount: 1,
      }),
    ).toBe("completed");
    expect(
      classifyTabState({
        authenticated: true,
        stopExists: false,
        sendExists: true,
        promptReady: true,
        assistantCount: 1,
        answerNowExists: true,
      }),
    ).toBe("running");
    expect(
      classifyTabState({
        authenticated: true,
        stopExists: false,
        sendExists: true,
        promptReady: true,
        assistantCount: 1,
        thinkingActive: true,
      }),
    ).toBe("running");
    expect(
      classifyTabState({
        authenticated: false,
        stopExists: false,
        sendExists: false,
        promptReady: false,
        assistantCount: 0,
      }),
    ).toBe("detached");
  });

  test("formats the stored state when present", () => {
    expect(formatBrowserTabState(makeTab({ state: "stalled" }))).toBe("stalled");
  });

  test("resolves current/id/url/conversation/title refs against live tabs", () => {
    const tabs = [
      makeTab({
        targetId: "target-1",
        title: "Review A",
        url: "https://chatgpt.com/c/a",
        conversationId: "a",
      }),
      makeTab({
        targetId: "target-2",
        title: "Review B",
        url: "https://chatgpt.com/c/b",
        conversationId: "b",
      }),
    ];
    expect(resolveChatGptTabFromSummariesForTest(tabs, "current").targetId).toBe("target-1");
    expect(resolveChatGptTabFromSummariesForTest(tabs, "target-2").url).toBe(
      "https://chatgpt.com/c/b",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "https://chatgpt.com/c/a").targetId).toBe(
      "target-1",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "b").targetId).toBe("target-2");
    expect(resolveChatGptTabFromSummariesForTest(tabs, "Review B").targetId).toBe("target-2");
  });

  test("throws on ambiguous title matches", () => {
    const tabs = [
      makeTab({ targetId: "target-1", title: "Routing Review", url: "https://chatgpt.com/c/a" }),
      makeTab({
        targetId: "target-2",
        title: "Routing Review Followup",
        url: "https://chatgpt.com/c/b",
      }),
    ];
    expect(() => resolveChatGptTabFromSummariesForTest(tabs, "Routing Review")).toThrow(
      /Multiple ChatGPT tabs match/i,
    );
  });

  test("isChatGptUrl matches canonical ChatGPT hosts and rejects look-alikes", () => {
    // Canonical hosts
    expect(isChatGptUrlForTest("https://chatgpt.com/c/abc")).toBe(true);
    expect(isChatGptUrlForTest("https://chat.openai.com/c/abc")).toBe(true);
    expect(isChatGptUrlForTest("HTTPS://CHATGPT.COM/c/abc")).toBe(true);
    expect(isChatGptUrlForTest("  https://chatgpt.com/  ")).toBe(true);
    expect(isChatGptUrlForTest("https://chatgpt.com:443/c/abc")).toBe(true);

    // Prefix-confusion attacks must NOT match
    expect(isChatGptUrlForTest("https://chatgpt.com.evil.example/c/abc")).toBe(false);
    expect(isChatGptUrlForTest("https://chatgpt.com-evil.example/c/abc")).toBe(false);
    expect(isChatGptUrlForTest("https://chat.openai.com.fake.test/c/abc")).toBe(false);
    expect(isChatGptUrlForTest("https://chatgpt.com@evil.example/c/abc")).toBe(false);

    // Subdomains that aren't part of the canonical ChatGPT product
    expect(isChatGptUrlForTest("https://www.chatgpt.com/c/abc")).toBe(false);
    expect(isChatGptUrlForTest("https://api.chatgpt.com/c/abc")).toBe(false);

    // Wrong schemes / malformed
    expect(isChatGptUrlForTest("http://chatgpt.com/c/abc")).toBe(true);
    expect(isChatGptUrlForTest("ftp://chatgpt.com/c/abc")).toBe(false);
    expect(isChatGptUrlForTest("javascript:alert(1)")).toBe(false);
    expect(isChatGptUrlForTest("")).toBe(false);
    expect(isChatGptUrlForTest("not-a-url")).toBe(false);
  });

  test("conversation scoring only recognizes durable canonical ChatGPT identities", () => {
    expect(isChatGptConversationUrlForTest("https://chatgpt.com/c/abc_123-def")).toBe(true);
    expect(isChatGptConversationUrlForTest("https://chat.openai.com/c/legacy-id")).toBe(true);

    expect(isChatGptConversationUrlForTest("https://chatgpt.com/c/WEB")).toBe(false);
    expect(
      isChatGptConversationUrlForTest(
        "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
      ),
    ).toBe(false);
    expect(isChatGptConversationUrlForTest("https://example.com/c/abc_123-def")).toBe(false);
    expect(isChatGptConversationUrlForTest("https://chatgpt.com/?next=/c/abc_123-def")).toBe(false);
  });

  test("matches sessions by target id, url, and conversation id", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "target-1",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        },
      },
    } as SessionMetadata;
    expect(
      sessionMatchesTab(meta, {
        host: "127.0.0.1",
        port: 9222,
        targetId: "target-1",
        url: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      }),
    ).toBe(true);
    expect(
      sessionMatchesTab(meta, {
        host: "127.0.0.1",
        port: 9222,
        targetId: "target-2",
        url: "https://chatgpt.com/c/def",
        conversationId: "def",
      }),
    ).toBe(false);
  });

  test("does not match a different tab by a provisional WEB URL", () => {
    const transientUrl = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
    const meta = {
      id: "session-1",
      createdAt: "2026-07-21T00:00:00.000Z",
      status: "running",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeTargetId: "submitted-target",
          tabUrl: transientUrl,
          conversationId: "WEB",
        },
      },
    } as SessionMetadata;

    expect(
      sessionMatchesTab(meta, {
        targetId: "different-target",
        url: transientUrl,
        conversationId: "WEB",
      }),
    ).toBe(false);
    expect(sessionMatchesTab(meta, { targetId: "submitted-target", url: transientUrl })).toBe(true);
  });
});
