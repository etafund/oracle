import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Writable } from "node:stream";
import type { SessionMetadata } from "../../src/sessionManager.js";

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

vi.mock("../../src/remote/sessionRecovery.js", () => ({
  claimRemoteBrowserRecoveryCompletion: claimMock,
  isFailedRemoteBrowserOrigin: (metadata: SessionMetadata) =>
    Boolean(metadata.browser?.remoteRecovery) ||
    metadata.browser?.remoteRun?.terminalDoneOk === false,
  recoverStoredRemoteBrowserSession: recoverMock,
  promotePendingRemoteBrowserRecoveryClaim: promotePendingMock,
  ownsRemoteBrowserRecoveryCompletion: (
    metadata: SessionMetadata,
    claim: { claimId: string; originRunId: string },
  ) =>
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
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((current: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        if (!state.current) throw new Error("missing in-memory session");
        const patch = typeof updates === "function" ? updates(state.current) : updates;
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    updateModelRunMock.mockResolvedValue({});
    deleteSecretMock.mockResolvedValue(true);
    saveTranscriptMock.mockResolvedValue({
      kind: "transcript",
      path: "/tmp/sessions/remote-session/artifacts/transcript.md",
    });
    promotePendingMock.mockResolvedValue(null);
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

  test("a winning local log failure releases its claim and a second capture can complete", async () => {
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
    await attachSession("remote-session", { suppressMetadata: true });

    expect(releaseClaimMock).toHaveBeenCalledTimes(1);
    expect(state.current).toMatchObject({
      status: "error",
      browser: {
        remoteRun: { runId: "origin-old", terminalDoneOk: false },
        remoteRecovery: { originRunId: "origin-old" },
      },
    });
    expect(state.current?.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
    expect(updateModelRunMock).not.toHaveBeenCalled();
    expect(deleteSecretMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await attachSession("remote-session", { suppressMetadata: true });

    expect(recoverMock).toHaveBeenCalledTimes(2);
    expect(releaseClaimMock).toHaveBeenCalledTimes(1);
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

  test("an asynchronous log stream error is awaited before completion CAS", async () => {
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

    expect(releaseClaimMock).toHaveBeenCalledTimes(1);
    expect(state.current).toMatchObject({
      status: "error",
      browser: { remoteRecovery: { originRunId: "origin-old" } },
    });
    expect(state.current?.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
    expect(deleteSecretMock).not.toHaveBeenCalled();
  });
});
