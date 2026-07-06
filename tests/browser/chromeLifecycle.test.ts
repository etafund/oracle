import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cdpNewMock = vi.fn();
const cdpCloseMock = vi.fn();
const cdpListMock = vi.fn();
const cdpVersionMock = vi.fn();
const cdpMock = Object.assign(vi.fn(), {
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  New: cdpNewMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  Close: cdpCloseMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  List: cdpListMock,
  // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
  Version: cdpVersionMock,
});

vi.mock("chrome-remote-interface", () => ({ default: cdpMock }));

vi.doMock("../../src/browser/profileState.js", async () => {
  const original = await vi.importActual<typeof import("../../src/browser/profileState.js")>(
    "../../src/browser/profileState.js",
  );
  return {
    ...original,
    cleanupStaleProfileState: vi.fn(async () => undefined),
  };
});

describe("registerTerminationHooks", () => {
  test("kills Chrome and removes a copied profile on an in-flight signal", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "oracle-copy-profile-signal-"));
    await writeFile(path.join(userDataDir, "Cookies"), "sensitive");
    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const emitRuntimeHint = vi.fn().mockResolvedValue(undefined);
    const previousExitCode = process.exitCode;
    const removeHooks = registerTerminationHooks(
      chrome as unknown as import("chrome-launcher").LaunchedChrome,
      userDataDir,
      false,
      vi.fn() as unknown as import("../../src/browser/types.js").BrowserLogger,
      {
        isInFlight: () => true,
        emitRuntimeHint,
        forceProfileCleanup: true,
      },
    );

    try {
      process.emit("SIGTERM");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
          await stat(userDataDir)
            .then(() => false)
            .catch(() => true)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(chrome.kill).toHaveBeenCalledTimes(1);
      expect(emitRuntimeHint).not.toHaveBeenCalled();
      await expect(stat(userDataDir)).rejects.toThrow();
    } finally {
      removeHooks();
      process.exitCode = previousExitCode;
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("clears stale DevToolsActivePort hints when preserving userDataDir", async () => {
    const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
    const profileState = await import("../../src/browser/profileState.js");
    const cleanupMock = vi.mocked(profileState.cleanupStaleProfileState);

    const chrome = {
      kill: vi.fn().mockResolvedValue(undefined),
      pid: 1234,
      port: 9222,
    };
    const logger = vi.fn();
    const userDataDir = "/tmp/oracle-manual-login-profile";

    const removeHooks = registerTerminationHooks(
      chrome as unknown as import("chrome-launcher").LaunchedChrome,
      userDataDir,
      false,
      logger,
      {
        isInFlight: () => false,
        preserveUserDataDir: true,
      },
    );

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 10));

    removeHooks();

    expect(chrome.kill).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalledWith(userDataDir, logger, { lockRemovalMode: "never" });
  });
});

describe("copied-profile launch flags", () => {
  test("strips mock keychain flags while retaining custom-host launch flags", async () => {
    const { resolveChromeLaunchOptionsForTest } =
      await import("../../src/browser/chromeLifecycle.js");
    const options = resolveChromeLaunchOptionsForTest(
      ["--use-mock-keychain", "--password-store=basic", "--remote-debugging-address=0.0.0.0"],
      true,
    );

    expect(options.ignoreDefaultFlags).toBe(true);
    expect(options.chromeFlags).not.toContain("--use-mock-keychain");
    expect(options.chromeFlags).not.toContain("--password-store=basic");
    expect(options.chromeFlags).toContain("--remote-debugging-address=0.0.0.0");
  });
});

describe("connectWithNewTab", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
    cdpVersionMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("falls back to default target when new tab cannot be opened", async () => {
    cdpNewMock.mockRejectedValue(new Error("boom"));
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: "127.0.0.1" });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to open isolated browser tab"),
    );
  });

  test("closes unused tab when attach fails", async () => {
    cdpNewMock.mockResolvedValue({ id: "target-1" });
    cdpMock.mockRejectedValueOnce(new Error("attach fail")).mockResolvedValueOnce({});
    cdpCloseMock.mockResolvedValue(undefined);

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBeUndefined();
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, id: "target-1" });
    expect(cdpMock).toHaveBeenCalledWith({ port: 9222, host: "127.0.0.1" });
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("Failed to attach to isolated browser tab"),
    );
  });

  test("throws when strict mode disallows fallback", async () => {
    cdpNewMock.mockRejectedValue(new Error("boom"));

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await expect(
      connectWithNewTab(9222, logger, undefined, undefined, { fallbackToDefault: false }),
    ).rejects.toThrow(/isolated browser tab/i);
    expect(cdpMock).not.toHaveBeenCalled();
  });

  test("returns isolated target when attach succeeds", async () => {
    cdpNewMock.mockResolvedValue({ id: "target-2" });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe("target-2");
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, target: "target-2" });
  });

  // Regression: enableFocusEmulation only overrides document.hasFocus()/:focus,
  // not the Page Visibility API. CDP.New (`PUT /json/new`) always opens the new
  // tab inside Chrome's existing window, so under c>=2 the non-frontmost lane's
  // tab stayed `document.visibilityState === "hidden"` for its entire lifetime.
  // The isolated tab must therefore be created in its own OS window via a
  // browser-level Target.createTarget({newWindow: true}) when Chrome exposes a
  // browser WebSocket endpoint.
  test("opens the isolated tab in its own OS window via Target.createTarget({newWindow: true})", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/abc";
    cdpVersionMock.mockResolvedValue({ webSocketDebuggerUrl: browserWSEndpoint });
    const createTargetMock = vi.fn().mockResolvedValue({ targetId: "window-target-1" });
    const browserCloseMock = vi.fn().mockResolvedValue(undefined);
    const browserClient = {
      // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
      Target: { createTarget: createTargetMock },
      close: browserCloseMock,
    };
    cdpMock.mockImplementation(async (options: { target?: string; local?: boolean }) => {
      if (options?.target === browserWSEndpoint) {
        return browserClient;
      }
      return {};
    });

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe("window-target-1");
    expect(createTargetMock).toHaveBeenCalledWith({ url: "about:blank", newWindow: true });
    // The same-window HTTP shortcut must not be used when the new-window path works.
    expect(cdpNewMock).not.toHaveBeenCalled();
    // The temporary browser-level connection is released after target creation.
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
    expect(cdpMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      target: "window-target-1",
    });
  });

  test("falls back to a same-window tab and logs the visibility limitation when the new-window path is unavailable", async () => {
    cdpVersionMock.mockRejectedValue(new Error("ancient chrome: no /json/version"));
    cdpNewMock.mockResolvedValue({ id: "same-window-target" });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe("same-window-target");
    expect(cdpNewMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, url: "about:blank" });
    // The residual limitation must be surfaced, not silently swallowed: the
    // fallback tab can stay visibility-hidden while another lane is frontmost.
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Page Visibility API"));
  });

  test("falls back to a same-window tab when browser-level createTarget fails", async () => {
    const browserWSEndpoint = "ws://127.0.0.1:9222/devtools/browser/def";
    cdpVersionMock.mockResolvedValue({ webSocketDebuggerUrl: browserWSEndpoint });
    const createTargetMock = vi.fn().mockRejectedValue(new Error("'newWindow' not supported"));
    const browserCloseMock = vi.fn().mockResolvedValue(undefined);
    cdpMock.mockImplementation(async (options: { target?: string; local?: boolean }) => {
      if (options?.target === browserWSEndpoint) {
        return {
          // biome-ignore lint/style/useNamingConvention: CDP API uses capitalized members.
          Target: { createTarget: createTargetMock },
          close: browserCloseMock,
        };
      }
      return {};
    });
    cdpNewMock.mockResolvedValue({ id: "fallback-target" });

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const result = await connectWithNewTab(9222, logger);

    expect(result.targetId).toBe("fallback-target");
    expect(createTargetMock).toHaveBeenCalledWith({ url: "about:blank", newWindow: true });
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
    expect(cdpNewMock).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Page Visibility API"));
  });

  test("manual-login connect options never allow default-target fallback (launching lane included)", async () => {
    const { resolveIsolatedTabConnectOptions } = await import(
      "../../src/browser/chromeLifecycle.js"
    );

    // Regression: the launching lane used to gate strict isolation on
    // reusedChrome, silently attaching manual-login runs that launched
    // Chrome themselves to the shared default tab. The policy is a function
    // of manualLogin alone.
    const manualLoginOptions = resolveIsolatedTabConnectOptions(true);
    expect(manualLoginOptions.fallbackToDefault).toBe(false);
    expect(manualLoginOptions.retries).toBe(6);

    const throwawayProfileOptions = resolveIsolatedTabConnectOptions(false);
    expect(throwawayProfileOptions.fallbackToDefault).toBe(true);
    expect(throwawayProfileOptions.retries).toBe(0);
  });

  test("manual-login lane throws after exhausting retries instead of attaching to the default target", async () => {
    vi.useFakeTimers();
    cdpNewMock.mockRejectedValue(new Error("boom"));
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab, resolveIsolatedTabConnectOptions } = await import(
      "../../src/browser/chromeLifecycle.js"
    );
    const logger = vi.fn();

    const resultPromise = connectWithNewTab(
      9222,
      logger,
      undefined,
      undefined,
      resolveIsolatedTabConnectOptions(true),
    );
    const expectation = expect(resultPromise).rejects.toThrow(
      /refusing to attach to default target/i,
    );
    await vi.runAllTimersAsync();
    await expectation;

    // 1 initial attempt + 6 retries, and no fallback connection to Chrome's
    // default target was ever opened.
    expect(cdpNewMock).toHaveBeenCalledTimes(7);
    expect(cdpMock).not.toHaveBeenCalled();
  });

  test("retries transient DevTools connection failures before falling back", async () => {
    vi.useFakeTimers();
    cdpNewMock
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:9222"))
      .mockResolvedValueOnce({ id: "target-3" });
    cdpMock.mockResolvedValue({});

    const { connectWithNewTab } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const resultPromise = connectWithNewTab(9222, logger, undefined, undefined, {
      retries: 1,
      retryDelayMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result.targetId).toBe("target-3");
    expect(cdpNewMock).toHaveBeenCalledTimes(2);
    expect(cdpMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222, target: "target-3" });
  });
});

describe("closeBlankChromeTabs", () => {
  beforeEach(() => {
    cdpMock.mockReset();
    cdpNewMock.mockReset();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("closes blank tabs while preserving active and conversation targets", async () => {
    cdpListMock.mockResolvedValue([
      { id: "blank-1", type: "page", url: "about:blank" },
      { id: "chat-1", type: "page", url: "https://chatgpt.com/c/abc" },
      { id: "active-blank", type: "page", url: "about:blank" },
      { id: "newtab-1", type: "page", url: "chrome://newtab/" },
      { id: "worker-1", type: "service_worker", url: "about:blank" },
    ]);
    cdpCloseMock.mockResolvedValue(undefined);

    const { closeBlankChromeTabs } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    await closeBlankChromeTabs(9222, logger, "127.0.0.1", {
      excludeTargetIds: ["active-blank"],
      blankGraceMs: 0,
    });

    expect(cdpListMock).toHaveBeenCalledWith({ host: "127.0.0.1", port: 9222 });
    expect(cdpCloseMock).toHaveBeenCalledTimes(2);
    expect(cdpCloseMock).toHaveBeenNthCalledWith(1, {
      host: "127.0.0.1",
      port: 9222,
      id: "blank-1",
    });
    expect(cdpCloseMock).toHaveBeenNthCalledWith(2, {
      host: "127.0.0.1",
      port: 9222,
      id: "newtab-1",
    });
    expect(logger).toHaveBeenCalledWith("Closed 2 blank Chrome tabs.");
  });

  test("age-gate spares a just-opened blank tab that navigates within the grace window", async () => {
    // Regression: a concurrent lane's brand-new tab (CDP.New defaults to
    // about:blank) must not be swept as an orphan when its lease record was
    // not yet visible to the caller's exclude set. Only tabs blank in BOTH
    // snapshots are closed.
    vi.useFakeTimers();
    cdpListMock
      .mockResolvedValueOnce([
        { id: "orphan-blank", type: "page", url: "about:blank" },
        { id: "lane-b-fresh", type: "page", url: "about:blank" },
      ])
      .mockResolvedValueOnce([
        { id: "orphan-blank", type: "page", url: "about:blank" },
        { id: "lane-b-fresh", type: "page", url: "https://chatgpt.com/" },
      ]);
    cdpCloseMock.mockResolvedValue(undefined);

    const { closeBlankChromeTabs, DEFAULT_BLANK_TAB_SWEEP_GRACE_MS } = await import(
      "../../src/browser/chromeLifecycle.js"
    );
    const logger = vi.fn();

    const sweep = closeBlankChromeTabs(9222, logger, "127.0.0.1", {
      excludeTargetIds: [],
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_BLANK_TAB_SWEEP_GRACE_MS);
    await sweep;

    expect(cdpListMock).toHaveBeenCalledTimes(2);
    expect(cdpCloseMock).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      id: "orphan-blank",
    });
    expect(logger).toHaveBeenCalledWith("Closed 1 blank Chrome tab.");
  });

  test("age-gate never closes a tab that only appeared after the first snapshot", async () => {
    vi.useFakeTimers();
    cdpListMock
      .mockResolvedValueOnce([{ id: "orphan-blank", type: "page", url: "about:blank" }])
      .mockResolvedValueOnce([
        { id: "orphan-blank", type: "page", url: "about:blank" },
        { id: "created-during-grace", type: "page", url: "about:blank" },
      ]);
    cdpCloseMock.mockResolvedValue(undefined);

    const { closeBlankChromeTabs, DEFAULT_BLANK_TAB_SWEEP_GRACE_MS } = await import(
      "../../src/browser/chromeLifecycle.js"
    );
    const logger = vi.fn();

    const sweep = closeBlankChromeTabs(9222, logger, "127.0.0.1", {});
    await vi.advanceTimersByTimeAsync(DEFAULT_BLANK_TAB_SWEEP_GRACE_MS);
    await sweep;

    expect(cdpCloseMock).toHaveBeenCalledTimes(1);
    expect(cdpCloseMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 9222,
      id: "orphan-blank",
    });
  });

  test("age-gate stands down when the confirming snapshot fails", async () => {
    vi.useFakeTimers();
    cdpListMock
      .mockResolvedValueOnce([{ id: "maybe-orphan", type: "page", url: "about:blank" }])
      .mockRejectedValueOnce(new Error("devtools endpoint went away"));
    cdpCloseMock.mockResolvedValue(undefined);

    const { closeBlankChromeTabs, DEFAULT_BLANK_TAB_SWEEP_GRACE_MS } = await import(
      "../../src/browser/chromeLifecycle.js"
    );
    const logger = vi.fn();

    const sweep = closeBlankChromeTabs(9222, logger, "127.0.0.1", {});
    await vi.advanceTimersByTimeAsync(DEFAULT_BLANK_TAB_SWEEP_GRACE_MS);
    await sweep;

    expect(cdpCloseMock).not.toHaveBeenCalled();
  });

  test("opens a dedicated tab through a browser websocket endpoint", async () => {
    const send = vi.fn(async () => ({}));
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-9" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-9" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: { enable: vi.fn(async () => ({})), evaluate: vi.fn(async () => ({ result: {} })) },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      Emulation: { setFocusEmulationEnabled: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    Object.defineProperty(browserClient, "send", { value: send });
    cdpMock.mockResolvedValue(browserClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();

    const connection = await connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );

    expect(cdpMock).toHaveBeenCalledWith({
      target: "ws://127.0.0.1:9222/devtools/browser/abc",
      local: true,
    });
    expect(browserClient.Target.createTarget).toHaveBeenCalledWith({ url: "https://chatgpt.com/" });
    expect(browserClient.Target.attachToTarget).toHaveBeenCalledWith({
      targetId: "target-9",
      flatten: true,
    });
    expect(connection.targetId).toBe("target-9");
    await connection.client.Emulation.setFocusEmulationEnabled({ enabled: true });
    expect(browserClient.Emulation.setFocusEmulationEnabled).toHaveBeenCalledWith(
      { enabled: true },
      "session-9",
    );
    await (
      connection.client as typeof connection.client & {
        send: (method: string, params: unknown, sessionId: string) => Promise<unknown>;
      }
    ).send("Target.setAutoAttach", { autoAttach: true }, "session-9");
    expect(send).toHaveBeenCalledWith("Target.setAutoAttach", { autoAttach: true }, "session-9");
  });

  test("waits on a single websocket connection attempt for Chrome approval", async () => {
    vi.useFakeTimers();
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-10" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-10" })),
        detachFromTarget: vi.fn(async () => ({})),
        closeTarget: vi.fn(async () => ({ success: true })),
      },
      Network: { enable: vi.fn(async () => ({})) },
      Page: { enable: vi.fn(async () => ({})), navigate: vi.fn(async () => ({})) },
      Runtime: { enable: vi.fn(async () => ({})), evaluate: vi.fn(async () => ({ result: {} })) },
      Input: { dispatchKeyEvent: vi.fn(async () => ({})) },
      DOM: { enable: vi.fn(async () => ({})) },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    cdpMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(browserClient), 1_000);
        }),
    );

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    const connection = await promise;

    expect(cdpMock).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Waiting for Chrome remote debugging approval for 127.0.0.1:9222...",
    );
    expect(connection.targetId).toBe("target-10");
  });

  test("fails after the approval wait without opening a second websocket request", async () => {
    vi.useFakeTimers();
    cdpMock.mockImplementationOnce(() => new Promise(() => {}));

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );
    const assertion = expect(promise).rejects.toThrow(
      /waited 20s for Chrome remote debugging approval/i,
    );

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    expect(cdpMock).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Waiting for Chrome remote debugging approval for 127.0.0.1:9222...",
    );
  });

  test("retries immediate 403 responses while waiting for remote debugging approval", async () => {
    vi.useFakeTimers();
    const browserClient = {
      Target: {
        createTarget: vi.fn(async () => ({ targetId: "target-20" })),
        attachToTarget: vi.fn(async () => ({ sessionId: "session-20" })),
      },
      close: vi.fn(async () => {}),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    };
    cdpMock
      .mockRejectedValueOnce(new Error("Unexpected server response: 403"))
      .mockRejectedValueOnce(new Error("Unexpected server response: 403"))
      .mockResolvedValueOnce(browserClient);

    const { connectToRemoteChrome } = await import("../../src/browser/chromeLifecycle.js");
    const logger = vi.fn();
    const promise = connectToRemoteChrome(
      "127.0.0.1",
      9222,
      logger,
      "https://chatgpt.com/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      { approvalWaitMs: 20_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    const connection = await promise;

    expect(cdpMock).toHaveBeenCalledTimes(3);
    expect(connection.targetId).toBe("target-20");
  });
});
