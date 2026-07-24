import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.js";
import { classifyStoredRemotePreSubmitState } from "../../src/remote/storedPreSubmitState.js";
import { buildRemoteBrowserPreSubmitDiagnostic } from "../../src/remote/types.js";

const state = vi.hoisted(() => ({ current: null as SessionMetadata | null }));
const updateSessionMock = vi.hoisted(() => vi.fn());
const readPendingMock = vi.hoisted(() => vi.fn());
const resolvePendingMock = vi.hoisted(() => vi.fn());
const writeSecretMock = vi.hoisted(() => vi.fn());
const deleteSecretMock = vi.hoisted(() => vi.fn());
const deletePendingMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/sessionStore.js", () => ({
  sessionStore: {
    readSession: vi.fn(async () => state.current),
    updateSession: updateSessionMock,
  },
}));

vi.mock("../../src/config.js", () => ({
  loadUserConfig: vi.fn(async () => ({ config: {} })),
}));

vi.mock("../../src/remote/remoteServiceConfig.js", () => ({
  resolveRemoteServiceConfig: vi.fn(() => ({
    host: "127.0.0.1:9470",
    token: "test-token",
  })),
}));

vi.mock("../../src/remote/client.js", () => ({
  recoverRemoteBrowserSession: vi.fn(),
  resolveRemoteBrowserPendingRecoveryClaim: resolvePendingMock,
}));

vi.mock("../../src/remote/sessionRecoveryStore.js", () => ({
  deleteRemoteBrowserPendingRecoveryClaim: deletePendingMock,
  deleteRemoteBrowserRecoverySecret: deleteSecretMock,
  InvalidStoredRemoteRecoverySecretError: class InvalidStoredRemoteRecoverySecretError extends Error {
    readonly kind = "invalid";
  },
  readRemoteBrowserPendingRecoveryClaim: readPendingMock,
  readRemoteBrowserRecoverySecret: vi.fn(),
  toPublicRemoteRecoveryMetadata: (carrier: {
    recovery: {
      stage: string;
      originRunId: string;
      expiresAt: string;
      runtime: { tabUrl: string; conversationId: string; promptSubmitted: true };
    };
    accountId: string;
    laneId: string | null;
  }) => ({
    schema: "remote-browser-recovery-public.v1",
    stage: carrier.recovery.stage,
    originRunId: carrier.recovery.originRunId,
    expiresAt: carrier.recovery.expiresAt,
    accountId: carrier.accountId,
    laneId: carrier.laneId,
    runtime: carrier.recovery.runtime,
  }),
  writeRemoteBrowserRecoverySecret: writeSecretMock,
}));

import {
  promotePendingRemoteBrowserRecoveryClaim,
  RemoteBrowserRecoveryUnavailableError,
} from "../../src/remote/sessionRecovery.js";

function failedRemoteSession(): SessionMetadata {
  return {
    id: "promotion-race",
    createdAt: "2026-07-24T00:00:00.000Z",
    status: "error",
    mode: "browser",
    options: {},
    browser: {
      remoteRun: {
        runId: "origin-promotion-race",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: false,
        provenance: null,
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

describe("stored pre-submit recovery CAS gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.current = failedRemoteSession();
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        if (!state.current) throw new Error("missing fixture metadata");
        const patch = typeof updates === "function" ? updates(state.current) : updates;
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    readPendingMock.mockResolvedValue({
      schema: "remote-browser-pending-recovery-claim-secret.v1",
      claimKey: "pending-key",
      originRunId: "origin-promotion-race",
      accountId: "acct1",
      originLaneId: "acct1-9473",
      promptCandidates: [],
    });
    resolvePendingMock.mockResolvedValue({
      accountId: "acct1",
      laneId: "acct1-9473",
      promptPreview: "bounded preview",
      promptDomSha256: "d".repeat(64),
      recovery: {
        category: "browser-automation",
        stage: "capture-binding",
        originRunId: "origin-promotion-race",
        expiresAt: "2099-07-24T00:00:00.000Z",
        capability: `v2.${"a".repeat(43)}`,
        promptPreviewAlgorithm: "oracle.prompt-recovery-preview.v1",
        promptPreviewSha256: "a".repeat(64),
        promptDomIdentityAlgorithm: "oracle.prompt-dom-identity.v1",
        promptDomSha256: "d".repeat(64),
        runtime: {
          tabUrl: "https://chatgpt.com/c/origin-promotion-race",
          conversationId: "origin-promotion-race",
          promptSubmitted: true,
        },
      },
    });
    writeSecretMock.mockResolvedValue(undefined);
    deleteSecretMock.mockResolvedValue(true);
    deletePendingMock.mockResolvedValue(true);
  });

  test("a diagnostic landing after the stale snapshot blocks promotion in the metadata CAS", async () => {
    const stale = failedRemoteSession();
    if (!state.current) throw new Error("missing fixture metadata");
    addStoredPreSubmitDiagnostic(state.current);

    const failure = await promotePendingRemoteBrowserRecoveryClaim(stale).then(
      () => null,
      (error: unknown) => error,
    );
    if (failure && !(failure instanceof RemoteBrowserRecoveryUnavailableError)) {
      throw failure;
    }
    expect(failure).toBeInstanceOf(RemoteBrowserRecoveryUnavailableError);

    expect(resolvePendingMock).toHaveBeenCalledTimes(1);
    expect(writeSecretMock).not.toHaveBeenCalled();
    expect(state.current.browser?.remoteRecovery).toBeUndefined();
    expect(state.current.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
    expect(state.current.browser?.remoteRun).toEqual(stale.browser?.remoteRun);
    expect(classifyStoredRemotePreSubmitState(state.current)).toMatchObject({
      kind: "definitive-pre-submit",
    });
    expect(deleteSecretMock).toHaveBeenCalledWith("promotion-race", "origin-promotion-race");
    expect(deletePendingMock).toHaveBeenCalledWith("promotion-race", "origin-promotion-race");
  });
});
