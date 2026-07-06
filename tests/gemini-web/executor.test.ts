import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { readEvidenceLedger } from "../../src/oracle/evidence_ledger.js";

const {
  launchChrome,
  connectWithNewTab,
  closeTab,
  killChrome,
  resolveBrowserConfig,
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
  delay,
} = vi.hoisted(() => ({
  launchChrome: vi.fn(),
  connectWithNewTab: vi.fn(),
  closeTab: vi.fn(async () => undefined),
  killChrome: vi.fn(async () => undefined),
  resolveBrowserConfig: vi.fn((input: unknown) => input),
  readDevToolsPort: vi.fn(async () => null),
  writeDevToolsActivePort: vi.fn(async () => undefined),
  writeChromePid: vi.fn(async () => undefined),
  cleanupStaleProfileState: vi.fn(async () => undefined),
  verifyDevToolsReachable: vi.fn(async () => ({ ok: false, error: "unreachable" })),
  delay: vi.fn(async () => undefined),
}));

const runGeminiWebWithFallback = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  rawResponseText: "",
  text: "ok",
  thoughts: "thinking",
  metadata: { cid: "1" },
  images: [],
  effectiveModel: "gemini-3.1-pro",
}));

const saveFirstGeminiImageFromOutput = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  async () => ({
    saved: true,
    imageCount: 1,
  }),
);

vi.mock("../../src/gemini-web/client.js", () => ({
  runGeminiWebWithFallback,
  saveFirstGeminiImageFromOutput,
}));

const getCookies = vi.fn(async () => ({
  cookies: [
    {
      name: "__Secure-1PSID",
      value: "psid",
      domain: "google.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
    {
      name: "__Secure-1PSIDTS",
      value: "psidts",
      domain: "google.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ],
  warnings: [] as string[],
}));
vi.mock("@steipete/sweet-cookie", () => ({ getCookies }));
vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  launchChrome,
  connectWithNewTab,
  closeTab,
}));
vi.mock("../../src/browser/config.js", () => ({
  resolveBrowserConfig,
}));
vi.mock("../../src/browser/profileState.js", () => ({
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
}));
vi.mock("../../src/browser/utils.js", () => ({
  delay,
}));

function requiredGeminiCookies() {
  return [
    {
      name: "__Secure-1PSID",
      value: "psid",
      domain: "google.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
    {
      name: "__Secure-1PSIDTS",
      value: "psidts",
      domain: "google.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ];
}

describe("gemini-web executor", () => {
  beforeEach(() => {
    runGeminiWebWithFallback.mockClear();
    saveFirstGeminiImageFromOutput.mockClear();
    getCookies.mockClear();
    launchChrome.mockReset();
    connectWithNewTab.mockReset();
    closeTab.mockClear();
    resolveBrowserConfig.mockClear();
    readDevToolsPort.mockReset();
    writeDevToolsActivePort.mockClear();
    writeChromePid.mockClear();
    cleanupStaleProfileState.mockClear();
    verifyDevToolsReachable.mockReset();
    delay.mockClear();
    killChrome.mockClear();

    launchChrome.mockResolvedValue({
      port: 9222,
      pid: 12345,
      kill: killChrome,
    });
    const runtimeEvaluate = vi.fn(async ({ expression }: { expression?: string }) => {
      const source = String(expression ?? "");
      if (source.includes("requiresLogin")) {
        return {
          result: {
            value: {
              ready: true,
              requiresLogin: false,
              href: "https://gemini.google.com/app",
            },
          },
        };
      }
      if (source.includes("toolbox-drawer-button")) {
        return { result: { value: "clicked" } };
      }
      if (source.includes("includes('deep think')")) {
        return { result: { value: "clicked" } };
      }
      if (source.includes("Deselect Deep Think")) {
        return { result: { value: true } };
      }
      if (source.includes("document.execCommand")) {
        return { result: { value: "typed" } };
      }
      if (source.includes("button.send-button")) {
        return { result: { value: "clicked" } };
      }
      if (source.includes("response-footer") && source.includes("status: 'done'")) {
        return {
          result: {
            value: JSON.stringify({ status: "done", text: "deep-think answer" }),
          },
        };
      }
      if (source.includes("thoughts-header-button") && source.includes("click")) {
        return { result: { value: "no-toggle" } };
      }
      if (source.includes("model-thoughts") && source.includes("textContent")) {
        return { result: { value: "" } };
      }
      return { result: { value: null } };
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-1",
      client: {
        Runtime: {
          enable: vi.fn(async () => undefined),
          evaluate: runtimeEvaluate,
        },
        Network: {
          enable: vi.fn(async () => undefined),
          getCookies: vi.fn(async () => ({ cookies: requiredGeminiCookies() })),
        },
        Page: {
          enable: vi.fn(async () => undefined),
          navigate: vi.fn(async () => ({ frameId: "f-1" })),
        },
        close: vi.fn(async () => undefined),
      },
    });
    readDevToolsPort.mockResolvedValue(null);
    verifyDevToolsReachable.mockResolvedValue({ ok: false, error: "unreachable" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a generate-image prompt with aspect ratio and passes attachments", async () => {
    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-exec-"));
    const outPath = path.join(tempDir, "gen.jpg");

    const exec = createGeminiWebExecutor({
      generateImage: outPath,
      aspectRatio: "1:1",
      showThoughts: true,
    });
    const result = await exec({
      prompt: "a cute robot holding a banana",
      attachments: [{ path: "/tmp/attach.txt", displayPath: "attach.txt" }],
      config: { desiredModel: "Gemini 3 Pro", chromeProfile: "Default" },
      log: () => {},
    });

    expect(runGeminiWebWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3.1-pro",
        prompt: "Generate an image: a cute robot holding a banana (aspect ratio: 1:1)",
        files: ["/tmp/attach.txt"],
      }),
    );
    expect(saveFirstGeminiImageFromOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      outPath,
      expect.any(AbortSignal),
    );
    expect(result.answerMarkdown).toContain("## Thinking");
    expect(result.answerMarkdown).toContain("Generated 1 image(s).");
  });

  it("runs the edit flow as two calls and uses intro metadata", async () => {
    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-exec-"));
    const inPath = path.join(tempDir, "in.png");
    const outPath = path.join(tempDir, "out.jpg");

    runGeminiWebWithFallback
      .mockResolvedValueOnce({
        rawResponseText: "",
        text: "intro",
        thoughts: null,
        metadata: { chat: "meta" },
        images: [],
        effectiveModel: "gemini-3.1-pro",
      })
      .mockResolvedValueOnce({
        rawResponseText: "",
        text: "edited",
        thoughts: null,
        metadata: null,
        images: [],
        effectiveModel: "gemini-3.1-pro",
      });

    const exec = createGeminiWebExecutor({ editImage: inPath, outputPath: outPath });
    await exec({
      prompt: "add sunglasses",
      attachments: [],
      config: { desiredModel: "Gemini 3 Pro", chromeProfile: "Default" },
      log: () => {},
    });

    expect(runGeminiWebWithFallback).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        prompt: "Here is an image to edit",
        files: [inPath],
        chatMetadata: null,
      }),
    );
    expect(runGeminiWebWithFallback).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ chatMetadata: { chat: "meta" } }),
    );
    expect(saveFirstGeminiImageFromOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      outPath,
      expect.any(AbortSignal),
    );
  });

  it("uses chromeCookiePath when provided", async () => {
    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});
    await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "Gemini 3 Pro", chromeCookiePath: "/tmp/Cookies" },
      log: () => {},
    });
    expect(getCookies).toHaveBeenCalledWith(
      expect.objectContaining({ chromeProfile: "/tmp/Cookies" }),
    );
  });

  it("uses inline cookies when cookie sync is disabled", async () => {
    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});
    await exec({
      prompt: "hello",
      attachments: [],
      config: {
        desiredModel: "Gemini 3 Pro",
        cookieSync: false,
        inlineCookies: [
          { name: "__Secure-1PSID", value: "psid", domain: "google.com", path: "/" },
          { name: "__Secure-1PSIDTS", value: "psidts", domain: "google.com", path: "/" },
        ],
        inlineCookiesSource: "test",
      },
      log: () => {},
    });
    expect(getCookies).not.toHaveBeenCalled();
  });

  it("includes cookie read warnings in the missing-cookie error", async () => {
    getCookies.mockImplementationOnce(async () => ({
      cookies: [],
      warnings: [
        "node:sqlite failed reading Chrome cookies (requires modern Chromium, e.g. Chrome >= 100): Value is too large to be represented as a JavaScript number: 13449189465095212",
      ],
    }));

    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});

    await expect(
      exec({
        prompt: "hello",
        attachments: [],
        config: { desiredModel: "Gemini 3 Pro", chromeProfile: "Default" },
        log: () => {},
      }),
    ).rejects.toThrow(
      /Cookie read warnings:.*Value is too large to be represented as a JavaScript number[\s\S]*--browser-manual-login[\s\S]*--browser-inline-cookies-file/s,
    );
  });

  it("uses DOM automation for gemini deep-think without keychain cookie reads", async () => {
    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});
    const result = await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
      log: () => {},
    });

    expect(result.answerText).toBe("deep-think answer");
    expect(getCookies).not.toHaveBeenCalled();
    expect(launchChrome).toHaveBeenCalled();
    expect(connectWithNewTab).toHaveBeenCalled();
    expect(closeTab).toHaveBeenCalled();
    expect(runGeminiWebWithFallback).not.toHaveBeenCalled();
  });

  it("falls back to HTTP/header path for gemini deep-think when attachments are present", async () => {
    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});
    await exec({
      prompt: "summarize this file",
      attachments: [{ path: "/tmp/attach.txt", displayPath: "attach.txt" }],
      config: { desiredModel: "gemini-3-deep-think", chromeProfile: "Default" },
      log: () => {},
    });

    expect(getCookies).toHaveBeenCalled();
    expect(runGeminiWebWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-3-pro-deep-think",
        files: ["/tmp/attach.txt"],
      }),
    );
  });

  it("throws GeminiDeepThinkFallbackBlockedError when fallback=fail and attachments force HTTP", async () => {
    const { createGeminiWebExecutor, GeminiDeepThinkFallbackBlockedError } = await import(
      "../../src/gemini-web/executor.js"
    );
    const exec = createGeminiWebExecutor({ deepThinkFallback: "fail" });
    const run = () =>
      exec({
        prompt: "summarize this file",
        attachments: [{ path: "/tmp/attach.txt", displayPath: "attach.txt" }],
        config: { desiredModel: "gemini-3-deep-think", chromeProfile: "Default" },
        log: () => {},
      });

    await expect(run()).rejects.toThrow(GeminiDeepThinkFallbackBlockedError);
    await expect(run()).rejects.toThrow(/attachments/);
    expect(getCookies).not.toHaveBeenCalled();
    expect(runGeminiWebWithFallback).not.toHaveBeenCalled();
  });

  it("emits v18 evidence + ledger artifacts for a live Deep Think DOM run (oracle-scb regression)", async () => {
    // Regression for: emitGeminiDeepThinkV18ArtifactsForRun was fully
    // wired but never invoked by the live executor, so every live
    // Gemini Deep Think DOM run shipped zero v18 artifacts /
    // evidence-ledger entries. This drives the real DOM path (as the
    // "uses DOM automation" test above does) and asserts the v18
    // evidence + ledger side effects actually land on disk.
    const oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-v18-home-"));
    setOracleHomeDirOverrideForTest(oracleHomeDir);
    try {
      const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
      const exec = createGeminiWebExecutor({});
      const sessionId = "gemini-v18-regression-session";
      const result = await exec({
        prompt: "hello",
        attachments: [],
        sessionId,
        config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
        log: () => {},
      });

      expect(result.answerText).toBe("deep-think answer");

      const ledger = await readEvidenceLedger(sessionId, { homeDir: oracleHomeDir });
      const eventTypes = ledger.entries.map((e) => e.event.type);
      expect(eventTypes).toContain("evidence_written");
      expect(eventTypes.some((t) => t === "run_completed" || t === "run_failed")).toBe(true);
      const written = ledger.entries.find((e) => e.event.type === "evidence_written");
      expect(written).toBeTruthy();
      expect((written!.event as { provider_slot?: string }).provider_slot).toBe(
        "gemini_deep_think",
      );
    } finally {
      setOracleHomeDirOverrideForTest(null);
      await rm(oracleHomeDir, { recursive: true, force: true });
    }
  });

  it("aborts a Deep Think DOM run at the next wait point when runOptions.signal fires", async () => {
    // Regression for: BrowserRunOptions.signal (caller-gone abort) was never
    // wired into the Gemini executor, so an orchestrator cancel left the DOM
    // path polling for up to RESPONSE_TIMEOUT_MS (10 minutes). The response
    // poll below never reports "done"; the run must still reject promptly
    // once the caller's signal fires.
    const abortController = new AbortController();
    const runtimeEvaluate = vi.fn(async ({ expression }: { expression?: string }) => {
      const source = String(expression ?? "");
      if (source.includes("requiresLogin")) {
        return {
          result: {
            value: { ready: true, requiresLogin: false, href: "https://gemini.google.com/app" },
          },
        };
      }
      if (source.includes("toolbox-drawer-button")) return { result: { value: "clicked" } };
      if (source.includes("includes('deep think')")) return { result: { value: "clicked" } };
      if (source.includes("Deselect Deep Think")) return { result: { value: true } };
      if (source.includes("document.execCommand")) return { result: { value: "typed" } };
      if (source.includes("button.send-button")) return { result: { value: "clicked" } };
      if (source.includes("response-footer") && source.includes("status: 'done'")) {
        // Simulate a run cancelled mid-generation: fire the caller-gone
        // signal while the response poll is still pending.
        abortController.abort();
        return { result: { value: JSON.stringify({ status: "pending" }) } };
      }
      return { result: { value: null } };
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-abort",
      client: {
        Runtime: { enable: vi.fn(async () => undefined), evaluate: runtimeEvaluate },
        Network: {
          enable: vi.fn(async () => undefined),
          getCookies: vi.fn(async () => ({ cookies: requiredGeminiCookies() })),
        },
        Page: {
          enable: vi.fn(async () => undefined),
          navigate: vi.fn(async () => ({ frameId: "f-abort" })),
        },
        close: vi.fn(async () => undefined),
      },
    });

    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});
    const run = exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
      log: () => {},
      signal: abortController.signal,
    });

    await expect(run).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "client-abort",
        oracleErrorClass: "transport_interrupted_after_submit",
        retryable: false,
      },
    });
    // The abandoned run must still unwind through the normal cleanup path.
    expect(closeTab).toHaveBeenCalled();
  });

  it("rejects a Deep Think DOM run pre-submit when the caller signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});
    const run = exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think", keepBrowser: false },
      log: () => {},
      signal: abortController.signal,
    });

    await expect(run).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "client-abort",
        oracleErrorClass: "transport_interrupted_before_submit",
        retryable: true,
      },
    });
    // Pre-flight abort: no browser session should ever be opened.
    expect(launchChrome).not.toHaveBeenCalled();
    expect(connectWithNewTab).not.toHaveBeenCalled();
  });

  it("propagates runOptions.signal into the HTTP fallback fetch signal", async () => {
    // Regression for: the httpClient path built its own AbortController tied
    // only to the request timeout, so a caller-gone abort never cancelled the
    // in-flight Gemini fetch.
    const abortController = new AbortController();
    runGeminiWebWithFallback.mockImplementationOnce((options: unknown) => {
      const { signal } = options as { signal: AbortSignal };
      return new Promise((_, reject) => {
        const onAbort = () => reject(new Error("gemini fetch aborted by caller signal"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        // The fetch is now "in flight"; simulate the orchestrator cancelling.
        abortController.abort();
      });
    });

    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});
    const run = exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "Gemini 3 Pro", chromeProfile: "Default" },
      log: () => {},
      signal: abortController.signal,
    });

    await expect(run).rejects.toThrow("gemini fetch aborted by caller signal");
  });

  it("keeps the launched browser alive when Deep Think uses the keep-browser default", async () => {
    const { createGeminiWebExecutor } = await import("../../src/gemini-web/executor.js");
    const exec = createGeminiWebExecutor({});
    await exec({
      prompt: "hello",
      attachments: [],
      config: { desiredModel: "gemini-3-deep-think" },
      log: () => {},
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(killChrome).not.toHaveBeenCalled();
  });
});
