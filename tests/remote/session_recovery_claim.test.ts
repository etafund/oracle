import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.js";

const state = vi.hoisted(() => ({ current: null as SessionMetadata | null }));
const updateSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/sessionStore.js", () => ({
  sessionStore: { updateSession: updateSessionMock },
}));

import {
  claimRemoteBrowserRecoveryCompletion,
  releaseRemoteBrowserRecoveryCompletion,
} from "../../src/remote/sessionRecovery.js";

function recoverySession(originRunId = "origin-1"): SessionMetadata {
  return {
    id: "recovery-session",
    createdAt: "2026-07-22T00:00:00.000Z",
    status: "error",
    mode: "browser",
    options: {},
    browser: {
      remoteRun: {
        runId: originRunId,
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: false,
        provenance: null,
      },
      remoteRecovery: {
        schema: "remote-browser-recovery-public.v1",
        stage: "capture-binding",
        originRunId,
        expiresAt: "2026-07-23T00:00:00.000Z",
        accountId: "acct1",
        laneId: "acct1-9473",
        runtime: {
          tabUrl: `https://chatgpt.com/c/${originRunId}`,
          conversationId: originRunId,
          promptSubmitted: true,
        },
      },
    },
  };
}

describe("remote recovery completion claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.current = recoverySession();
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        if (!state.current) throw new Error("missing fixture session");
        const patch = typeof updates === "function" ? updates(state.current) : updates;
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
  });

  test("is generation/account/lane bound", async () => {
    if (!state.current?.browser?.remoteRun) throw new Error("missing fixture route");
    state.current.browser.remoteRun = {
      ...state.current.browser.remoteRun,
      accountId: "acct2",
    };

    await expect(
      claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1"),
    ).resolves.toBeNull();
    expect(state.current.browser.remoteRecoveryCompletionClaim).toBeUndefined();
  });

  test("excludes a second same-origin writer and becomes retryable after owner release", async () => {
    const first = await claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1");
    expect(first).not.toBeNull();
    await expect(
      claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1"),
    ).resolves.toBeNull();

    await expect(releaseRemoteBrowserRecoveryCompletion("recovery-session", first!)).resolves.toBe(
      true,
    );
    await expect(
      claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1"),
    ).resolves.not.toBeNull();
  });

  test("does not steal an old claim from a demonstrably live process", async () => {
    if (!state.current?.browser) throw new Error("missing fixture browser");
    state.current.browser.remoteRecoveryCompletionClaim = {
      schema: "remote-browser-recovery-completion-claim.v1",
      originRunId: "origin-1",
      claimId: "live-old-claim",
      claimedAt: "2000-01-01T00:00:00.000Z",
      ownerPid: process.pid,
    };

    await expect(
      claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1"),
    ).resolves.toBeNull();
    expect(state.current.browser.remoteRecoveryCompletionClaim.claimId).toBe("live-old-claim");
  });

  test("uses only the final optimistic-updater invocation verdict", async () => {
    const original = recoverySession("origin-1");
    const newer = recoverySession("origin-2");
    state.current = original;
    updateSessionMock.mockImplementationOnce(
      async (
        _sessionId: string,
        updater: (metadata: SessionMetadata) => Partial<SessionMetadata>,
      ) => {
        updater(original);
        state.current = newer;
        const finalPatch = updater(newer);
        state.current = { ...newer, ...finalPatch };
        return state.current;
      },
    );

    await expect(
      claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1"),
    ).resolves.toBeNull();
    expect(state.current.browser?.remoteRecovery?.originRunId).toBe("origin-2");
    expect(state.current.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
  });
});
