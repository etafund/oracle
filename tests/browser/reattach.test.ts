import { describe, expect, test, vi } from "vitest";
import {
  resumeBrowserSession,
  resumeBrowserSessionInIsolatedFleetTab,
  __test__,
} from "../../src/browser/reattach.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

type FakeTarget = { id?: string; targetId?: string; type?: string; url?: string };
type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
    }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Page?: { enable: () => void };
  close: () => Promise<void> | void;
};

describe("resumeBrowserSession", () => {
  test("strict recovery refuses prefix-only evidence before touching Chrome", async () => {
    const listTargets = vi.fn(async () => []);

    await expect(
      resumeBrowserSession(
        {
          chromePort: 51559,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/strict-recovery",
          conversationId: "strict-recovery",
          promptSubmitted: true,
        },
        { timeoutMs: 2_000 },
        vi.fn() as BrowserLogger,
        {
          promptPreview: "only a short saved prefix",
          requirePromptPreviewMatch: true,
          listTargets,
        },
      ),
    ).rejects.toThrow(/no exact rendered user-turn identity digest/i);

    expect(listTargets).not.toHaveBeenCalled();
  });

  test("selects target and captures markdown via stubs", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("waits for an exact saved provisional target to expose its canonical route", async () => {
    const transientUrl = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
    const canonicalUrl = "https://chatgpt.com/c/canonical-after-submit";
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "submitted-target",
      tabUrl: transientUrl,
      conversationId: "WEB",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "submitted-target", type: "page", url: transientUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    let hrefReads = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        hrefReads += 1;
        return { result: { value: hrefReads === 1 ? transientUrl : canonicalUrl } };
      }
      if (expression === "1+1") return { result: { value: 2 } };
      if (expression.includes("const needles =")) return { result: { value: true } };
      if (expression.includes("const candidates = []")) {
        return {
          result: {
            value: {
              latestUserIndex: 0,
              candidates: [{ index: 0, domIdentities: ["saved provisional prompt"] }],
            },
          },
        };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "generated answer",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "generated answer");
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, logger, {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        promptPreview: "saved provisional prompt",
      }),
    ).resolves.toMatchObject({ answerMarkdown: "generated answer" });

    expect(
      evaluate.mock.calls.some(([params]) => params.expression.includes("const preferProjects =")),
    ).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("waiting for the canonical URL"));
    expect(waitForAssistantResponse).toHaveBeenCalledWith(
      expect.anything(),
      2_000,
      logger,
      0,
      "canonical-after-submit",
      undefined,
    );
  });

  test("requires prompt proof when a provisional target becomes canonical", async () => {
    const transientUrl = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
    const canonicalUrl = "https://chatgpt.com/c/unrelated-canonical";
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "submitted-target",
      tabUrl: transientUrl,
      conversationId: "WEB",
    };
    const listTargets = vi.fn(async () => [
      { targetId: "submitted-target", type: "page", url: canonicalUrl },
    ]);
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") return { result: { value: canonicalUrl } };
      if (expression === "1+1") return { result: { value: 2 } };
      if (expression.includes("const needles =")) return { result: { value: true } };
      if (expression.includes("const needle =")) return { result: { value: 0 } };
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const recoverSession = vi.fn(async () => ({
      answerText: "wrong answer",
      answerMarkdown: "wrong answer",
    }));

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, vi.fn() as BrowserLogger, {
        listTargets,
        connect,
        recoverSession,
      }),
    ).rejects.toThrow(/no prompt preview to prove conversation ownership/i);
    expect(recoverSession).not.toHaveBeenCalled();

    const waitForAssistantResponse = vi.fn(async () => ({
      text: "owned answer",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "owned answer");
    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, vi.fn() as BrowserLogger, {
        listTargets,
        connect,
        recoverSession,
        promptPreview: "saved provisional prompt",
        waitForAssistantResponse,
        captureAssistantMarkdown,
      }),
    ).resolves.toMatchObject({ answerMarkdown: "owned answer" });
  });

  test("fails closed when a provisional route no longer has its exact Chrome target", async () => {
    const transientUrl = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      tabUrl: transientUrl,
      conversationId: "WEB",
    };
    const listTargets = vi.fn(async () => [
      { targetId: "unrelated", type: "page", url: "https://chatgpt.com/c/unrelated" },
    ]);
    const recoverSession = vi.fn(async () => ({
      answerText: "wrong answer",
      answerMarkdown: "wrong answer",
    }));
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(runtime, {}, logger, { listTargets, recoverSession }),
    ).rejects.toThrow(/refusing to attach to an arbitrary tab/i);
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("fails closed when only a provisional route remains after Chrome exits", async () => {
    const recoverSession = vi.fn(async () => ({
      answerText: "wrong answer",
      answerMarkdown: "wrong answer",
    }));

    await expect(
      resumeBrowserSession(
        {
          tabUrl: "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
          conversationId: "WEB",
        },
        {},
        vi.fn() as BrowserLogger,
        { recoverSession },
      ),
    ).rejects.toThrow(/refusing to recover an arbitrary conversation/i);
    await expect(
      resumeBrowserSession({ conversationId: "WEB" }, {}, vi.fn() as BrowserLogger, {
        recoverSession,
      }),
    ).rejects.toThrow(/refusing to recover an arbitrary conversation/i);
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("uses prompt preview turn index when reattaching to an already-open answer", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("const candidates = []")) {
        return {
          result: {
            value: {
              latestUserIndex: 3,
              candidates: [{ index: 3, domIdentities: ["live reattach pro 123"] }],
            },
          },
        };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "live reattach pro 123",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "live reattach pro 123");
    const logger = vi.fn() as BrowserLogger;

    await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      promptPreview: "live reattach pro 123",
    });

    expect(waitForAssistantResponse).toHaveBeenCalledWith(
      expect.anything(),
      2000,
      logger,
      3,
      "abc",
      undefined,
    );
  });

  test("fails closed when the reattach target drifts after response capture", async () => {
    const expectedUrl = "https://chatgpt.com/c/expected-thread";
    let currentUrl = expectedUrl;
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: expectedUrl,
    };
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: expectedUrl },
    ]);
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") return { result: { value: currentUrl } };
      if (expression === "1+1") return { result: { value: 2 } };
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({
      Runtime: { enable: vi.fn(), evaluate },
      DOM: { enable: vi.fn() },
      close,
    })) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => {
      currentUrl = "https://chatgpt.com/c/foreign-thread";
      return {
        text: "foreign answer",
        html: "",
        meta: { messageId: "foreign-message", turnId: "conversation-turn-3" },
      };
    });
    const captureAssistantMarkdown = vi.fn(async () => "foreign answer");
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback",
    }));

    await expect(
      resumeBrowserSession(runtime, { timeoutMs: 2_000 }, vi.fn() as BrowserLogger, {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        recoverSession,
      }),
    ).rejects.toThrow(/expected conversation expected-thread.*foreign-thread/i);

    expect(waitForAssistantResponse).toHaveBeenCalledWith(
      expect.anything(),
      2_000,
      expect.anything(),
      expect.anything(),
      "expected-thread",
      undefined,
    );
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("uses Deep Research completion path when reattaching research sessions", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("querySelectorAll")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Page: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "Deep report body",
      html: "<p>Deep report body</p>",
      meta: { turnId: null, messageId: null },
    }));
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForDeepResearchCompletion,
      },
    );

    expect(result.answerMarkdown).toBe("Deep report body");
    expect(waitForDeepResearchCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ evaluate }),
      logger,
      2000,
      2,
      expect.any(Object),
      expect.any(Object),
      {
        requireScopedTargetOwner: true,
      },
    );
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = {
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/tmp/oracle-attach-running-profile",
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "target-2",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-2", type: "page", url: "https://chatgpt.com/c/abc" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("attached-md");
    expect(listTargets).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
  });

  test("closes the attached client before falling back to recovery", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(async () => {
      return [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[];
    }) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => {
      throw new Error("response timeout");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      recoverSession,
    });

    expect(result.answerText).toBe("fallback");
    expect(close).toHaveBeenCalledOnce();
    expect(recoverSession).toHaveBeenCalled();
  });
});

describe("isolated fleet recovery target ownership", () => {
  const runtime = {
    tabUrl: "https://chatgpt.com/c/recovery-thread",
    conversationId: "recovery-thread",
    promptSubmitted: true as const,
  };

  function createHarness(recoveryError: unknown, headless = false) {
    const release = vi.fn(async () => {});
    const update = vi.fn(async () => {});
    const closeRemoteChromeTargetFn = vi.fn(async () => true);
    const closeClient = vi.fn(async () => {});
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "document.readyState") {
        return { result: { value: "complete" } };
      }
      return {
        result: {
          value: {
            url: runtime.tabUrl,
            title: "ChatGPT",
            interstitialTitle: false,
            interstitialScript: false,
            interstitialUrlMarker: false,
            bodySample: "",
            composerPresent: true,
            composerVisible: true,
            loginCtaVisible: false,
            onAuthPath: false,
            accountSignal: true,
          },
        },
      };
    });
    const client = {
      Runtime: { enable: vi.fn(async () => {}), evaluate },
      Page: { enable: vi.fn(async () => {}), navigate: vi.fn(async () => ({})) },
      close: closeClient,
    } as unknown as ChromeClient;
    const resumeBrowserSessionFn = vi.fn(async () => {
      throw recoveryError;
    }) as unknown as typeof resumeBrowserSession;

    const run = () =>
      resumeBrowserSessionInIsolatedFleetTab({
        runtime,
        config: { headless, timeoutMs: 2_000 },
        logger: vi.fn() as BrowserLogger,
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        profileDir: "/profiles/account-one",
        promptPreview: "saved recovery prompt",
        promptDomSha256: "a".repeat(64),
        accountId: `isolated-recovery-test-${process.pid}`,
        connectWithNewTabFn: vi.fn(async () => ({
          client,
          targetId: "recovery-target-1",
        })),
        acquireBrowserTabLeaseFn: vi.fn(async () => ({
          id: "lease-recovery-1",
          release,
          update,
        })),
        closeRemoteChromeTargetFn,
        resumeBrowserSessionFn,
      });

    return { closeClient, closeRemoteChromeTargetFn, release, run, update };
  }

  test.each([
    { stage: "cloudflare-challenge" },
    { stage: "account-quarantine" },
    { stage: "challenge-gate", state: "verification_interstitial" },
    { stage: "challenge-gate", state: "account_security_block" },
  ])("preserves the exact target and active lease for canonical challenge %#", async (details) => {
    const challenge = new BrowserAutomationError("Manual verification required.", {
      ...details,
      retryable: false,
    });
    const harness = createHarness(challenge);

    const thrown = await harness.run().catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(BrowserAutomationError);
    expect((thrown as BrowserAutomationError).details).toMatchObject({
      ...details,
      recoveryTargetPreserved: true,
      runtime: {
        browserTransport: "cdp",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeProfileRoot: "/profiles/account-one",
        chromeTargetId: "recovery-target-1",
        tabUrl: runtime.tabUrl,
        conversationId: runtime.conversationId,
        promptSubmitted: true,
      },
    });
    expect(harness.closeRemoteChromeTargetFn).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
    expect(harness.update).toHaveBeenCalledWith(
      expect.objectContaining({ chromeTargetId: "recovery-target-1" }),
    );
  });

  test("still closes the owned target before releasing its lease after an ordinary failure", async () => {
    const harness = createHarness(new Error("ordinary recovery failure"));

    await expect(harness.run()).rejects.toThrow("ordinary recovery failure");

    expect(harness.closeRemoteChromeTargetFn).toHaveBeenCalledOnce();
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.closeRemoteChromeTargetFn.mock.invocationCallOrder[0]).toBeLessThan(
      harness.release.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  test("does not preserve a headless challenge target that a human cannot inspect", async () => {
    const challenge = new BrowserAutomationError("Headless verification required.", {
      stage: "cloudflare-challenge",
      retryable: false,
    });
    const harness = createHarness(challenge, true);

    const thrown = await harness.run().catch((error: unknown) => error);

    expect(thrown).toBe(challenge);
    expect(harness.closeRemoteChromeTargetFn).toHaveBeenCalledOnce();
    expect(harness.release).toHaveBeenCalledOnce();
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    openConversationFromSidebar,
    waitForPromptPreview,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  async function sidebarExpression(
    conversationId?: string,
    promptPreview = "saved prompt",
  ): Promise<string> {
    let source = "";
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        source = expression;
        return { result: { value: { ok: false } } };
      }),
    } as unknown as ChromeClient["Runtime"];
    await openConversationFromSidebar(runtime, {
      conversationId,
      preferProjects: false,
      promptPreview,
    });
    return source;
  }

  function executeSidebarExpression(
    source: string,
    entries: Array<string | { href: string; text?: string; testId?: string }>,
  ) {
    const elements = entries.map((entry) => {
      const href = typeof entry === "string" ? entry : entry.href;
      const textContent = typeof entry === "string" ? entry : (entry.text ?? href);
      const testId = typeof entry === "string" ? "" : (entry.testId ?? "");
      const state = { clicked: false };
      return {
        state,
        textContent,
        dataset: {},
        getAttribute: (name: string) => {
          if (name === "href") return href;
          if (name === "data-testid") return testId;
          return "";
        },
        closest(selector: string) {
          return selector === "nav,aside" ? null : this;
        },
        getBoundingClientRect: () => ({ width: 10, height: 10 }),
        scrollIntoView: () => {},
        dispatchEvent: () => {
          state.clicked = true;
        },
      };
    });
    const document = { body: {}, querySelector: () => null, querySelectorAll: () => elements };
    const location = { origin: "https://chatgpt.com", href: "https://chatgpt.com/" };
    class FakeMouseEvent {}
    const result = Function(
      "document",
      "location",
      "window",
      "MouseEvent",
      `return ${source}`,
    )(document, location, {}, FakeMouseEvent);
    return {
      result,
      clicked: elements.map((element) => element.state.clicked),
      href: location.href,
    };
  }

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/WEB")).toBeUndefined();
    expect(
      extractConversationIdFromUrl(
        "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
      ),
    ).toBeUndefined();
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3" },
        "https://chatgpt.com/",
      ),
    ).toBeNull();
    expect(buildConversationUrl({ conversationId: "WEB" }, "https://chatgpt.com/")).toBeNull();
    expect(
      buildConversationUrl(
        {
          tabUrl: "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
          conversationId: "canonical-123",
        },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/canonical-123");
  });

  test("pickTarget prefers a saved conversation over a stale target id", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(pickTarget(targets, { chromeTargetId: "t-2" })).toEqual(targets[1]);
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-2",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual(targets[0]);
    expect(pickTarget(targets, {})).toEqual(targets[0]);
  });

  test("only trusts an exact target id for a provisional conversation route", () => {
    const transientUrl = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
    const targets = [
      { targetId: "other", type: "page", url: transientUrl },
      { targetId: "submitted", type: "page", url: transientUrl },
    ];

    expect(pickTarget(targets, { tabUrl: transientUrl, conversationId: "WEB" })).toBeUndefined();
    expect(pickTarget(targets, { conversationId: "WEB" })).toBeUndefined();
    expect(
      pickTarget(targets, {
        chromeTargetId: "submitted",
        tabUrl: transientUrl,
        conversationId: "WEB",
      }),
    ).toEqual(targets[1]);
    expect(
      pickTarget(
        [{ targetId: "canonical", type: "page", url: "https://chatgpt.com/c/canonical-123" }],
        { conversationId: "WEB", tabUrl: "https://chatgpt.com/c/canonical-123" },
      ),
    ).toMatchObject({ targetId: "canonical" });
  });

  test("pickTarget keeps the saved target among duplicate conversation tabs", () => {
    const targets = [
      { targetId: "duplicate", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "submitted", type: "page", url: "https://chatgpt.com/c/same" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "submitted",
        conversationId: "same",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget understands CDP list ids", () => {
    const targets = [
      { id: "page-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "page-2", type: "page", url: "about:blank" },
    ];

    expect(pickTarget(targets, { chromeTargetId: "page-1" })).toEqual(targets[0]);
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn(async ({ expression }: EvaluateParams) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/c/abc" } };
      }
      return { result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } } };
    });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });

  test("openConversationFromSidebar handles missing conversationId", async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("openConversationFromSidebar rejects a clicked destination with the wrong durable id", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/c/wrong" } };
      }
      return {
        result: {
          value: { ok: true, href: "https://chatgpt.com/c/expected", count: 1 },
        },
      };
    });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    await expect(
      openConversationFromSidebar(
        runtime,
        { conversationId: "expected", preferProjects: false },
        0,
        0,
      ),
    ).resolves.toBe(false);
  });

  test("prompt ownership proof requires text in an actual user turn", async () => {
    const runtimeFor = (userTexts: string[], genericPageText: string) => {
      const userTurns = userTexts.map((text) => ({ innerText: text, textContent: text }));
      const root = {
        innerText: genericPageText,
        textContent: genericPageText,
        querySelectorAll: (selector: string) =>
          selector.includes('data-message-author-role="user"') ? userTurns : [],
      };
      const document = {
        querySelector: (selector: string) => (selector === "main" ? root : null),
      };
      return {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function("document", `return ${expression}`)(document),
          },
        })),
      } as unknown as ChromeClient["Runtime"];
    };

    await expect(
      waitForPromptPreview(runtimeFor([], "saved ownership prompt"), "saved ownership prompt", 20),
    ).resolves.toBe(false);
    await expect(
      waitForPromptPreview(
        runtimeFor(["Saved   ownership\nprompt"], ""),
        "saved ownership prompt",
        1_000,
      ),
    ).resolves.toBe(true);
  });

  test("sidebar fallback skips a provisional WEB route", async () => {
    const transient = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
    const canonical = "https://chatgpt.com/c/canonical-123";

    const outcome = executeSidebarExpression(await sidebarExpression(), [
      { href: transient, text: "saved prompt" },
      { href: canonical, text: "saved prompt" },
    ]);

    expect(outcome.clicked).toEqual([false, true]);
    expect(outcome.href).toBe(canonical);
  });

  test("sidebar prompt-only recovery normalizes Markdown and requires a durable href", async () => {
    const markdownPreview =
      "# Saved ownership heading\n\n- First   detail\n- `second detail` and more context";
    const renderedTitle = "Saved ownership heading First detail second detail";
    const canonical = "https://chatgpt.com/c/canonical-markdown";
    const outcome = executeSidebarExpression(await sidebarExpression(undefined, markdownPreview), [
      { href: "/", text: renderedTitle },
      { href: canonical, text: `${renderedTitle}…` },
    ]);

    expect(outcome.clicked).toEqual([false, true]);
    expect(outcome.href).toBe(canonical);
  });

  test("sidebar prompt and test-id fallbacks do not select a provisional route", async () => {
    const transient = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
    const outcome = executeSidebarExpression(await sidebarExpression(), [
      { href: transient, text: "saved prompt", testId: "conversation-history-item" },
    ]);

    expect(outcome.result).toMatchObject({ ok: false });
    expect(outcome.clicked).toEqual([false]);
    expect(outcome.href).toBe("https://chatgpt.com/");
  });

  test("sidebar matching compares the complete conversation id", async () => {
    const outcome = executeSidebarExpression(await sidebarExpression("abc"), [
      "https://chatgpt.com/c/abc-extra",
      "https://chatgpt.com/c/abc",
    ]);

    expect(outcome.clicked).toEqual([false, true]);
    expect(outcome.href).toBe("https://chatgpt.com/c/abc");
  });
});
