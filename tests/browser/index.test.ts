import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  __test__,
  classifyPreservedBrowserErrorForTest,
  formatBrowserTurnTranscript,
  isLocalChromeHostForTest,
  maybeArchiveCompletedConversationForTest,
  pollConversationUrlForTest,
  redactBrowserConfigForDebugLogForTest,
  resolveRemoteTabLeaseProfileDirForTest,
  runBrowserMode,
  runSubmissionWithRecoveryForTest,
  shouldPreferSystemTmpDirForTest,
  shouldPreserveBrowserOnErrorForTest,
} from "../../src/browser/index.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { registerSubmittedUserMessage } from "../../src/browser/actions/captureBinding.js";

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for headless cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test.each(["verification_interstitial", "account_security_block"])(
    "preserves a headful browser for canonical %s challenge gates",
    (state) => {
      const error = new BrowserAutomationError("Manual verification required.", {
        stage: "challenge-gate",
        state,
      });
      expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
      expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("cloudflare-challenge");
      expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
    },
  );

  test.each(["login_required", "rate_limited"])(
    "does not preserve refusal-only %s gates",
    (state) => {
      const error = new BrowserAutomationError("Run refused.", {
        stage: "challenge-gate",
        state,
      });
      expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
    },
  );

  test("preserves the browser for headful assistant capture errors", () => {
    const timeout = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });
    const recheck = new BrowserAutomationError("assistant recheck failed", {
      stage: "assistant-recheck",
    });

    expect(shouldPreserveBrowserOnErrorForTest(timeout, false)).toBe(true);
    expect(shouldPreserveBrowserOnErrorForTest(recheck, false)).toBe(true);
    expect(classifyPreservedBrowserErrorForTest(timeout, false)).toBe("reattachable-capture");
    expect(classifyPreservedBrowserErrorForTest(recheck, false)).toBe("reattachable-capture");
  });

  test("does not preserve assistant capture errors in headless mode", () => {
    const error = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });

    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, true)).toBeNull();
  });

  test("does not preserve the browser for unrelated browser errors", () => {
    const error = new BrowserAutomationError("other browser error", {
      stage: "execute-browser",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, false)).toBeNull();
  });

  test("classifies Cloudflare preservation separately from assistant capture preservation", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });

    expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("cloudflare-challenge");
  });

  test.each(["cloudflare-challenge", "account-quarantine"])(
    "does not replace an already canonical %s error while preferring challenge failures",
    async (stage) => {
      const error = new BrowserAutomationError("Manual verification required.", {
        stage,
        state: "verification_interstitial",
        oracleErrorClass: "account_quarantine",
        retryable: false,
      });
      const Runtime = {
        evaluate: vi.fn().mockRejectedValue(new Error("canonical errors must not re-probe")),
      } as unknown as ChromeClient["Runtime"];

      await expect(
        __test__.preferChallengeOverPageFailure(
          error,
          Runtime,
          vi.fn() as unknown as BrowserLogger,
          { accountId: "acct-canonical-challenge" },
        ),
      ).resolves.toBe(error);
      expect(Runtime.evaluate).not.toHaveBeenCalled();
      expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("cloudflare-challenge");
    },
  );
});

describe("browser run target cleanup", () => {
  test("never retains a copied profile after a preserved browser error", () => {
    expect(
      __test__.shouldKeepLocalBrowserOpen({
        effectiveKeepBrowser: false,
        preserveBrowserOnError: true,
        usingCopiedProfile: true,
      }),
    ).toBe(false);
  });

  test("keeps existing retention semantics for ordinary profiles", () => {
    expect(
      __test__.shouldKeepLocalBrowserOpen({
        effectiveKeepBrowser: false,
        preserveBrowserOnError: true,
        usingCopiedProfile: false,
      }),
    ).toBe(true);
  });

  test("keeps the completed conversation tab when keepBrowser is enabled", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
      }),
    ).toBe(false);
  });

  test("closes owned completed tabs by default", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(true);
  });

  test("does not close attached or incomplete targets", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: false,
        keepBrowser: false,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(false);
  });

  test("preserved headful errors keep the exact owned tab even under always-close policy", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: true,
        policy: "always",
        preserveOwnedTargetOnError: true,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: true,
        policy: "always",
        preserveOwnedTargetOnError: false,
      }),
    ).toBe(true);
  });

  test.each([
    {
      label: "a preserved owned challenge target",
      options: {
        runStatus: "attempted" as const,
        ownsTarget: true,
        preserveOwnedTargetOnError: true,
      },
      expected: true,
    },
    {
      label: "a preserved owned reattachable capture target",
      options: {
        runStatus: "attempted" as const,
        ownsTarget: true,
        preserveOwnedTargetOnError: true,
      },
      expected: true,
    },
    {
      label: "a borrowed target",
      options: {
        runStatus: "attempted" as const,
        ownsTarget: false,
        preserveOwnedTargetOnError: true,
      },
      expected: false,
    },
    {
      label: "an orphaned target that requires cleanup",
      options: {
        runStatus: "attempted" as const,
        ownsTarget: true,
        preserveOwnedTargetOnError: true,
        orphanedTargetNeedsCleanup: true,
      },
      expected: false,
    },
    {
      label: "a headless, copied-profile, or ordinary non-preserved failure",
      options: {
        runStatus: "attempted" as const,
        ownsTarget: true,
        preserveOwnedTargetOnError: false,
      },
      expected: false,
    },
    {
      label: "a completed run",
      options: {
        runStatus: "complete" as const,
        ownsTarget: true,
        preserveOwnedTargetOnError: true,
      },
      expected: false,
    },
  ])("retained tab-lease decision: $label", ({ options, expected }) => {
    expect(__test__.shouldRetainBrowserTabLeaseAfterRun(options)).toBe(expected);
  });

  test("local and remote cleanup both guard lease release behind preserved-target retention", async () => {
    const source = (
      await readFile(new URL("../../src/browser/index.ts", import.meta.url), "utf8")
    ).replace(/\s+/gu, "");
    const slice = (start: string, end: string): string => {
      const startIndex = source.indexOf(start);
      const endIndex = source.indexOf(end, startIndex + start.length);
      expect(startIndex, `missing cleanup start anchor: ${start}`).toBeGreaterThanOrEqual(0);
      expect(endIndex, `missing cleanup end anchor: ${end}`).toBeGreaterThan(startIndex);
      return source.slice(startIndex, endIndex);
    };
    const assertRetainBeforeRelease = (cleanup: string): void => {
      const decisionIndex = cleanup.indexOf(
        "constretainPreservedOwnedTargetLease=shouldRetainBrowserTabLeaseAfterRun({",
      );
      const retainIndex = cleanup.indexOf("if(tabLease&&retainPreservedOwnedTargetLease){");
      const releaseIndex = cleanup.indexOf("elseif(tabLease&&ownedTargetCleanupProved){");
      expect(decisionIndex).toBeGreaterThanOrEqual(0);
      expect(retainIndex).toBeGreaterThan(decisionIndex);
      expect(releaseIndex).toBeGreaterThan(retainIndex);
    };

    assertRetainBeforeRelease(
      slice("exportasyncfunctionrunBrowserMode", "asyncfunctionpickAvailableDebugPort"),
    );
    assertRetainBeforeRelease(
      slice("asyncfunctionrunRemoteBrowserMode", "export{estimateTokenCount}"),
    );
  });
});

describe("manual-login profile setup gate", () => {
  test("fails fast for an uninitialized manual-login profile unless setup keeps Chrome open", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-empty-profile-"));
    try {
      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: false,
        }),
      ).rejects.toThrow(/private Chrome profile/i);

      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: true,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts an initialized manual-login Chrome profile", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-initialized-profile-"));
    try {
      await mkdir(path.join(dir, "Default"));
      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formats the first-time setup command with the selected profile", () => {
    expect(__test__.formatManualLoginSetupCommand("/tmp/oracle profile")).toContain(
      '--browser-manual-login-profile-dir "/tmp/oracle profile"',
    );
  });

  test("caps non-setup manual-login waits so MCP callers fail fast", () => {
    expect(__test__.resolveManualLoginWaitMs(20 * 60_000, false)).toBe(30_000);
    expect(__test__.resolveManualLoginWaitMs(5_000, false)).toBe(5_000);
    expect(__test__.resolveManualLoginWaitMs(20 * 60_000, true)).toBe(20 * 60_000);
  });
});

// NOTE: shouldSkipThinkingTimeSelection was removed — it incorrectly assumed
// that selecting "Pro" in the picker always implied Extended effort, which is
// wrong for lower-tier plans where Pro defaults to Standard. The thinking time
// step now always runs; ensureThinkingTime handles the already-selected case.

describe("GPT-5.6 Sol + Pro evidence integration", () => {
  test("refresh recovery is limited to Oracle-owned new-chat tabs", () => {
    expect(__test__.shouldRefreshInitialModelPicker({})).toBe(true);
    expect(
      __test__.shouldRefreshInitialModelPicker({
        resumeConversationUrl: "https://chatgpt.com/c/example",
      }),
    ).toBe(false);
    expect(__test__.shouldRefreshInitialModelPicker({ browserTabRef: "current" })).toBe(false);
    expect(
      __test__.shouldRefreshInitialModelPicker({
        browserTabRef: "tab-id",
        resumeConversationUrl: null,
      }),
    ).toBe(false);
  });

  test("hard-refreshes once when the initial model picker snapshot lacks Sol", async () => {
    const selectModel = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("Sol option missing", {
          stage: "model-selection",
          reason: "option-not-found",
        }),
      )
      .mockResolvedValueOnce("selected");
    const refreshPage = vi.fn(async () => undefined);
    const loggerMock = vi.fn();
    const logger = loggerMock as unknown as BrowserLogger;

    await expect(
      __test__.selectInitialModelWithRefreshRecovery({
        selectModel,
        refreshPage,
        allowRefresh: true,
        logger,
      }),
    ).resolves.toBe("selected");
    expect(selectModel).toHaveBeenCalledTimes(2);
    expect(refreshPage).toHaveBeenCalledTimes(1);
    expect(loggerMock).toHaveBeenCalledWith(expect.stringMatching(/hard-refreshing once/i));
  });

  test("does not refresh resumed conversations or unrelated failures", async () => {
    const missing = new BrowserAutomationError("Sol option missing", {
      stage: "model-selection",
      reason: "option-not-found",
    });
    const resumedRefresh = vi.fn(async () => undefined);
    await expect(
      __test__.selectInitialModelWithRefreshRecovery({
        selectModel: async () => {
          throw missing;
        },
        refreshPage: resumedRefresh,
        allowRefresh: false,
        logger: vi.fn() as unknown as BrowserLogger,
      }),
    ).rejects.toBe(missing);
    expect(resumedRefresh).not.toHaveBeenCalled();

    const unrelated = new BrowserAutomationError("Cloudflare", {
      stage: "cloudflare-challenge",
    });
    const unrelatedRefresh = vi.fn(async () => undefined);
    await expect(
      __test__.selectInitialModelWithRefreshRecovery({
        selectModel: async () => {
          throw unrelated;
        },
        refreshPage: unrelatedRefresh,
        allowRefresh: true,
        logger: vi.fn() as unknown as BrowserLogger,
      }),
    ).rejects.toBe(unrelated);
    expect(unrelatedRefresh).not.toHaveBeenCalled();
  });

  test("fails closed after the single refresh when Sol remains unavailable", async () => {
    const missing = new BrowserAutomationError("Sol option missing", {
      stage: "model-selection",
      reason: "option-not-found",
    });
    const selectModel = vi.fn(async () => {
      throw missing;
    });
    const refreshPage = vi.fn(async () => undefined);

    await expect(
      __test__.selectInitialModelWithRefreshRecovery({
        selectModel,
        refreshPage,
        allowRefresh: true,
        logger: vi.fn() as unknown as BrowserLogger,
      }),
    ).rejects.toBe(missing);
    expect(selectModel).toHaveBeenCalledTimes(2);
    expect(refreshPage).toHaveBeenCalledTimes(1);
  });

  test("merges the independently verified model and Pro mode before submit", () => {
    const evidence = __test__.mergeModeSelectionEvidence(
      {
        requestedModel: "GPT-5.6 Sol",
        resolvedLabel: "GPT-5.6 Sol",
        requestedModelLabel: "GPT-5.6 Sol",
        resolvedModelLabel: "GPT-5.6 Sol",
        modelVerified: true,
        strategy: "select",
        status: "already-selected",
        verified: true,
        source: "chatgpt-model-picker",
        capturedAt: "2026-07-09T00:00:00.000Z",
      },
      {
        requestedModelLabel: "GPT-5.6 Sol",
        resolvedModelLabel: "GPT-5.6 Sol",
        modelVerified: true,
        requestedMode: "Pro",
        resolvedModeLabel: "Pro",
        modeVerified: true,
        verifiedBeforePromptSubmit: true,
      },
    );

    expect(evidence).toMatchObject({
      resolvedLabel: "GPT-5.6 Sol + Pro",
      modelVerified: true,
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
      verified: true,
    });
    expect(() => __test__.assertProtectedSolProEvidence("GPT-5.6 Sol", evidence)).not.toThrow();
  });

  test("fails closed when only the model axis was verified", () => {
    expect(() =>
      __test__.assertProtectedSolProEvidence("GPT-5.6 Sol", {
        requestedModel: "GPT-5.6 Sol",
        resolvedLabel: "GPT-5.6 Sol",
        requestedModelLabel: "GPT-5.6 Sol",
        resolvedModelLabel: "GPT-5.6 Sol",
        modelVerified: true,
        requestedMode: "Pro",
        resolvedModeLabel: null,
        modeVerified: false,
        verifiedBeforePromptSubmit: false,
        strategy: "select",
        status: "already-selected",
        verified: false,
        source: "chatgpt-model-picker",
        capturedAt: "2026-07-09T00:00:00.000Z",
      }),
    ).toThrow(/atomically verified/i);
  });

  test("re-runs both protected checks for every submit attempt", async () => {
    const selectModel = vi.fn(async () => ({
      requestedModel: "GPT-5.6 Sol",
      resolvedLabel: "GPT-5.6 Sol",
      requestedModelLabel: "GPT-5.6 Sol",
      resolvedModelLabel: "GPT-5.6 Sol",
      modelVerified: true,
      strategy: "select" as const,
      status: "already-selected" as const,
      verified: true,
      source: "chatgpt-model-picker" as const,
      capturedAt: "2026-07-09T00:00:00.000Z",
    }));
    const selectMode = vi.fn(async () => ({
      requestedModelLabel: "GPT-5.6 Sol",
      resolvedModelLabel: "GPT-5.6 Sol",
      modelVerified: true,
      requestedMode: "Pro",
      resolvedModeLabel: "Pro",
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
    }));
    const verifyAttempt = () =>
      __test__.verifyProtectedSolProSelectionForSubmit({
        desiredModel: "GPT-5.6 Sol",
        modelStrategy: "select",
        thinkingTime: "extended",
        selectModel,
        selectMode,
      });

    await expect(verifyAttempt()).resolves.toMatchObject({ verified: true });
    await expect(verifyAttempt()).resolves.toMatchObject({ verified: true });
    expect(selectModel).toHaveBeenCalledTimes(2);
    expect(selectMode).toHaveBeenCalledTimes(2);
  });

  test("runs mutating protected-route selection before attachment preparation", async () => {
    const events: string[] = [];
    await __test__.prepareSubmissionComposerWithProtectedRoute({
      hasAttachments: true,
      verifyProtectedRoute: async () => {
        events.push("select-route");
      },
      prepareComposer: async () => {
        events.push("prepare-composer");
      },
      prepareMutatingComposerMode: async () => {
        events.push("activate-deep-research");
      },
      prepareAttachments: async () => {
        events.push("upload-attachment");
      },
    });

    expect(events).toEqual([
      "select-route",
      "prepare-composer",
      "activate-deep-research",
      "upload-attachment",
    ]);
  });

  test("fails closed before upload when protected-route verification fails", async () => {
    const prepareComposer = vi.fn();
    const activateDeepResearch = vi.fn();
    const uploadAttachment = vi.fn();

    await expect(
      __test__.prepareSubmissionComposerWithProtectedRoute({
        hasAttachments: true,
        verifyProtectedRoute: async () => {
          throw new Error("Sol + Pro not verified");
        },
        prepareComposer,
        prepareMutatingComposerMode: activateDeepResearch,
        prepareAttachments: uploadAttachment,
      }),
    ).rejects.toThrow(/not verified/i);

    expect(prepareComposer).not.toHaveBeenCalled();
    expect(activateDeepResearch).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  test("fails closed before upload when Deep Research activation fails", async () => {
    const uploadAttachment = vi.fn();

    await expect(
      __test__.prepareSubmissionComposerWithProtectedRoute({
        hasAttachments: true,
        verifyProtectedRoute: async () => {},
        prepareComposer: async () => {},
        prepareMutatingComposerMode: async () => {
          throw new Error("Deep Research unavailable");
        },
        prepareAttachments: uploadAttachment,
      }),
    ).rejects.toThrow(/Deep Research unavailable/i);

    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  test("preserves the historical last-moment selection order for text-only runs", async () => {
    const events: string[] = [];
    await __test__.prepareSubmissionComposerWithProtectedRoute({
      hasAttachments: false,
      verifyProtectedRoute: async () => {
        events.push("select-route");
      },
      prepareComposer: async () => {
        events.push("prepare-text-composer");
      },
      prepareMutatingComposerMode: async () => {
        events.push("activate-deep-research");
      },
      prepareAttachments: async () => {},
    });

    expect(events).toEqual(["prepare-text-composer", "activate-deep-research", "select-route"]);
  });

  test("refuses a protected submit before running selectors when policy was weakened", async () => {
    const selectModel = vi.fn();
    const selectMode = vi.fn();
    await expect(
      __test__.verifyProtectedSolProSelectionForSubmit({
        desiredModel: "GPT-5.6 Sol",
        modelStrategy: "current",
        thinkingTime: "extended",
        selectModel,
        selectMode,
      }),
    ).rejects.toThrow(/before every prompt submission/i);
    expect(selectModel).not.toHaveBeenCalled();
    expect(selectMode).not.toHaveBeenCalled();
  });
});

describe("formatBrowserTurnTranscript", () => {
  test("keeps single-turn browser output unchanged", () => {
    expect(
      formatBrowserTurnTranscript([
        {
          label: "Initial response",
          answerText: "plain answer",
          answerMarkdown: "**plain answer**",
        },
      ]),
    ).toEqual({
      answerText: "plain answer",
      answerMarkdown: "**plain answer**",
    });
  });

  test("formats multi-turn consult output with follow-up prompts", () => {
    const result = formatBrowserTurnTranscript([
      {
        label: "Initial response",
        answerText: "initial answer",
        answerMarkdown: "initial answer",
      },
      {
        label: "Follow-up 1",
        prompt: "Challenge your previous recommendation.",
        answerText: "revised answer",
        answerMarkdown: "revised answer",
      },
    ]);

    expect(result.answerMarkdown).toContain("## Initial response");
    expect(result.answerMarkdown).toContain("## Follow-up 1");
    expect(result.answerMarkdown).toContain(
      "### Prompt\n\nChallenge your previous recommendation.",
    );
    expect(result.answerMarkdown).toContain("### Answer\n\nrevised answer");
    expect(result.answerText).toBe(result.answerMarkdown);
  });
});

describe("enableFocusEmulation", () => {
  test("enables CDP focus emulation and logs the given label", async () => {
    const setFocusEmulationEnabled = vi.fn().mockResolvedValue(undefined);
    const client = { Emulation: { setFocusEmulationEnabled } };
    const logger = vi.fn();

    await __test__.enableFocusEmulation(client as never, logger, "local tab");

    expect(setFocusEmulationEnabled).toHaveBeenCalledWith({ enabled: true });
    expect(logger).toHaveBeenCalledWith("[browser] Focus emulation enabled for local tab");
  });

  test("logs a diagnostic instead of throwing when the CDP call is unavailable", async () => {
    const setFocusEmulationEnabled = vi.fn().mockRejectedValue(new Error("not supported"));
    const client = { Emulation: { setFocusEmulationEnabled } };
    const logger = vi.fn();

    await expect(
      __test__.enableFocusEmulation(client as never, logger, "remote target"),
    ).resolves.toBeUndefined();

    expect(logger).toHaveBeenCalledWith("[browser] Focus emulation unavailable: not supported");
  });
});

describe("ChatGPT UI warning detection", () => {
  test("classifies request-speed warnings as rate limits", () => {
    expect(
      __test__.classifyChatGptUiWarningText(
        "You are sending too many requests too quickly. Please try again later.",
      ),
    ).toBe("rate_limit");
  });

  test("classifies explicit quota warnings as rate limits", () => {
    expect(__test__.classifyChatGptUiWarningText("Rate limit exceeded.")).toBe("rate_limit");
    expect(__test__.classifyChatGptUiWarningText("You are being rate limited.")).toBe("rate_limit");
  });

  test("does not classify ordinary rate-limiter task titles as warnings", () => {
    expect(__test__.classifyChatGptUiWarningText("API Rate Limiter Review")).toBeNull();
  });

  test("classifies visually mangled request-speed modal text as rate limits", () => {
    expect(
      __test__.classifyChatGptUiWarningText(
        "Too many reque t. You’re making reque t too quickly. We’ve temporarily limited access to your conversations. Please wait a few minutes before trying again.",
      ),
    ).toBe("rate_limit");
  });

  test("classifies bare retry-later warnings as temporary unavailability", () => {
    expect(__test__.classifyChatGptUiWarningText("Try again later.")).toBe("temporary_unavailable");
  });

  test("collects visible warning candidates from the browser DOM", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "You are sending too many requests too quickly. Please try again later.",
              source: "selector",
              role: "alert",
              ariaLive: "assertive",
              selector: '[role="alert"]',
            },
            {
              text: "ordinary page text",
              source: "visible-warning-text",
            },
          ],
        },
      }),
    };

    await expect(__test__.collectChatGptUiWarnings(Runtime as never)).resolves.toEqual([
      {
        type: "rate_limit",
        message: "You are sending too many requests too quickly. Please try again later.",
        source: "selector",
        role: "alert",
        ariaLive: "assertive",
        selector: '[role="alert"]',
      },
    ]);
    const expression = Runtime.evaluate.mock.calls[0]?.[0]?.expression;
    expect(expression).not.toContain("createTreeWalker");
    expect(expression).not.toContain('[class*="error" i]');
    expect(expression).not.toContain('[class*="warning" i]');
    expect(expression).toContain("current = current.parentElement");
    expect(expression).toContain("Number.parseFloat(currentStyle.opacity || '1') === 0");
  });

  test("redacts account and token-like values from warning details", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "Sign in as private@example.test with session_token=secret-session-value",
              source: "selector",
              role: "dialog",
              selector: '[role="dialog"]',
            },
          ],
        },
      }),
    };

    const warnings = await __test__.collectChatGptUiWarnings(Runtime as never);
    expect(warnings).toEqual([
      {
        type: "auth_or_challenge",
        message: "Sign in as [redacted-email] with session_token=[redacted]",
        source: "selector",
        role: "dialog",
        ariaLive: null,
        selector: '[role="dialog"]',
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("private@example.test");
    expect(JSON.stringify(warnings)).not.toContain("secret-session-value");
  });

  test("builds a structured timeout error when ChatGPT shows a blocking warning", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "You are sending too many requests too quickly. Please try again later.",
              source: "selector",
              role: "alert",
              ariaLive: "assertive",
              selector: '[role="alert"]',
            },
          ],
        },
      }),
    };
    const logger = vi.fn<(message: string) => void>();

    const error = await __test__.createAssistantTimeoutError({
      Runtime: Runtime as never,
      logger: logger as never,
      runtime: { chromePort: 9222 },
      diagnostics: { domPath: "/tmp/assistant-timeout.dom.json" },
      cause: new Error("timeout"),
    });

    expect(error.message).toContain("rate-limit warning");
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      code: "chatgpt-ui-warning",
      runtime: { chromePort: 9222 },
      diagnostics: { domPath: "/tmp/assistant-timeout.dom.json" },
      uiWarning: {
        type: "rate_limit",
        message: "You are sending too many requests too quickly. Please try again later.",
      },
    });
    expect(logger).toHaveBeenCalledWith(
      "[browser] ChatGPT UI warning detected (rate_limit): You are sending too many requests too quickly. Please try again later.",
    );
  });

  test("keeps the generic timeout error when no blocking warning is visible", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: [] } }),
    };

    const error = await __test__.createAssistantTimeoutError({
      Runtime: Runtime as never,
      logger: vi.fn() as never,
      runtime: { chromePort: 9222 },
      cause: new Error("timeout"),
    });

    expect(error.message).toBe(
      "Assistant response timed out before completion; reattach later to capture the answer.",
    );
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      runtime: { chromePort: 9222 },
    });
    expect(error.details).not.toHaveProperty("uiWarning");
  });

  test("routes plain response observer timeouts through assistant timeout handling", () => {
    expect(__test__.isAssistantResponseTimeoutError(new Error("Response timeout"))).toBe(true);
    expect(__test__.isAssistantResponseTimeoutError(new Error("Navigation timeout"))).toBe(false);
  });

  test("does not rewrite typed capture-binding failures as assistant timeouts", () => {
    const captureBinding = new BrowserAutomationError(
      "Captured assistant response failed structural binding validation.",
      { stage: "capture-binding", code: "capture-not-after-submitted-user" },
    );
    const timeout = new BrowserAutomationError("Assistant response timed out.", {
      stage: "assistant-timeout",
    });
    const recheckSessionError = new BrowserAutomationError(
      "ChatGPT session expired during recheck.",
      { stage: "assistant-recheck" },
    );

    expect(__test__.isAssistantResponseTimeoutError(captureBinding)).toBe(false);
    expect(__test__.shouldReloadAfterAssistantError(captureBinding)).toBe(false);
    expect(__test__.isAssistantResponseTimeoutError(timeout)).toBe(true);
    expect(__test__.shouldReloadAfterAssistantError(timeout)).toBe(true);
    expect(__test__.isAssistantResponseTimeoutError(recheckSessionError)).toBe(false);
    expect(__test__.shouldReloadAfterAssistantError(recheckSessionError)).toBe(false);
  });
});

describe("assistant canonical reload recovery", () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;

  test("hydrates the same canonical conversation before its one retry", async () => {
    const sequence: string[] = [];
    const Runtime = {
      evaluate: vi.fn().mockImplementation(async () => {
        sequence.push("read-url");
        return { result: { value: conversationUrl } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const Page = {
      navigate: vi.fn().mockImplementation(async () => {
        sequence.push("navigate");
      }),
    } as unknown as ChromeClient["Page"];
    const firstError = new Error(
      "assistant-response short capture could not be confirmed before timeout",
    );
    const waitForResponse = vi
      .fn()
      .mockImplementationOnce(async () => {
        sequence.push("capture-1");
        throw firstError;
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        sequence.push("capture-2");
        expect(args[4]).toBe(conversationId);
        return {
          text: "DIAG-OK",
          meta: { turnId: "conversation-turn-2", messageId: "assistant-message" },
        };
      });
    const waitForHydration = vi.fn().mockImplementation(async () => {
      sequence.push("hydrate");
      return 2;
    });
    const wait = vi.fn().mockImplementation(async () => {
      sequence.push("delay");
    });
    const assertAccess = vi.fn().mockImplementation(async (...args: unknown[]) => {
      sequence.push("access");
      expect(args[2]).toEqual({ quarantine: { accountId: "acct1" } });
    });
    const now = vi.fn().mockReturnValueOnce(10_000).mockReturnValueOnce(25_000);

    await expect(
      __test__.waitForAssistantResponseWithReload(
        Runtime,
        Page,
        30_000,
        vi.fn() as unknown as BrowserLogger,
        1,
        conversationId,
        "acct1",
        {
          waitForResponse: waitForResponse as never,
          waitForHydration: waitForHydration as never,
          wait,
          assertAccess,
          elapsedBaselineMs: 70_000,
          now,
        },
      ),
    ).resolves.toMatchObject({ text: "DIAG-OK" });

    expect(sequence).toEqual([
      "capture-1",
      "read-url",
      "delay",
      "navigate",
      "access",
      "hydrate",
      "capture-2",
    ]);
    expect(wait).toHaveBeenCalledWith(1_500);
    expect(Page.navigate).toHaveBeenCalledOnce();
    expect(Page.navigate).toHaveBeenCalledWith({ url: conversationUrl });
    expect(assertAccess).toHaveBeenCalledOnce();
    expect(waitForHydration).toHaveBeenCalledWith(Runtime, 30_000, expect.any(Function), {
      ensurePromptReady: expect.any(Function),
      requirePriorTurns: true,
      expectedConversationUrl: conversationUrl,
    });
    // The fallback surface receives no Input domain and performs no submit or
    // click; its only page mutation is the one canonical navigation above.
    expect(Runtime.evaluate).toHaveBeenCalledTimes(1);
    expect(waitForResponse).toHaveBeenCalledTimes(2);
    expect(waitForResponse.mock.calls[0]?.[6]).toBe(70_000);
    expect(waitForResponse.mock.calls[1]?.[6]).toBe(85_000);
  });

  test("refuses to reopen a different canonical conversation", async () => {
    const wrongConversationUrl = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
    const firstError = new Error("assistant-response watchdog timeout");
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: wrongConversationUrl } }),
    } as unknown as ChromeClient["Runtime"];
    const Page = { navigate: vi.fn() } as unknown as ChromeClient["Page"];
    const waitForResponse = vi.fn().mockRejectedValue(firstError);
    const waitForHydration = vi.fn();
    const wait = vi.fn();

    await expect(
      __test__.waitForAssistantResponseWithReload(
        Runtime,
        Page,
        30_000,
        vi.fn() as unknown as BrowserLogger,
        1,
        conversationId,
        "acct1",
        {
          waitForResponse: waitForResponse as never,
          waitForHydration: waitForHydration as never,
          wait,
        },
      ),
    ).rejects.toBe(firstError);

    expect(Page.navigate).not.toHaveBeenCalled();
    expect(waitForHydration).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(waitForResponse).toHaveBeenCalledOnce();
  });

  test("refuses to adopt the current conversation when no expected canonical id is bound", async () => {
    const firstError = new Error("assistant-response watchdog timeout");
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: conversationUrl } }),
    } as unknown as ChromeClient["Runtime"];
    const Page = { navigate: vi.fn() } as unknown as ChromeClient["Page"];
    const waitForResponse = vi.fn().mockRejectedValue(firstError);
    const waitForHydration = vi.fn();
    const wait = vi.fn();

    await expect(
      __test__.waitForAssistantResponseWithReload(
        Runtime,
        Page,
        30_000,
        vi.fn() as unknown as BrowserLogger,
        1,
        undefined,
        "acct1",
        {
          waitForResponse: waitForResponse as never,
          waitForHydration: waitForHydration as never,
          wait,
        },
      ),
    ).rejects.toBe(firstError);

    expect(Page.navigate).not.toHaveBeenCalled();
    expect(waitForHydration).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(waitForResponse).toHaveBeenCalledOnce();
  });
});

describe("browser follow-ups", () => {
  test("rejects copy-profile with manual-login before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          manualLogin: true,
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*browser-manual-login/i);
  });

  test("rejects copy-profile with existing-browser modes before connecting", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          attachRunning: true,
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*remote Chrome/i);
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9222 },
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*remote Chrome/i);
  });

  test("rejects Deep Research follow-ups before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "research this",
        followUpPrompts: ["now challenge the report"],
        config: { researchMode: "deep" },
      }),
    ).rejects.toThrow(/follow-ups are not supported with Deep Research/i);
  });
});

describe("browser conversation archiving", () => {
  test("does not attempt archive when required local artifacts were not saved", async () => {
    const runtime = {
      evaluate: vi.fn(),
    };
    const log = vi.fn();

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: log as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
        requiredArtifactsSaved: false,
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: false,
      archived: false,
      reason: "artifact-save-failed",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("does not auto-archive suspiciously short captured answers", async () => {
    const runtime = {
      evaluate: vi.fn(),
    };
    const log = vi.fn();

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: log as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        conversationUrl: "https://chatgpt.com/c/abc",
        answerText: "I",
        followUpCount: 0,
        requiredArtifactsSaved: true,
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: false,
      archived: false,
      reason: "suspicious-short-answer",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[browser] ChatGPT archive skipped (suspicious-short-answer).",
    );
  });
});

describe("remote Chrome option warnings", () => {
  test("does not mark browser-chrome-path as ignored for attach-running", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: true,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).not.toContain("--browser-chrome-path");
  });

  test("marks browser-chrome-path as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).toContain("--browser-chrome-path");
  });
});

describe("remote Chrome cleanup", () => {
  test("unrefs a kept browser so the CLI can exit after preserving Chrome", () => {
    const unref = vi.fn();

    __test__.detachKeptChromeProcess({
      process: { unref } as never,
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("closes the dedicated target after a completed run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "complete",
    });

    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(closeClient).not.toHaveBeenCalled();
  });

  test("only detaches from the target after an incomplete run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "attempted",
    });

    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("detaches raw target clients when a run attaches to an existing remote tab", async () => {
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: null,
      client: { close: closeClient },
      runStatus: "complete",
    });

    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("does not close an already-lost connection", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: true,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "attempted",
    });

    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeClient).not.toHaveBeenCalled();
  });
});

describe("image-only assistant turn detection", () => {
  test("treats ChatGPT image-only chrome text as non-answer UI", () => {
    expect(__test__.isImageOnlyUiChromeText("Stopped thinking\nEdit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("PR169_IMAGE_OK")).toBe(false);
  });
});

describe("redactBrowserConfigForDebugLogForTest", () => {
  test("redacts inline cookie values while preserving count context", () => {
    const redacted = redactBrowserConfigForDebugLogForTest({
      inlineCookies: [
        { name: "__Secure-next-auth.session-token", value: "secret-token" },
        { name: "_account", value: "secret-account" },
      ],
      inlineCookiesSource: "inline-file",
      debug: true,
    });

    expect(redacted).toMatchObject({
      inlineCookies: "[redacted:2 cookies]",
      inlineCookieCount: 2,
      inlineCookiesSource: "inline-file",
      debug: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("secret-account");
  });

  test("leaves missing inline cookies unchanged", () => {
    expect(redactBrowserConfigForDebugLogForTest({ debug: true })).toEqual({ debug: true });
  });
});

describe("shouldPreferSystemTmpDirForTest", () => {
  test("prefers /tmp for Linux tmpdirs under a hidden home segment", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.tmp", "/home/openclaw")).toBe(
      true,
    );
    expect(
      shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.cache/tmp", "/home/openclaw"),
    ).toBe(true);
  });

  test("keeps normal Linux tmpdirs and non-Linux platforms unchanged", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/tmp", "/home/openclaw")).toBe(false);
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/tmp", "/home/openclaw")).toBe(
      false,
    );
    expect(shouldPreferSystemTmpDirForTest("darwin", "/Users/me/.tmp", "/Users/me")).toBe(false);
  });

  test("does not treat sibling home paths as inside the home directory", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw2/.tmp", "/home/openclaw")).toBe(
      false,
    );
  });
});

describe("runSubmissionWithRecoveryForTest", () => {
  test("preserves prompt-too-large fallback after a dead-composer retry", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAutomationError("dead composer", { code: "dead-composer" }))
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockResolvedValueOnce({
        baselineTurns: 7,
        baselineAssistantText: "done",
      });
    const reloadPromptComposer = vi.fn().mockResolvedValue(undefined);
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn<(message: string) => void>();

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [{ path: "/tmp/fallback.txt", displayPath: "fallback.txt", sizeBytes: 12 }],
        },
        submit,
        reloadPromptComposer,
        prepareFallbackSubmission,
        logger,
      }),
    ).resolves.toEqual({
      baselineTurns: 7,
      baselineAssistantText: "done",
    });

    expect(reloadPromptComposer).toHaveBeenCalledTimes(1);
    expect(prepareFallbackSubmission).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "[browser] Inline prompt too large; retrying with file uploads.",
    );
    expect(submit).toHaveBeenNthCalledWith(1, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(2, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(3, "fallback prompt", [
      expect.objectContaining({ displayPath: "fallback.txt" }),
    ]);
  });

  test("throws when prompt-too-large happens again after fallback", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large again", { code: "prompt-too-large" }),
      );

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission: vi.fn().mockResolvedValue(undefined),
        logger: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toThrow(/prompt too large again/i);
  });

  test("never submits a fallback after an ambiguous post-dispatch commit timeout", async () => {
    const commitTimeout = new BrowserAutomationError("prompt commit was not observed", {
      stage: "submit-prompt",
      code: "prompt-commit-timeout",
      retryable: false,
    });
    const submit = vi.fn().mockRejectedValue(commitTimeout);
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "x".repeat(50_000),
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [{ path: "/tmp/fallback.txt", displayPath: "fallback.txt", sizeBytes: 12 }],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission,
        logger: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toBe(commitTimeout);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(prepareFallbackSubmission).not.toHaveBeenCalled();
  });
});

describe("resolveRemoteTabLeaseProfileDirForTest", () => {
  test("coordinates remote Chrome only when a manual-login profile is configured", () => {
    const coordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(coordinated)).toBe(
      path.resolve("/tmp/oracle-profile"),
    );

    const uncoordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: false,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(uncoordinated)).toBeNull();
  });
});

describe("isLocalChromeHostForTest", () => {
  test.each(["localhost", "LOCALHOST", "127.0.0.1", "127.12.34.56", "::1", "[::1]"])(
    "accepts loopback host %s",
    (host) => {
      expect(isLocalChromeHostForTest(host)).toBe(true);
    },
  );

  test.each(["remote-host", "192.168.1.5", "10.0.0.2", "2001:db8::1"])(
    "rejects remote host %s",
    (host) => {
      expect(isLocalChromeHostForTest(host)).toBe(false);
    },
  );
});

describe("pollConversationUrlForTest", () => {
  const instantDelay = async () => {};

  test("persists the conversation URL once it appears", async () => {
    const urls = ["https://chatgpt.com/", "https://chatgpt.com/", "https://chatgpt.com/c/abc-123"];
    let reads = 0;
    const onConversationUrl = vi.fn(async () => {});

    const found = await pollConversationUrlForTest({
      readUrl: async () => urls[Math.min(reads++, urls.length - 1)],
      onConversationUrl,
      timeoutMs: 5_000,
      delayFn: instantDelay,
    });

    expect(found).toBe(true);
    expect(onConversationUrl).toHaveBeenCalledTimes(1);
    expect(onConversationUrl).toHaveBeenCalledWith("https://chatgpt.com/c/abc-123");
  });

  test("keeps polling through read errors until the URL appears", async () => {
    let reads = 0;
    const onConversationUrl = vi.fn(async () => {});

    const found = await pollConversationUrlForTest({
      readUrl: async () => {
        reads += 1;
        if (reads < 3) {
          throw new Error("evaluate failed");
        }
        return "https://chatgpt.com/c/def-456";
      },
      onConversationUrl,
      timeoutMs: 5_000,
      delayFn: instantDelay,
    });

    expect(found).toBe(true);
    expect(reads).toBe(3);
  });

  test("stops when the caller marks the loop stopped", async () => {
    let stopped = false;
    let reads = 0;
    const onConversationUrl = vi.fn(async () => {});

    const found = await pollConversationUrlForTest({
      readUrl: async () => {
        reads += 1;
        if (reads >= 2) {
          stopped = true;
        }
        return "https://chatgpt.com/";
      },
      isStopped: () => stopped,
      onConversationUrl,
      timeoutMs: 60_000,
      delayFn: instantDelay,
    });

    expect(found).toBe(false);
    expect(onConversationUrl).not.toHaveBeenCalled();
  });

  test("does not treat the ChatGPT root URL as a conversation", async () => {
    const onConversationUrl = vi.fn(async () => {});

    const found = await pollConversationUrlForTest({
      readUrl: async () => "https://chatgpt.com/",
      onConversationUrl,
      timeoutMs: 50,
      delayFn: instantDelay,
    });

    expect(found).toBe(false);
    expect(onConversationUrl).not.toHaveBeenCalled();
  });

  test("does not persist the transient /c/WEB:<uuid> route", async () => {
    const urls = [
      "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
      "https://chatgpt.com/c/6a5fc6a9-a724-83e8-a224-75b57da507ea",
    ];
    let reads = 0;
    const onConversationUrl = vi.fn(async () => {});

    const found = await pollConversationUrlForTest({
      readUrl: async () => urls[Math.min(reads++, urls.length - 1)],
      onConversationUrl,
      timeoutMs: 5_000,
      delayFn: instantDelay,
    });

    expect(found).toBe(true);
    expect(onConversationUrl).toHaveBeenCalledOnce();
    expect(onConversationUrl).toHaveBeenCalledWith(
      "https://chatgpt.com/c/6a5fc6a9-a724-83e8-a224-75b57da507ea",
    );
  });
});

describe("post-capture structural binding", () => {
  const bindingProbe = {
    found: true,
    matchedPrompt: true,
    conversationId: "run-conversation",
    userMessageId: "user-message",
    userTurnTestId: "conversation-turn-1",
  };
  const goodFacts = {
    conversationId: "run-conversation",
    userTurnFound: true,
    userTurnIsLatestUserTurn: true,
    capturedNodeFound: true,
    capturedFollowsUserMessage: true,
    interveningAssistantTurns: 0,
    assistantTurnAfterUserMessage: true,
  };

  function runtimeWithValues(values: unknown[]): ChromeClient["Runtime"] & {
    evaluate: ReturnType<typeof vi.fn>;
  } {
    const queue = [...values];
    const evaluate = vi.fn(async () => ({
      result: { value: queue.length > 1 ? queue.shift() : queue[0] },
    }));
    return { evaluate } as unknown as ChromeClient["Runtime"] & {
      evaluate: ReturnType<typeof vi.fn>;
    };
  }

  test("generated-image capture rejects a response from another conversation", async () => {
    const generatedImage = {
      text: "Generated image.",
      html: '<img src="/backend-api/estuary/content?id=file_generated">',
      messageId: "foreign-assistant",
      turnId: "conversation-turn-3",
      turnIndex: 2,
      afterLatestUser: true,
    };
    const runtime = runtimeWithValues([
      bindingProbe,
      generatedImage,
      { ...goodFacts, conversationId: "foreign-conversation" },
    ]);
    await registerSubmittedUserMessage(runtime, "draw a diagram", () => {});

    await expect(
      __test__.waitForAssistantOrGeneratedImageResponse({
        Runtime: runtime,
        waitForText: async () => {
          throw new Error("text path should not run");
        },
        timeoutMs: 1_000,
        minTurnIndex: 1,
        expectedConversationId: "run-conversation",
        imageOutputRequested: true,
        logger: vi.fn() as BrowserLogger,
      }),
    ).rejects.toMatchObject({
      details: { code: "capture-binding-conversation-changed" },
    });

    expect(
      runtime.evaluate.mock.calls.some(([params]) =>
        String(params.expression).includes('const EXPECTED_CONVERSATION_ID = "run-conversation"'),
      ),
    ).toBe(true);
  });

  test("delayed long-response replacement is revalidated before it can overwrite the answer", async () => {
    const original = "a".repeat(600);
    const replacement = {
      text: "b".repeat(700),
      messageId: "foreign-assistant",
      turnId: "conversation-turn-3",
      turnIndex: 2,
      afterLatestUser: true,
    };
    const runtime = runtimeWithValues([
      bindingProbe,
      replacement,
      replacement,
      { ...goodFacts, conversationId: "foreign-conversation" },
    ]);
    await registerSubmittedUserMessage(runtime, "review this plan", () => {});

    await expect(
      __test__.maybeRecoverLongAssistantResponse({
        runtime,
        baselineTurns: 1,
        expectedConversationId: "run-conversation",
        answerText: original,
        answerMarkdown: original,
        logger: vi.fn() as BrowserLogger,
        allowMarkdownUpdate: true,
        wait: async () => {},
      }),
    ).rejects.toMatchObject({
      details: { code: "capture-binding-conversation-changed" },
    });

    expect(
      runtime.evaluate.mock.calls.some(([params]) =>
        String(params.expression).includes('const EXPECTED_CONVERSATION_ID = "run-conversation"'),
      ),
    ).toBe(true);
  });

  test("delayed long-response replacement returns after binding verification", async () => {
    const original = "a".repeat(600);
    const replacement = {
      text: "b".repeat(700),
      messageId: "owned-assistant",
      turnId: "conversation-turn-3",
      turnIndex: 2,
      afterLatestUser: true,
    };
    const runtime = runtimeWithValues([bindingProbe, replacement, replacement, goodFacts]);
    await registerSubmittedUserMessage(runtime, "review this plan", () => {});
    const logs: string[] = [];

    await expect(
      __test__.maybeRecoverLongAssistantResponse({
        runtime,
        baselineTurns: 1,
        expectedConversationId: "run-conversation",
        answerText: original,
        answerMarkdown: original,
        logger: (message) => logs.push(String(message)),
        allowMarkdownUpdate: true,
        wait: async () => {},
      }),
    ).resolves.toEqual({
      answerText: replacement.text,
      answerMarkdown: replacement.text,
    });
    expect(logs.join("\n")).toContain("Structural capture binding verified");
  });

  test("alternate snapshot replacements never mutate the answer when binding fails", async () => {
    const runtime = runtimeWithValues([
      bindingProbe,
      { ...goodFacts, userTurnIsLatestUserTurn: false },
    ]);
    await registerSubmittedUserMessage(runtime, "review this plan", () => {});
    const replace = vi.fn(() => "foreign answer");

    await expect(
      __test__.applyBoundAssistantSnapshotReplacement(
        runtime,
        { messageId: "foreign-assistant", turnId: "conversation-turn-5" },
        vi.fn() as BrowserLogger,
        replace,
      ),
    ).rejects.toMatchObject({
      details: { code: "capture-binding-user-message-superseded" },
    });

    expect(replace).not.toHaveBeenCalled();
  });

  test("alternate snapshot replacements apply only after binding verification", async () => {
    const runtime = runtimeWithValues([bindingProbe, goodFacts]);
    await registerSubmittedUserMessage(runtime, "review this plan", () => {});
    const replace = vi.fn(() => "owned answer");

    await expect(
      __test__.applyBoundAssistantSnapshotReplacement(
        runtime,
        { messageId: "owned-assistant", turnId: "conversation-turn-3" },
        vi.fn() as BrowserLogger,
        replace,
      ),
    ).resolves.toBe("owned answer");

    expect(replace).toHaveBeenCalledOnce();
  });
});
