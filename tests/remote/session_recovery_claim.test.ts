import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.js";

const state = vi.hoisted(() => ({ current: null as SessionMetadata | null }));
const updateSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/sessionStore.js", () => ({
  sessionStore: { updateSession: updateSessionMock },
}));

import {
  claimRemoteBrowserRecoveryCompletion,
  isRemoteBrowserRecoveryCompletionPersisted,
  ownsRemoteBrowserRecoveryCompletion,
  releaseRemoteBrowserRecoveryCompletion,
} from "../../src/remote/sessionRecovery.js";
import { buildRemoteBrowserPreSubmitDiagnostic } from "../../src/remote/types.js";

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

function addStoredPreSubmitDiagnostic(metadata: SessionMetadata): void {
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
  metadata.error = {
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

  test.each([
    ["successful", true],
    ["missing", undefined],
    ["invalid", null],
  ] as const)("ownership is lost when the origin terminal marker is %s", async (_label, marker) => {
    const claim = await claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1");
    expect(claim).not.toBeNull();
    if (!state.current?.browser?.remoteRun) throw new Error("missing fixture route");
    Reflect.set(state.current.browser.remoteRun, "terminalDoneOk", marker);

    expect(ownsRemoteBrowserRecoveryCompletion(state.current, claim!)).toBe(false);
  });

  test("ownership requires the exact unique claim id", async () => {
    const claim = await claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1");
    expect(claim).not.toBeNull();

    expect(
      ownsRemoteBrowserRecoveryCompletion(state.current!, {
        ...claim!,
        claimId: "different-writer",
      }),
    ).toBe(false);
  });

  test("claim CAS rejects a diagnostic that lands on an existing bound recovery coordinate", async () => {
    if (!state.current) throw new Error("missing fixture session");
    addStoredPreSubmitDiagnostic(state.current);

    await expect(
      claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1"),
    ).resolves.toBeNull();
    expect(state.current.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
  });

  test("a diagnostic that lands after claim revokes final completion ownership", async () => {
    const claim = await claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1");
    expect(claim).not.toBeNull();
    if (!state.current) throw new Error("missing fixture session");
    addStoredPreSubmitDiagnostic(state.current);

    expect(ownsRemoteBrowserRecoveryCompletion(state.current, claim!)).toBe(false);
  });

  test("a contradictory diagnostic cannot satisfy partial recovery-commit detection", () => {
    if (!state.current?.browser) throw new Error("missing fixture browser metadata");
    addStoredPreSubmitDiagnostic(state.current);
    state.current = {
      ...state.current,
      status: "completed",
      browser: {
        ...state.current.browser,
        remoteRecovery: undefined,
        remoteRecoveryCompletionClaim: undefined,
        remoteRun: {
          runId: "recovered-run",
          accountId: "acct1",
          laneId: "acct1-9473",
          terminalDoneOk: true,
          provenance: null,
        },
      },
      artifacts: [{ kind: "transcript", path: "/tmp/recovered.md" }],
    };

    expect(
      isRemoteBrowserRecoveryCompletionPersisted(
        state.current,
        state.current.browser?.remoteRun,
        state.current.artifacts,
      ),
    ).toBe(false);
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

  test("rejects a foreign live run attempt but allows its exact owning runner", async () => {
    if (!state.current?.browser) throw new Error("missing fixture browser");
    state.current.browser.runAttemptClaim = {
      schema: "browser-run-attempt-claim.v1",
      claimId: "ordinary-run-owner",
      claimedAt: "2026-07-24T00:00:00.000Z",
      ownerPid: process.pid,
    };

    await expect(
      claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1"),
    ).resolves.toBeNull();
    const claim = await claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1", {
      ownedRunAttemptClaimId: "ordinary-run-owner",
    });

    expect(claim).not.toBeNull();
    expect(state.current.browser.runAttemptClaim?.claimId).toBe("ordinary-run-owner");
    expect(state.current.browser.remoteRecoveryCompletionClaim?.claimId).toBe(claim?.claimId);
  });

  test("reclaims a dead run-attempt owner while installing the remote claim", async () => {
    if (!state.current?.browser) throw new Error("missing fixture browser");
    state.current.browser.runAttemptClaim = {
      schema: "browser-run-attempt-claim.v1",
      claimId: "dead-run-owner",
      claimedAt: "2026-07-24T00:00:00.000Z",
      ownerPid: 999_999,
    };

    await expect(
      claimRemoteBrowserRecoveryCompletion("recovery-session", "origin-1"),
    ).resolves.not.toBeNull();
    expect(state.current.browser.runAttemptClaim).toBeUndefined();
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
