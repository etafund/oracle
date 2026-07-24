import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Writable } from "node:stream";
import type { SessionMetadata } from "../../src/sessionManager.js";
import { buildRemoteBrowserPreSubmitDiagnostic } from "../../src/remote/types.js";

const state = vi.hoisted(() => ({ current: null as SessionMetadata | null }));
const recoverMock = vi.hoisted(() => vi.fn());
const deleteSecretMock = vi.hoisted(() => vi.fn());
const updateSessionMock = vi.hoisted(() => vi.fn());
const updateModelRunMock = vi.hoisted(() => vi.fn());
const logLineMock = vi.hoisted(() => vi.fn());
const saveTranscriptMock = vi.hoisted(() => vi.fn());
const saveReportMock = vi.hoisted(() => vi.fn(async () => null));
const claimMock = vi.hoisted(() => vi.fn());
const releaseClaimMock = vi.hoisted(() => vi.fn());
const promotePendingMock = vi.hoisted(() => vi.fn());
const resumeBrowserSessionMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn(async (metadata: SessionMetadata) => metadata));

const sessionStoreMock = vi.hoisted(() => ({
  readSession: vi.fn(),
  readLog: vi.fn(),
  readModelLog: vi.fn(),
  readRequest: vi.fn(),
  updateSession: updateSessionMock,
  updateModelRun: updateModelRunMock,
  createLogWriter: vi.fn(),
  getPaths: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  sessionsDir: vi.fn(() => "/tmp/sessions"),
}));

vi.mock("../../src/sessionStore.js", () => ({
  sessionStore: sessionStoreMock,
  wait: vi.fn(async () => undefined),
}));

vi.mock("../../src/sessionManager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sessionManager.js")>()),
  reconcileSessionMetadataForCompletionClaim: reconcileMock,
}));

vi.mock("../../src/remote/sessionRecovery.js", () => ({
  claimRemoteBrowserRecoveryCompletion: claimMock,
  isFailedRemoteBrowserOrigin: (metadata: SessionMetadata) =>
    Boolean(metadata.browser?.remoteRecovery) ||
    metadata.browser?.remoteRun?.terminalDoneOk === false,
  isRemoteBrowserRecoveryCompletionPersisted: () => false,
  recoverStoredRemoteBrowserSession: recoverMock,
  promotePendingRemoteBrowserRecoveryClaim: promotePendingMock,
  ownsRemoteBrowserRecoveryCompletion: (
    metadata: SessionMetadata,
    claim: { claimId: string; originRunId: string },
  ) =>
    !Object.prototype.hasOwnProperty.call(metadata.error?.details ?? {}, "preSubmitDiagnostic") &&
    metadata.browser?.remoteRecoveryCompletionClaim?.claimId === claim.claimId &&
    metadata.browser?.remoteRecovery?.originRunId === claim.originRunId,
  releaseRemoteBrowserRecoveryCompletion: releaseClaimMock,
  RemoteBrowserRecoveryUnavailableError: class RemoteBrowserRecoveryUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RemoteBrowserRecoveryUnavailableError";
    }
  },
}));

vi.mock("../../src/remote/sessionRecoveryStore.js", () => ({
  deleteRemoteBrowserRecoverySecret: deleteSecretMock,
}));

vi.mock("../../src/browser/reattach.js", () => ({
  resumeBrowserSession: resumeBrowserSessionMock,
}));

vi.mock("node:fs/promises", () => ({
  default: { writeFile: writeFileMock },
}));

vi.mock("../../src/browser/artifacts.js", () => ({
  appendArtifacts: (existing: unknown[] | undefined, additions: unknown[]) => [
    ...(existing ?? []),
    ...additions.filter(Boolean),
  ],
  saveBrowserTranscriptArtifact: saveTranscriptMock,
  saveDeepResearchReportArtifact: saveReportMock,
}));

function recoveryMetadata(
  originRunId: string,
): NonNullable<SessionMetadata["browser"]>["remoteRecovery"] {
  return {
    schema: "remote-browser-recovery-public.v1",
    stage: "assistant-recheck",
    originRunId,
    expiresAt: "2026-07-22T12:00:00.000Z",
    accountId: "acct1",
    laneId: "acct1-9473",
    runtime: {
      tabUrl: `https://chatgpt.com/c/${originRunId}`,
      conversationId: originRunId,
      promptSubmitted: true,
    },
  };
}

function failedRemoteSession(originRunId: string): SessionMetadata {
  return {
    id: "remote-session",
    createdAt: "2026-07-22T00:00:00.000Z",
    status: "error",
    mode: "browser",
    model: "gpt-5.6-pro",
    options: {},
    response: { status: "incomplete", incompleteReason: "timeout" },
    browser: {
      config: { timeoutMs: 2_400_000 },
      runtime: recoveryMetadata(originRunId)?.runtime,
      remoteRun: {
        runId: originRunId,
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: false,
        provenance: null,
      },
      remoteRecovery: recoveryMetadata(originRunId),
    },
  } as SessionMetadata;
}

function failedLocalSession(): SessionMetadata {
  const current = failedRemoteSession("local-origin");
  const {
    remoteRun: _remoteRun,
    remoteRecovery: _remoteRecovery,
    remoteRecoveryCompletionClaim: _remoteRecoveryCompletionClaim,
    ...browser
  } = current.browser!;
  return {
    ...current,
    response: { status: "incomplete", incompleteReason: "incomplete-capture" },
    models: [
      {
        model: current.model!,
        status: "error",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
        error: { category: "browser-automation", message: "older capture failed" },
      },
    ],
    browser: {
      ...browser,
      runtime: {
        ...browser.runtime,
        tabUrl: "https://chatgpt.com/c/local-reattach",
        conversationId: "local-reattach",
        promptSubmitted: true,
      },
    },
  };
}

function preSubmitDiagnostic() {
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
  return diagnostic;
}

describe("sessionDisplay manual remote recovery ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    state.current = failedRemoteSession("origin-old");
    sessionStoreMock.readSession.mockImplementation(async () => state.current);
    sessionStoreMock.readLog.mockResolvedValue("Answer:\nprior failed capture\n");
    sessionStoreMock.readModelLog.mockResolvedValue("");
    sessionStoreMock.readRequest.mockResolvedValue({ prompt: "original prompt" });
    sessionStoreMock.createLogWriter.mockReturnValue({
      logLine: logLineMock,
      stream: { end: vi.fn() },
    });
    let updateTail: Promise<unknown> = Promise.resolve();
    updateSessionMock.mockImplementation(
      (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((current: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        const result = updateTail.then(async () => {
          if (!state.current) throw new Error("missing in-memory session");
          const patch = typeof updates === "function" ? await updates(state.current) : updates;
          state.current = { ...state.current, ...patch };
          return state.current;
        });
        updateTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    updateModelRunMock.mockResolvedValue({});
    deleteSecretMock.mockResolvedValue(true);
    saveTranscriptMock.mockResolvedValue({
      kind: "transcript",
      path: "/tmp/sessions/remote-session/artifacts/transcript.md",
    });
    promotePendingMock.mockResolvedValue(null);
    resumeBrowserSessionMock.mockReset();
    writeFileMock.mockResolvedValue(undefined);
    reconcileMock.mockImplementation(async (metadata: SessionMetadata) => metadata);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: "/tmp/sessions/remote-session",
      metadata: "/tmp/sessions/remote-session/meta.json",
      log: "/tmp/sessions/remote-session/session.log",
      request: "/tmp/sessions/remote-session/request.json",
    });
    claimMock.mockImplementation(async (_sessionId: string, originRunId: string) => {
      const current = state.current;
      if (
        !current?.browser ||
        current.browser.remoteRecovery?.originRunId !== originRunId ||
        current.browser.remoteRecoveryCompletionClaim
      ) {
        return null;
      }
      const claim = {
        schema: "remote-browser-recovery-completion-claim.v1" as const,
        originRunId,
        claimId: "claim-1",
        claimedAt: "2026-07-22T00:01:00.000Z",
        ownerPid: process.pid,
      };
      state.current = {
        ...current,
        browser: { ...current.browser, remoteRecoveryCompletionClaim: claim },
      };
      return claim;
    });
    releaseClaimMock.mockImplementation(async (_sessionId: string, claim: { claimId: string }) => {
      const current = state.current;
      if (current?.browser?.remoteRecoveryCompletionClaim?.claimId !== claim.claimId) {
        return false;
      }
      const { remoteRecoveryCompletionClaim: _claim, ...browser } = current.browser;
      state.current = { ...current, browser };
      return true;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("a stale completion cannot clear or complete a newer recovery attempt", async () => {
    const original = state.current;
    if (!original?.browser) throw new Error("missing fixture browser metadata");
    const originalBrowser = original.browser;
    const newerOriginRunId = "origin-new";
    state.current = {
      ...original,
      browser: {
        ...originalBrowser,
        remoteRun: {
          ...originalBrowser.remoteRun!,
          runId: newerOriginRunId,
        },
        remoteRecovery: recoveryMetadata(newerOriginRunId),
      },
    };
    sessionStoreMock.readSession
      .mockResolvedValueOnce(original)
      .mockImplementation(async () => state.current);

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(state.current).toMatchObject({
      status: "error",
      browser: {
        remoteRun: { runId: "origin-new" },
        remoteRecovery: { originRunId: "origin-new" },
      },
    });
    expect(updateModelRunMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).not.toHaveBeenCalled();
    expect(saveTranscriptMock).not.toHaveBeenCalled();
    expect(saveReportMock).not.toHaveBeenCalled();
    expect(sessionStoreMock.createLogWriter).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("newer remote recovery attempt or another completion writer"),
    );
  });

  test("a pending claim is promoted, freshly reloaded, recovered, and rendered", async () => {
    const pending = state.current;
    if (!pending?.browser) throw new Error("missing fixture browser metadata");
    const { remoteRecovery: _remoteRecovery, ...pendingBrowser } = pending.browser;
    state.current = { ...pending, browser: pendingBrowser };
    const staleBeforePromotion = state.current;
    promotePendingMock.mockImplementation(async () => {
      const current = state.current;
      if (!current?.browser) throw new Error("missing pending browser metadata");
      state.current = {
        ...current,
        browser: {
          ...current.browser,
          remoteRecovery: recoveryMetadata("origin-old"),
        },
      };
      // attachSession must reload from the store after promotion rather than
      // trusting this return value.
      return staleBeforePromotion;
    });
    recoverMock.mockResolvedValue({
      answerText: "promoted recovered answer",
      answerMarkdown: "promoted recovered answer",
      tookMs: 10,
      answerTokens: 3,
      answerChars: 25,
      tabUrl: "https://chatgpt.com/c/origin-old",
      conversationId: "origin-old",
      remoteRun: {
        runId: "origin-old",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: true,
        provenance: null,
      },
    });
    sessionStoreMock.readLog.mockImplementation(async () =>
      state.current?.status === "completed"
        ? "Answer:\npromoted recovered answer\n"
        : "Answer:\nprior failed capture\n",
    );

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", {
      suppressMetadata: true,
      renderMarkdown: true,
      renderPrompt: false,
    });

    expect(promotePendingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: expect.objectContaining({
          remoteRun: expect.objectContaining({ runId: "origin-old", terminalDoneOk: false }),
        }),
      }),
      expect.objectContaining({ log: expect.any(Function) }),
    );
    expect(claimMock).toHaveBeenCalledWith("remote-session", "origin-old");
    expect(promotePendingMock.mock.invocationCallOrder[0]).toBeLessThan(
      claimMock.mock.invocationCallOrder[0]!,
    );
    expect(recoverMock).toHaveBeenCalledWith(
      expect.objectContaining({
        browser: expect.objectContaining({
          remoteRecovery: expect.objectContaining({ originRunId: "origin-old" }),
        }),
      }),
      expect.objectContaining({
        completionClaim: expect.objectContaining({ originRunId: "origin-old" }),
      }),
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("promoted recovered answer"),
    );
    expect(state.current).toMatchObject({
      status: "completed",
      browser: {
        remoteRun: { runId: "origin-old", terminalDoneOk: true },
      },
    });
    expect(process.exitCode).toBeUndefined();
  });

  test("an unavailable pending claim fails closed before claiming or recovering", async () => {
    const pending = state.current;
    if (!pending?.browser) throw new Error("missing fixture browser metadata");
    const { remoteRecovery: _remoteRecovery, ...pendingBrowser } = pending.browser;
    state.current = { ...pending, browser: pendingBrowser };
    promotePendingMock.mockRejectedValue(
      new Error(
        "The stored post-submit recovery claim is not ready or is no longer available; the original prompt will not be replayed.",
      ),
    );

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", {
      suppressMetadata: true,
      renderPrompt: false,
    });

    expect(promotePendingMock).toHaveBeenCalledTimes(1);
    expect(claimMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
    expect(saveTranscriptMock).not.toHaveBeenCalled();
    expect(sessionStoreMock.createLogWriter).not.toHaveBeenCalled();
    expect(deleteSecretMock).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      status: "error",
      browser: {
        remoteRun: { runId: "origin-old", terminalDoneOk: false },
      },
    });
    expect(state.current?.browser?.remoteRecovery).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("original prompt will not be replayed"),
    );
  });

  test("a validated pre-submit refusal blocks pending promotion and preserves failed-route accounting", async () => {
    const pending = state.current;
    if (!pending?.browser) throw new Error("missing fixture browser metadata");
    const { response: _response, ...pendingWithoutResponse } = pending;
    const {
      remoteRecovery: _remoteRecovery,
      runtime: _runtime,
      ...pendingBrowser
    } = pending.browser;
    state.current = {
      ...pendingWithoutResponse,
      browser: pendingBrowser,
      error: {
        category: "browser-automation",
        message: "Protected browser pre-submit integrity proof failed; no prompt was submitted.",
        details: {
          stage: "remote-run",
          errorClass: "integrity_ui_unknown",
          retryable: false,
          preSubmitDiagnostic: preSubmitDiagnostic(),
        },
      },
    };

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(promotePendingMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      status: "error",
      browser: {
        remoteRun: {
          runId: "origin-old",
          accountId: "acct1",
          laneId: "acct1-9473",
          terminalDoneOk: false,
        },
      },
    });
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("no prompt was submitted"));
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("account history"));
  });

  test("a malformed stored pre-submit diagnostic blocks pending promotion fail-closed", async () => {
    const pending = state.current;
    if (!pending?.browser) throw new Error("missing fixture browser metadata");
    const {
      remoteRecovery: _remoteRecovery,
      runtime: _runtime,
      ...pendingBrowser
    } = pending.browser;
    state.current = {
      ...pending,
      browser: pendingBrowser,
      error: {
        category: "browser-automation",
        message: "pre-submit failure",
        details: {
          stage: "remote-run",
          errorClass: "integrity_ui_unknown",
          retryable: false,
          preSubmitDiagnostic: {
            ...preSubmitDiagnostic(),
            unexpectedField: true,
          },
        },
      },
    };

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(promotePendingMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).not.toHaveBeenCalled();
    expect(state.current?.browser?.remoteRun).toMatchObject({
      runId: "origin-old",
      terminalDoneOk: false,
    });
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("malformed pre-submit diagnostic"),
    );
  });

  test("contradictory pre-submit and submission evidence blocks existing recovery", async () => {
    const current = state.current;
    if (!current) throw new Error("missing fixture metadata");
    state.current = {
      ...current,
      error: {
        category: "browser-automation",
        message: "contradictory pre-submit failure",
        details: {
          stage: "remote-run",
          errorClass: "integrity_ui_unknown",
          retryable: false,
          runtime: { promptSubmitted: true },
          preSubmitDiagnostic: preSubmitDiagnostic(),
        },
      },
    };

    const { attachSession, classifyStoredRemotePreSubmitState } =
      await import("../../src/cli/sessionDisplay.js");
    expect(classifyStoredRemotePreSubmitState(state.current)).toMatchObject({
      kind: "contradictory",
      conflicts: expect.arrayContaining(["error.details.runtime.promptSubmitted"]),
    });
    await attachSession("remote-session", { suppressMetadata: true });

    expect(promotePendingMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      status: "error",
      browser: {
        remoteRun: { runId: "origin-old", terminalDoneOk: false },
        remoteRecovery: { originRunId: "origin-old" },
      },
    });
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("contradictory pre-submit and submission evidence"),
    );
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("originating account"));
  });

  test("a diagnostic landing after claim prevents the recovery completion commit", async () => {
    recoverMock.mockImplementation(async () => {
      const current = state.current;
      if (!current) throw new Error("missing fixture metadata");
      state.current = {
        ...current,
        error: {
          category: "browser-automation",
          message: "Protected browser pre-submit integrity proof failed; no prompt was submitted.",
          details: {
            stage: "remote-run",
            errorClass: "integrity_ui_unknown",
            retryable: false,
            preSubmitDiagnostic: preSubmitDiagnostic(),
          },
        },
      };
      return {
        answerText: "stale recovered answer",
        answerMarkdown: "stale recovered answer",
        tookMs: 10,
        answerTokens: 3,
        answerChars: 22,
        tabUrl: "https://chatgpt.com/c/origin-old",
        conversationId: "origin-old",
        remoteRun: {
          runId: "recovery-run",
          accountId: "acct1",
          laneId: "acct1-9473",
          terminalDoneOk: true as const,
          provenance: null,
        },
      };
    });

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(claimMock).toHaveBeenCalledOnce();
    expect(recoverMock).toHaveBeenCalledOnce();
    expect(releaseClaimMock).toHaveBeenCalledOnce();
    expect(saveTranscriptMock).not.toHaveBeenCalled();
    expect(saveReportMock).not.toHaveBeenCalled();
    expect(sessionStoreMock.createLogWriter).not.toHaveBeenCalled();
    expect(logLineMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      status: "error",
      browser: {
        remoteRun: { runId: "origin-old", terminalDoneOk: false },
        remoteRecovery: { originRunId: "origin-old" },
      },
      error: { details: { preSubmitDiagnostic: expect.any(Object) } },
    });
    expect(state.current?.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  test("two concurrent callers dispatch exactly one remote recovery", async () => {
    let releaseRecovery: (() => void) | undefined;
    recoverMock.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRecovery = () =>
            resolve({
              answerText: "single recovered answer",
              answerMarkdown: "single recovered answer",
              tookMs: 10,
              answerTokens: 3,
              answerChars: 23,
              tabUrl: "https://chatgpt.com/c/origin-old",
              conversationId: "origin-old",
              remoteRun: {
                runId: "origin-old",
                accountId: "acct1",
                laneId: "acct1-9473",
                terminalDoneOk: true,
                provenance: null,
              },
            });
        }),
    );

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    const first = attachSession("remote-session", { suppressMetadata: true });
    await vi.waitFor(() => expect(recoverMock).toHaveBeenCalledTimes(1));
    const second = attachSession("remote-session", { suppressMetadata: true });
    await vi.waitFor(() => expect(claimMock).toHaveBeenCalledTimes(2));
    expect(recoverMock).toHaveBeenCalledTimes(1);

    releaseRecovery?.();
    await Promise.all([first, second]);
    expect(recoverMock).toHaveBeenCalledTimes(1);
  });

  test("successful completion compare-deletes only the attempted origin capability", async () => {
    recoverMock.mockResolvedValue({
      answerText: "recovered answer",
      answerMarkdown: "recovered answer",
      tookMs: 10,
      answerTokens: 2,
      answerChars: 16,
      tabUrl: "https://chatgpt.com/c/origin-old",
      conversationId: "origin-old",
      remoteRun: {
        runId: "origin-old",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: true,
        provenance: null,
      },
    });

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(state.current).toMatchObject({
      status: "completed",
      browser: {
        remoteRun: { runId: "origin-old", terminalDoneOk: true },
      },
    });
    expect(state.current?.browser?.remoteRecovery).toBeUndefined();
    expect(updateModelRunMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).toHaveBeenCalledWith("remote-session", "origin-old");
  });

  test("local reattach commits completion through the top-level session write only", async () => {
    const current = state.current;
    if (!current?.browser) throw new Error("missing fixture browser metadata");
    const {
      remoteRun: _remoteRun,
      remoteRecovery: _remoteRecovery,
      remoteRecoveryCompletionClaim: _remoteRecoveryCompletionClaim,
      ...localBrowser
    } = current.browser;
    state.current = {
      ...current,
      status: "error",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      models: [
        {
          model: current.model!,
          status: "error",
          completedAt: "2026-07-22T00:00:30.000Z",
          usage: {
            inputTokens: 99,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 99,
          },
          response: { status: "incomplete", incompleteReason: "incomplete-capture" },
          error: { category: "browser-automation", message: "older capture failed" },
        },
      ],
      browser: {
        ...localBrowser,
        runtime: {
          ...localBrowser.runtime,
          tabUrl: "https://chatgpt.com/c/local-reattach",
          conversationId: "local-reattach",
          promptSubmitted: true,
        },
      },
    };
    resumeBrowserSessionMock.mockResolvedValue({
      answerText: "locally recovered answer",
      answerMarkdown: "locally recovered answer",
    });
    sessionStoreMock.readLog.mockImplementation(async () =>
      state.current?.status === "completed"
        ? "Answer:\nlocally recovered answer\n"
        : "Answer:\nprior failed capture\n",
    );

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(resumeBrowserSessionMock).toHaveBeenCalledOnce();
    expect(updateModelRunMock).not.toHaveBeenCalled();
    expect(updateSessionMock).toHaveBeenCalledWith("remote-session", expect.any(Function));
    expect(state.current).toMatchObject({
      status: "completed",
      response: { status: "completed" },
      models: [
        {
          model: "gpt-5.6-pro",
          status: "completed",
          response: { status: "completed" },
          usage: {
            inputTokens: 0,
            outputTokens: expect.any(Number),
            reasoningTokens: 0,
            totalTokens: expect.any(Number),
          },
        },
      ],
    });
    expect(state.current?.models?.[0]?.error).toBeUndefined();
  });

  test("local reattach refuses completion when its fresh transcript cannot be persisted", async () => {
    state.current = failedLocalSession();
    resumeBrowserSessionMock.mockResolvedValue({
      answerText: "new answer that must be durable",
      answerMarkdown: "new answer that must be durable",
    });
    saveTranscriptMock.mockRejectedValueOnce(new Error("transcript filesystem failure"));

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(resumeBrowserSessionMock).toHaveBeenCalledOnce();
    expect(saveTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ answerMarkdown: "new answer that must be durable" }),
    );
    expect(logLineMock).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      status: "error",
      response: { status: "incomplete" },
    });
    expect(state.current?.browser?.localReattachCompletionClaim).toBeUndefined();
    expect(state.current?.artifacts).toBeUndefined();
  });

  test("local post-commit log failure preserves the freshly indexed transcript", async () => {
    state.current = failedLocalSession();
    resumeBrowserSessionMock.mockResolvedValue({
      answerText: "durable local recovery",
      answerMarkdown: "durable local recovery",
    });
    logLineMock.mockImplementationOnce(() => {
      throw new Error("log filesystem failure");
    });

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session");

    expect(saveTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ answerMarkdown: "durable local recovery" }),
    );
    expect(state.current).toMatchObject({
      status: "completed",
      response: { status: "completed" },
      artifacts: [
        {
          kind: "transcript",
          path: "/tmp/sessions/remote-session/artifacts/transcript.md",
        },
      ],
    });
    expect(state.current?.browser?.localReattachCompletionClaim).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Reattach completion was committed, but writing its display log failed",
      ),
    );
    expect(console.log).toHaveBeenCalledWith("Status: completed");
  });

  test("concurrent Deep Research reattach callers dispatch exactly one capture", async () => {
    const current = state.current;
    if (!current?.browser) throw new Error("missing fixture browser metadata");
    const {
      remoteRun: _remoteRun,
      remoteRecovery: _remoteRecovery,
      remoteRecoveryCompletionClaim: _remoteRecoveryCompletionClaim,
      ...localBrowser
    } = current.browser;
    state.current = {
      ...current,
      status: "completed",
      completedAt: "2026-07-22T00:00:30.000Z",
      usage: {
        inputTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 2,
      },
      response: { status: "completed" },
      models: [
        {
          model: current.model!,
          status: "completed",
          completedAt: "2026-07-22T00:00:30.000Z",
          usage: {
            inputTokens: 0,
            outputTokens: 2,
            reasoningTokens: 0,
            totalTokens: 2,
          },
          response: { status: "completed" },
        },
      ],
      browser: {
        ...localBrowser,
        config: { ...localBrowser.config, researchMode: "deep" },
        runtime: {
          ...localBrowser.runtime,
          tabUrl: "https://chatgpt.com/c/deep-research",
          conversationId: "deep-research",
          promptSubmitted: true,
        },
      },
    };
    sessionStoreMock.readLog.mockResolvedValue("Answer:\nCalled tool\n");

    let resolveWinner: ((value: unknown) => void) | undefined;
    resumeBrowserSessionMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveWinner = resolve;
        }),
    );

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    const winner = attachSession("remote-session", { suppressMetadata: true });
    const loser = attachSession("remote-session", { suppressMetadata: true });
    await vi.waitFor(() => expect(resumeBrowserSessionMock).toHaveBeenCalledOnce());
    await loser;

    resolveWinner?.({
      answerText: "full recovered research",
      answerMarkdown: "full recovered research",
    });
    await winner;

    expect(resumeBrowserSessionMock).toHaveBeenCalledOnce();
    expect(updateModelRunMock).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      status: "completed",
      response: { status: "completed" },
      models: [
        {
          model: "gpt-5.6-pro",
          status: "completed",
          response: { status: "completed" },
        },
      ],
    });
    expect(state.current?.models?.[0]?.error).toBeUndefined();
    expect(state.current?.error).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Another local reattach owner"),
    );
  });

  test("a post-commit remote log failure preserves completion and does not redispatch", async () => {
    recoverMock.mockResolvedValue({
      answerText: "recovered answer",
      answerMarkdown: "recovered answer",
      tookMs: 10,
      answerTokens: 2,
      answerChars: 16,
      tabUrl: "https://chatgpt.com/c/origin-old",
      conversationId: "origin-old",
      remoteRun: {
        runId: "origin-old",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: true,
        provenance: null,
      },
    });
    logLineMock.mockImplementationOnce(() => {
      throw new Error("disk full while appending answer");
    });

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session");

    expect(releaseClaimMock).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      status: "completed",
      browser: {
        remoteRun: { runId: "origin-old", terminalDoneOk: true },
      },
    });
    expect(state.current?.browser?.remoteRecovery).toBeUndefined();
    expect(state.current?.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
    expect(updateModelRunMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Remote recovery was committed, but a post-commit display step failed",
      ),
    );
    expect(console.log).toHaveBeenCalledWith("Status: completed");

    await attachSession("remote-session", { suppressMetadata: true });

    expect(recoverMock).toHaveBeenCalledOnce();
    expect(releaseClaimMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).toHaveBeenCalledOnce();
    expect(deleteSecretMock).toHaveBeenCalledWith("remote-session", "origin-old");
    expect(state.current).toMatchObject({
      status: "completed",
      browser: {
        remoteRun: { runId: "origin-old", terminalDoneOk: true },
      },
    });
    expect(state.current?.browser?.remoteRecovery).toBeUndefined();
    expect(state.current?.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });

  test("a rejected account-affine recovery exits nonzero and remains retryable", async () => {
    recoverMock.mockRejectedValue(
      new Error("The reopened canonical conversation must contain this session's saved user turn"),
    );

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true, renderMarkdown: true });

    expect(process.exitCode).toBe(1);
    expect(releaseClaimMock).toHaveBeenCalledTimes(1);
    expect(state.current).toMatchObject({
      status: "error",
      browser: { remoteRecovery: { originRunId: "origin-old" } },
    });
    expect(state.current?.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
    expect(deleteSecretMock).not.toHaveBeenCalled();
  });

  test("a post-commit display failure preserves the successful exit status", async () => {
    recoverMock.mockResolvedValue({
      answerText: "recovered answer",
      answerMarkdown: "recovered answer",
      tookMs: 10,
      answerTokens: 2,
      answerChars: 16,
      tabUrl: "https://chatgpt.com/c/origin-old",
      conversationId: "origin-old",
      remoteRun: {
        runId: "origin-old",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: true,
        provenance: null,
      },
    });
    sessionStoreMock.readSession
      .mockImplementationOnce(async () => state.current)
      .mockRejectedValueOnce(new Error("post-commit metadata refresh failed"));

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(state.current).toMatchObject({
      status: "completed",
      browser: { remoteRun: { runId: "origin-old", terminalDoneOk: true } },
    });
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Remote recovery was committed, but a post-commit display step failed",
      ),
    );
  });

  test("an asynchronous post-commit log error preserves recovered completion", async () => {
    recoverMock.mockResolvedValue({
      answerText: "recovered answer",
      answerMarkdown: "recovered answer",
      tookMs: 10,
      answerTokens: 2,
      answerChars: 16,
      tabUrl: "https://chatgpt.com/c/origin-old",
      conversationId: "origin-old",
      remoteRun: {
        runId: "origin-old",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: true,
        provenance: null,
      },
    });
    const stream = new Writable({
      final(callback) {
        queueMicrotask(() => callback(new Error("async ENOSPC")));
      },
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    sessionStoreMock.createLogWriter.mockReturnValue({
      logLine: vi.fn(),
      stream,
    });

    const { attachSession } = await import("../../src/cli/sessionDisplay.js");
    await attachSession("remote-session", { suppressMetadata: true });

    expect(releaseClaimMock).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({
      status: "completed",
      browser: { remoteRun: { runId: "origin-old", terminalDoneOk: true } },
    });
    expect(state.current?.browser?.remoteRecovery).toBeUndefined();
    expect(state.current?.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
    expect(deleteSecretMock).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });
});
