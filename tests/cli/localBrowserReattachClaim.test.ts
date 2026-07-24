import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.js";

const state = vi.hoisted(() => ({ current: null as SessionMetadata | null }));
const updateSessionMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn(async (metadata: SessionMetadata) => metadata));

vi.mock("../../src/sessionStore.js", () => ({
  sessionStore: {
    updateSession: updateSessionMock,
  },
}));

vi.mock("../../src/sessionManager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sessionManager.js")>()),
  reconcileSessionMetadataForCompletionClaim: reconcileMock,
}));

function metadata(): SessionMetadata {
  return {
    id: "local-reattach",
    createdAt: "2026-07-24T00:00:00.000Z",
    status: "error",
    mode: "browser",
    model: "gpt-5.6-sol",
    models: [{ model: "gpt-5.6-sol", status: "error" }],
    options: { prompt: "sensitive prompt is hashed, never stored in the claim" },
    response: { status: "incomplete", incompleteReason: "incomplete-capture" },
    browser: {
      config: { timeoutMs: 60_000 },
      runtime: {
        tabUrl: "https://chatgpt.com/c/local",
        conversationId: "local",
        promptSubmitted: true,
      },
    },
  };
}

describe("local browser reattach completion claim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    state.current = null;
    reconcileMock.mockImplementation(async (metadata: SessionMetadata) => metadata);
  });

  test("allows exactly one owner for an unchanged generation", async () => {
    state.current = metadata();
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updater: (
          current: SessionMetadata,
        ) => Partial<SessionMetadata> | Promise<Partial<SessionMetadata>>,
      ) => {
        if (!state.current) throw new Error("missing fixture state");
        const patch = await updater(state.current);
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    const { claimLocalBrowserReattachCompletion, ownsLocalBrowserReattachCompletion } =
      await import("../../src/cli/localBrowserReattachClaim.js");

    const first = await claimLocalBrowserReattachCompletion(state.current);
    const second = await claimLocalBrowserReattachCompletion(metadata());

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(ownsLocalBrowserReattachCompletion(state.current!, first!)).toBe(true);
    expect(first).not.toHaveProperty("prompt");
  });

  test("ownership is lost when authoritative session state changes", async () => {
    state.current = metadata();
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updater: (
          current: SessionMetadata,
        ) => Partial<SessionMetadata> | Promise<Partial<SessionMetadata>>,
      ) => {
        if (!state.current) throw new Error("missing fixture state");
        const patch = await updater(state.current);
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    const { claimLocalBrowserReattachCompletion, ownsLocalBrowserReattachCompletion } =
      await import("../../src/cli/localBrowserReattachClaim.js");
    const claim = await claimLocalBrowserReattachCompletion(state.current);
    if (!claim) throw new Error("claim not acquired");

    state.current = {
      ...state.current,
      status: "completed",
      response: { status: "completed" },
    };

    expect(ownsLocalBrowserReattachCompletion(state.current, claim)).toBe(false);
  });

  test("observation-only harvest updates do not invalidate the capture owner", async () => {
    state.current = metadata();
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updater: (
          current: SessionMetadata,
        ) => Partial<SessionMetadata> | Promise<Partial<SessionMetadata>>,
      ) => {
        if (!state.current) throw new Error("missing fixture state");
        const patch = await updater(state.current);
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    const { claimLocalBrowserReattachCompletion, ownsLocalBrowserReattachCompletion } =
      await import("../../src/cli/localBrowserReattachClaim.js");
    const claim = await claimLocalBrowserReattachCompletion(state.current);
    if (!claim) throw new Error("claim not acquired");

    state.current = {
      ...state.current,
      browser: {
        ...state.current.browser!,
        harvest: {
          harvestedAt: "2026-07-24T00:01:00.000Z",
          assistantHash: "observation-only",
          assistantCount: 1,
        },
      },
    };

    expect(ownsLocalBrowserReattachCompletion(state.current, claim)).toBe(true);
  });

  test("release removes only the caller's exact claim", async () => {
    state.current = metadata();
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updater: (
          current: SessionMetadata,
        ) => Partial<SessionMetadata> | Promise<Partial<SessionMetadata>>,
      ) => {
        if (!state.current) throw new Error("missing fixture state");
        const patch = await updater(state.current);
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    const { claimLocalBrowserReattachCompletion, releaseLocalBrowserReattachCompletion } =
      await import("../../src/cli/localBrowserReattachClaim.js");
    const claim = await claimLocalBrowserReattachCompletion(state.current);
    if (!claim) throw new Error("claim not acquired");

    await expect(
      releaseLocalBrowserReattachCompletion("local-reattach", {
        ...claim,
        claimId: "different-owner",
      }),
    ).resolves.toBe(false);
    expect(state.current?.browser?.localReattachCompletionClaim?.claimId).toBe(claim.claimId);
    await expect(releaseLocalBrowserReattachCompletion("local-reattach", claim)).resolves.toBe(
      true,
    );
    expect(state.current?.browser?.localReattachCompletionClaim).toBeUndefined();
  });

  test("rejects a foreign live run attempt but allows its exact owning runner", async () => {
    state.current = {
      ...metadata(),
      browser: {
        ...metadata().browser,
        runAttemptClaim: {
          schema: "browser-run-attempt-claim.v1",
          claimId: "ordinary-run-owner",
          claimedAt: "2026-07-24T00:00:00.000Z",
          ownerPid: process.pid,
        },
      },
    };
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updater: (current: SessionMetadata) => Promise<Partial<SessionMetadata>>,
      ) => {
        if (!state.current) throw new Error("missing fixture state");
        const patch = await updater(state.current);
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    const { claimLocalBrowserReattachCompletion } =
      await import("../../src/cli/localBrowserReattachClaim.js");

    await expect(claimLocalBrowserReattachCompletion(state.current)).resolves.toBeNull();
    const owned = await claimLocalBrowserReattachCompletion(state.current, {
      ownedRunAttemptClaimId: "ordinary-run-owner",
    });

    expect(owned).not.toBeNull();
    expect(state.current.browser?.runAttemptClaim?.claimId).toBe("ordinary-run-owner");
    expect(state.current.browser?.localReattachCompletionClaim?.claimId).toBe(owned?.claimId);
  });

  test("reclaims a dead run-attempt owner while installing the local claim", async () => {
    state.current = {
      ...metadata(),
      browser: {
        ...metadata().browser,
        runAttemptClaim: {
          schema: "browser-run-attempt-claim.v1",
          claimId: "dead-run-owner",
          claimedAt: "2026-07-24T00:00:00.000Z",
          ownerPid: 999_999,
        },
      },
    };
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updater: (current: SessionMetadata) => Promise<Partial<SessionMetadata>>,
      ) => {
        if (!state.current) throw new Error("missing fixture state");
        const patch = await updater(state.current);
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    const { claimLocalBrowserReattachCompletion } =
      await import("../../src/cli/localBrowserReattachClaim.js");

    const claim = await claimLocalBrowserReattachCompletion(state.current);

    expect(claim).not.toBeNull();
    expect(state.current.browser?.runAttemptClaim).toBeUndefined();
  });

  test("binds a reconciled caller snapshot to the authoritative raw generation", async () => {
    const raw = metadata();
    const reconciledCaller = {
      ...raw,
      status: "error" as const,
      completedAt: "2026-07-24T00:01:00.000Z",
      response: {
        status: "incomplete" as const,
        incompleteReason: "incomplete-capture" as const,
      },
      models: [
        {
          model: "gpt-5.6-sol",
          status: "error" as const,
          completedAt: "2026-07-24T00:01:00.000Z",
          response: {
            status: "incomplete" as const,
            incompleteReason: "incomplete-capture" as const,
          },
        },
      ],
    };
    const reconciledFresh = {
      ...reconciledCaller,
      completedAt: "2026-07-24T00:01:01.000Z",
      models: reconciledCaller.models.map((run) => ({
        ...run,
        completedAt: "2026-07-24T00:01:01.000Z",
      })),
    };
    state.current = raw;
    reconcileMock.mockResolvedValue(reconciledFresh);
    updateSessionMock.mockImplementation(
      async (
        _sessionId: string,
        updater: (current: SessionMetadata) => Promise<Partial<SessionMetadata>>,
      ) => {
        if (!state.current) throw new Error("missing fixture state");
        const patch = await updater(state.current);
        state.current = { ...state.current, ...patch };
        return state.current;
      },
    );
    const {
      claimLocalBrowserReattachCompletion,
      computeLocalBrowserReattachGenerationSha256,
      ownsLocalBrowserReattachCompletion,
    } = await import("../../src/cli/localBrowserReattachClaim.js");

    const claim = await claimLocalBrowserReattachCompletion(reconciledCaller);

    expect(claim).not.toBeNull();
    expect(claim?.originGenerationSha256).toBe(computeLocalBrowserReattachGenerationSha256(raw));
    expect(ownsLocalBrowserReattachCompletion(state.current!, claim!)).toBe(true);
  });
});
