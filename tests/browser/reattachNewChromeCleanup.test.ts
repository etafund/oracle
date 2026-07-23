import { access, rm } from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

vi.mock("../../src/browser/chromeLifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/chromeLifecycle.js")>();
  return {
    ...actual,
    launchChrome: vi.fn(),
    connectToChrome: vi.fn(),
  };
});

vi.mock("../../src/browser/pageActions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/pageActions.js")>();
  return {
    ...actual,
    navigateToChatGPT: vi.fn(async () => undefined),
    ensureNotBlocked: vi.fn(async () => undefined),
    ensureLoggedIn: vi.fn(async () => undefined),
    ensurePromptReady: vi.fn(async () => undefined),
  };
});

vi.mock("../../src/browser/cookies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/browser/cookies.js")>();
  return {
    ...actual,
    clearStaleChatGptConversationCookies: vi.fn(async () => undefined),
    syncCookies: vi.fn(async () => 0),
  };
});

import { connectToChrome, launchChrome } from "../../src/browser/chromeLifecycle.js";
import {
  ensureLoggedIn,
  ensureNotBlocked,
  ensurePromptReady,
  navigateToChatGPT,
} from "../../src/browser/pageActions.js";
import { resumeBrowserSession } from "../../src/browser/reattach.js";

const conversationUrl = "https://chatgpt.com/c/fallback-cleanup";

function fakeClient(close: ReturnType<typeof vi.fn>): ChromeClient {
  return {
    Network: {},
    Page: {},
    DOM: { enable: vi.fn(async () => undefined) },
    Target: {},
    Runtime: {
      enable: vi.fn(async () => undefined),
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: expression === "location.href" ? conversationUrl : 0,
        },
      })),
    },
    close,
  } as unknown as ChromeClient;
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.sequential("fallback reattach Chrome cleanup", () => {
  beforeEach(() => {
    vi.mocked(launchChrome).mockReset();
    vi.mocked(connectToChrome).mockReset();
    vi.mocked(navigateToChatGPT).mockReset().mockResolvedValue(undefined);
    vi.mocked(ensureNotBlocked).mockReset().mockResolvedValue(undefined);
    vi.mocked(ensureLoggedIn).mockReset().mockResolvedValue(undefined);
    vi.mocked(ensurePromptReady).mockReset().mockResolvedValue(undefined);
  });

  test("force-closes Chrome and removes its temporary profile after a late capture failure", async () => {
    const kill = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.mocked(launchChrome).mockResolvedValue({ port: 9222, kill } as never);
    vi.mocked(connectToChrome).mockResolvedValue(fakeClient(close));
    const waitForAssistantResponse = vi.fn(async () => {
      throw new Error("late response capture failed");
    });

    await expect(
      resumeBrowserSession(
        { tabUrl: conversationUrl, conversationId: "fallback-cleanup" },
        { cookieSync: false, keepBrowser: true, manualLogin: false },
        vi.fn() as BrowserLogger,
        { waitForAssistantResponse },
      ),
    ).rejects.toThrow("late response capture failed");

    const profileDir = vi.mocked(launchChrome).mock.calls[0]?.[1];
    expect(profileDir).toEqual(expect.stringContaining("oracle-reattach-"));
    expect(close).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    await expectMissing(profileDir!);
  });

  test("force-closes Chrome when connecting to its DevTools endpoint fails", async () => {
    const kill = vi.fn(async () => undefined);
    vi.mocked(launchChrome).mockResolvedValue({ port: 9222, kill } as never);
    vi.mocked(connectToChrome).mockRejectedValue(new Error("DevTools connect failed"));

    await expect(
      resumeBrowserSession(
        { tabUrl: conversationUrl, conversationId: "fallback-cleanup" },
        { cookieSync: false, keepBrowser: true, manualLogin: false },
        vi.fn() as BrowserLogger,
      ),
    ).rejects.toThrow("DevTools connect failed");

    const profileDir = vi.mocked(launchChrome).mock.calls[0]?.[1];
    expect(kill).toHaveBeenCalledOnce();
    await expectMissing(profileDir!);
  });

  test("preserves only an explicit headful keep-browser challenge for manual resolution", async () => {
    const kill = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.mocked(launchChrome).mockResolvedValue({ port: 9222, kill } as never);
    vi.mocked(connectToChrome).mockResolvedValue(fakeClient(close));
    vi.mocked(ensureNotBlocked).mockRejectedValueOnce(
      new BrowserAutomationError("Cloudflare challenge", {
        stage: "cloudflare-challenge",
        retryable: false,
      }),
    );
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(
        { tabUrl: conversationUrl, conversationId: "fallback-cleanup" },
        {
          cookieSync: false,
          headless: false,
          keepBrowser: true,
          manualLogin: false,
        },
        logger,
      ),
    ).rejects.toThrow("Cloudflare challenge");

    const profileDir = vi.mocked(launchChrome).mock.calls[0]?.[1];
    expect(close).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("manual challenge resolution"));
    await expect(access(profileDir!)).resolves.toBeUndefined();
    await rm(profileDir!, { recursive: true, force: true });
  });

  test("does not preserve an ordinary headful navigation failure", async () => {
    const kill = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.mocked(launchChrome).mockResolvedValue({ port: 9222, kill } as never);
    vi.mocked(connectToChrome).mockResolvedValue(fakeClient(close));
    vi.mocked(navigateToChatGPT).mockRejectedValueOnce(new Error("navigation failed"));

    await expect(
      resumeBrowserSession(
        { tabUrl: conversationUrl, conversationId: "fallback-cleanup" },
        {
          cookieSync: false,
          headless: false,
          keepBrowser: true,
          manualLogin: false,
        },
        vi.fn() as BrowserLogger,
      ),
    ).rejects.toThrow("navigation failed");

    const profileDir = vi.mocked(launchChrome).mock.calls[0]?.[1];
    expect(close).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    await expectMissing(profileDir!);
  });
});
