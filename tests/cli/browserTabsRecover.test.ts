import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import { buildRemoteBrowserPreSubmitDiagnostic } from "../../src/remote/types.js";

const baseMeta = {
  id: "sess-recover",
  createdAt: "2026-05-26T00:00:00.000Z",
  status: "completed",
  options: {},
  mode: "browser",
  cwd: "/tmp/recover-cwd",
  browser: {
    config: {
      manualLogin: true,
      manualLoginProfileDir: "/tmp/recover-profile",
    },
    runtime: {
      chromeHost: "127.0.0.1",
      chromePort: 9223,
      tabUrl: "https://chatgpt.com/c/saved-conversation",
      conversationId: "saved-conversation",
    },
  },
} as unknown as SessionMetadata;

const completedHarvest = {
  targetId: "target-x",
  url: "https://chatgpt.com/c/saved-conversation",
  conversationId: "saved-conversation",
  state: "completed",
  authenticated: true,
  stopExists: false,
  sendExists: true,
  assistantCount: 1,
  currentModelLabel: "GPT-5.5 Pro",
  assistantFollowsLatestUser: true,
  lastAssistantTurnIndex: 1,
  lastUserTurnIndex: 0,
  lastAssistantMarkdown: "## Recovered answer\n\nFull response captured.",
  lastAssistantText: "Recovered answer. Full response captured.",
  lastAssistantSnippet: "Recovered answer.",
  lastUserSnippet: "original prompt",
} as const;

function storedPreSubmitError(): NonNullable<SessionMetadata["error"]> {
  const diagnostic = buildRemoteBrowserPreSubmitDiagnostic({
    stage: "model-selection",
    code: "protected-route-changed-after-preflight",
    guardReason: "exact-prompt-changed",
    exactPromptVerified: false,
    attachmentStateVerified: true,
    focusVerified: true,
    exactReadVerified: true,
    selectionRestored: true,
    focusPreserved: true,
  });
  if (!diagnostic) throw new Error("failed to build pre-submit diagnostic fixture");
  return {
    category: "browser-automation",
    message: "Protected browser pre-submit integrity proof failed; no prompt was submitted.",
    details: {
      stage: "remote-run",
      errorClass: "integrity_ui_unknown",
      retryable: false,
      preSubmitDiagnostic: diagnostic,
    },
  };
}

describe("harvestSessionBrowserOutput recovery fallback", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("retries via recoverConversationTab when initial harvest finds no live tab", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('No ChatGPT tab matched "https://chatgpt.com/c/saved-conversation".'),
      )
      .mockResolvedValueOnce(completedHarvest);

    const fakeChrome = { kill: vi.fn(), process: { unref: vi.fn() } };
    const recoverConversationTab = vi.fn(async (meta: SessionMetadata) => ({
      host: "127.0.0.1",
      port: 53999,
      url: meta.browser?.runtime?.tabUrl ?? "",
      ref: "saved-conversation",
      chrome: fakeChrome,
    }));

    const updateSession = vi.fn(async () => {});
    const readSession = vi.fn(async () => baseMeta);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession, updateSession },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(recoverConversationTab).toHaveBeenCalledWith(baseMeta, expect.any(Function), {
      existingEndpoint: { host: "127.0.0.1", port: 9223 },
    });
    // After recovery, harvest is retried against the recovered endpoint/url.
    expect(harvestChatGptTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 53999,
        ref: "saved-conversation",
      }),
    );
    expect(result.lastAssistantMarkdown).toBe(completedHarvest.lastAssistantMarkdown);
    expect(updateSession).toHaveBeenCalled();
    // Default closeAfterRecover is false — Chrome stays alive for the user.
    expect(fakeChrome.kill).not.toHaveBeenCalled();
    expect(fakeChrome.process.unref).toHaveBeenCalledTimes(1);
  });

  test("does not recover when recoverIfMissing is false; surfaces the original error", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched stuff"));
    const recoverConversationTab = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { recoverIfMissing: false, quietOutput: true }),
    ).rejects.toThrow(/No ChatGPT tab matched/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });

  test("recovers when the endpoint has no live ChatGPT tabs", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("No live ChatGPT tabs found on the configured Chrome DevTools endpoint."),
      )
      .mockResolvedValueOnce(completedHarvest);

    const recoverConversationTab = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 53998,
      url: "https://chatgpt.com/c/saved-conversation",
      ref: "saved-conversation",
      chrome: { kill: vi.fn() },
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
  });

  test("closes the recovered Chrome when closeAfterRecover is true", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched"))
      .mockResolvedValueOnce(completedHarvest);
    const fakeChrome = { kill: vi.fn(), process: { unref: vi.fn() } };
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 53777,
        url: "https://chatgpt.com/c/saved-conversation",
        ref: "saved-conversation",
        chrome: fakeChrome,
      })),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", {
      closeAfterRecover: true,
      quietOutput: true,
    });
    expect(fakeChrome.kill).toHaveBeenCalledTimes(1);
    expect(fakeChrome.process.unref).not.toHaveBeenCalled();
  });

  test("does not recover an explicit browser tab override", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched explicit-ref"));
    const recoverConversationTab = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {} },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", {
        browserTabRef: "explicit-ref",
        quietOutput: true,
      }),
    ).rejects.toThrow(/explicit-ref/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });

  test.each([
    ["successful", true],
    ["failed", false],
  ])(
    "refuses local harvest and live-tail for a %s remote run before any CDP access",
    async (_label, terminalDoneOk) => {
      const remoteMeta: SessionMetadata = {
        ...baseMeta,
        browser: {
          ...baseMeta.browser,
          remoteRun: {
            runId: "remote-run",
            accountId: "acct1",
            laneId: "acct1-9473",
            terminalDoneOk,
            provenance: null,
          },
        },
      };
      const harvestChatGptTab = vi.fn();
      const recoverConversationTab = vi.fn();
      const updateSession = vi.fn();

      vi.doMock("../../src/browser/liveTabs.js", () => ({
        collectChatGptTabs: vi.fn(),
        DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
        DEFAULT_REMOTE_CHROME_PORT: 9222,
        extractConversationIdFromUrl: () => null,
        formatBrowserTabState: () => "completed",
        harvestChatGptTab,
        sessionMatchesTab: () => false,
      }));
      vi.doMock("../../src/browser/recoverConversation.js", () => ({
        recoverConversationTab,
      }));
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: { readSession: async () => remoteMeta, updateSession },
      }));

      const { harvestSessionBrowserOutput, liveTailSessionBrowserOutput } =
        await import("../../src/cli/browserTabs.js");
      await expect(
        harvestSessionBrowserOutput(remoteMeta.id, { quietOutput: true }),
      ).rejects.toThrow(/remote browser account.*Refusing --harvest.*local\/default-CDP/i);
      await expect(liveTailSessionBrowserOutput(remoteMeta.id)).rejects.toThrow(
        /remote browser account.*Refusing --live.*local\/default-CDP/i,
      );
      expect(harvestChatGptTab).not.toHaveBeenCalled();
      expect(recoverConversationTab).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
    },
  );

  test("uses the terminal pre-submit refusal for harvest and live instead of account history", async () => {
    const remoteMeta: SessionMetadata = {
      ...baseMeta,
      status: "error",
      browser: {
        ...baseMeta.browser,
        remoteRun: {
          runId: "remote-pre-submit",
          accountId: "acct1",
          laneId: "acct1-9473",
          terminalDoneOk: false,
          provenance: null,
        },
      },
      error: storedPreSubmitError(),
    };
    const harvestChatGptTab = vi.fn();
    const recoverConversationTab = vi.fn();
    const updateSession = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => remoteMeta, updateSession },
    }));

    const { harvestSessionBrowserOutput, liveTailSessionBrowserOutput } =
      await import("../../src/cli/browserTabs.js");
    const harvestError = await harvestSessionBrowserOutput(remoteMeta.id, {
      quietOutput: true,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    const liveError = await liveTailSessionBrowserOutput(remoteMeta.id).then(
      () => null,
      (error: unknown) => error,
    );
    for (const error of [harvestError, liveError]) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/validated pre-submit.*no prompt was submitted/i);
      expect((error as Error).message).not.toMatch(/account.*history/i);
    }
    expect(harvestChatGptTab).not.toHaveBeenCalled();
    expect(recoverConversationTab).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });
});
