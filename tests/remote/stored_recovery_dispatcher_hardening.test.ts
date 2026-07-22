import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { BrowserRunResult } from "../../src/browserMode.js";
import { loadUserConfig } from "../../src/config.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  recoverRemoteBrowserSession,
  type RemoteBrowserRecoveryCarrier,
} from "../../src/remote/client.js";
import { buildRemoteRunRecoveryHint } from "../../src/remote/recovery.js";
import { sanitizeRemoteBrowserRecoveryRequestForWire } from "../../src/remote/payload_sanitize.js";
import {
  isFailedRemoteBrowserOrigin,
  recoverStoredRemoteBrowserSession,
  RemoteBrowserRecoveryUnavailableError,
} from "../../src/remote/sessionRecovery.js";
import {
  readRemoteBrowserRecoverySecret,
  toPublicRemoteRecoveryMetadata,
  writeRemoteBrowserRecoverySecret,
} from "../../src/remote/sessionRecoveryStore.js";
import type { SessionMetadata } from "../../src/sessionManager.js";
import { sessionStore } from "../../src/sessionStore.js";

const PROMPT_PREVIEW = "exact worker-submitted prompt prefix";
const RESULT: BrowserRunResult = {
  answerText: "recovered answer",
  answerMarkdown: "recovered answer",
  tookMs: 12,
  answerTokens: 2,
  answerChars: 16,
};

let oracleHome: string;

beforeEach(async () => {
  oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-dispatch-test-"));
  setOracleHomeDirOverrideForTest(oracleHome);
  vi.stubEnv("ORACLE_REMOTE_HOST", "");
  vi.stubEnv("ORACLE_REMOTE_TOKEN", "");
  vi.stubEnv("ORACLE_REMOTE_BROWSER", "");
  await sessionStore.ensureStorage();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setOracleHomeDirOverrideForTest(null);
  await rm(oracleHome, { recursive: true, force: true });
});

async function createStoredFixture(
  options: {
    expired?: boolean;
    writeSecret?: boolean;
  } = {},
): Promise<{ metadata: SessionMetadata; carrier: RemoteBrowserRecoveryCarrier }> {
  const created = await sessionStore.createSession(
    {
      prompt: "original caller prompt",
      model: "gpt-5.6-sol",
      mode: "browser",
      browserConfig: {
        thinkingTime: "extended",
        timeoutMs: 100_000,
        researchMode: "off",
        inlineCookies: [
          {
            name: "__Secure-next-auth.session-token",
            value: "saved-client-cookie",
            domain: "chatgpt.com",
            path: "/",
            secure: true,
            httpOnly: true,
          },
        ],
        inlineCookiesSource: "/home/client/.oracle/private-cookies.json",
        manualLoginProfileDir: "/home/client/.oracle/browser-profile",
        browserTabRef: "saved-client-target",
        remoteChrome: { host: "127.0.0.1", port: 9223 },
      },
      heartbeatIntervalMs: 1_234,
      verbose: true,
    },
    "/tmp/current-project",
  );
  const nowMs = Date.now();
  const recovery = buildRemoteRunRecoveryHint(
    {
      stage: "assistant-recheck",
      runtime: {
        tabUrl: "https://chatgpt.com/c/dispatcher-conversation",
        conversationId: "dispatcher-conversation",
        promptSubmitted: true,
      },
    },
    undefined,
    {
      originRunId: "origin-dispatch-run",
      accountId: "acct1",
      authToken: "account-secret",
      promptPreview: PROMPT_PREVIEW,
      nowMs: options.expired ? nowMs - 120_000 : nowMs,
      ttlMs: options.expired ? 1 : 120_000,
    },
  );
  if (!recovery || recovery.stage !== "assistant-recheck") {
    throw new Error("fixture did not mint an executable recovery capability");
  }
  const executableRecovery: RemoteBrowserRecoveryCarrier["recovery"] = {
    ...recovery,
    stage: "assistant-recheck",
  };
  const carrier: RemoteBrowserRecoveryCarrier = {
    recovery: executableRecovery,
    accountId: "acct1",
    laneId: "acct1-9473",
    promptPreview: PROMPT_PREVIEW,
  };
  const metadata = await sessionStore.updateSession(created.id, {
    browser: {
      config: created.browser?.config,
      remoteRun: {
        runId: recovery.originRunId,
        accountId: carrier.accountId,
        laneId: carrier.laneId,
        terminalDoneOk: false,
        provenance: null,
      },
      remoteRecovery: toPublicRemoteRecoveryMetadata(carrier),
    },
  });
  if (options.writeSecret !== false) {
    await writeRemoteBrowserRecoverySecret(metadata.id, carrier);
  }
  return { metadata, carrier };
}

function currentConfigLoader(host = "current-router.example:9470", token = "current-token") {
  const loadConfig = vi.fn<typeof loadUserConfig>();
  loadConfig.mockResolvedValue({
    config: {
      browser: {
        remoteHost: host,
        remoteToken: token,
      },
    },
    path: "/current/oracle/config.json",
    paths: ["/current/oracle/config.json"],
    loadedConfigs: [],
    loaded: true,
  });
  return loadConfig;
}

function recoveryMock() {
  const recover = vi.fn<typeof recoverRemoteBrowserSession>();
  recover.mockResolvedValue(RESULT);
  return recover;
}

describe("stored remote recovery dispatcher", () => {
  test("uses the authenticated stored route with the current endpoint credentials", async () => {
    const { metadata, carrier } = await createStoredFixture();
    const loadConfig = currentConfigLoader("new-current-router.example:9470", "new-current-token");
    const recover = recoveryMock();
    const controller = new AbortController();
    const log = vi.fn();

    await expect(
      recoverStoredRemoteBrowserSession(
        metadata,
        {
          log,
          signal: controller.signal,
          browserConfig: { timeoutMs: 200_000 },
        },
        { loadConfig, recover },
      ),
    ).resolves.toEqual(RESULT);

    expect(loadConfig).toHaveBeenCalledWith({ cwd: "/tmp/current-project" });
    expect(recover).toHaveBeenCalledTimes(1);
    const dispatched = recover.mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      host: "new-current-router.example:9470",
      token: "new-current-token",
      accountId: "acct1",
      log,
      signal: controller.signal,
      request: {
        schema: "remote-browser-recovery.v1",
        recovery: carrier.recovery,
        promptPreview: PROMPT_PREVIEW,
        browserConfig: {
          thinkingTime: "extended",
          timeoutMs: 200_000,
        },
        options: {
          heartbeatIntervalMs: 1_234,
          verbose: true,
          sessionId: metadata.id,
        },
      },
    });
    const wireRequest = sanitizeRemoteBrowserRecoveryRequestForWire(dispatched!.request);
    expect(wireRequest.browserConfig).toEqual({
      timeoutMs: 200_000,
      researchMode: "off",
    });
    expect(JSON.stringify(wireRequest)).not.toContain("saved-client-cookie");
    expect(JSON.stringify(wireRequest)).not.toContain("private-cookies.json");
    expect(JSON.stringify(wireRequest)).not.toContain("browser-profile");
    expect(JSON.stringify(wireRequest)).not.toContain("saved-client-target");
    // Wire minimization is pure: normal local session behavior still sees the
    // full saved config after a recovery request is constructed.
    expect(metadata.browser?.config?.inlineCookies?.[0]?.value).toBe("saved-client-cookie");
    expect(metadata.browser?.config?.manualLoginProfileDir).toBe(
      "/home/client/.oracle/browser-profile",
    );
    expect(isFailedRemoteBrowserOrigin(metadata)).toBe(true);

    const publicSession = JSON.stringify(metadata);
    expect(publicSession).not.toContain(carrier.recovery.capability);
    expect(publicSession).not.toContain(PROMPT_PREVIEW);
    expect(publicSession).not.toContain("promptPreviewSha256");
  });

  test.each([
    ["origin run", { runId: "other-run" }],
    ["account", { accountId: "acct2" }],
    ["lane", { laneId: "acct1-9474" }],
    ["terminal state", { terminalDoneOk: true, provenance: null }],
  ])("refuses a %s mismatch before endpoint lookup or dispatch", async (_label, patch) => {
    const { metadata } = await createStoredFixture();
    const loadConfig = currentConfigLoader();
    const recover = recoveryMock();
    const mismatched = structuredClone(metadata);
    if (!mismatched.browser?.remoteRun) throw new Error("missing route fixture");
    mismatched.browser.remoteRun = {
      ...mismatched.browser.remoteRun,
      ...patch,
    } as SessionMetadata["browser"] extends infer _Browser
      ? NonNullable<NonNullable<SessionMetadata["browser"]>["remoteRun"]>
      : never;

    await expect(
      recoverStoredRemoteBrowserSession(mismatched, {}, { loadConfig, recover }),
    ).rejects.toThrow(/does not match.*failed-run route/i);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  test.each([
    [
      "stage",
      (coordinate: NonNullable<NonNullable<SessionMetadata["browser"]>["remoteRecovery"]>) => {
        coordinate.stage = "capture-binding";
      },
    ],
    [
      "expiry",
      (coordinate: NonNullable<NonNullable<SessionMetadata["browser"]>["remoteRecovery"]>) => {
        coordinate.expiresAt = new Date(Date.parse(coordinate.expiresAt) + 1_000).toISOString();
      },
    ],
    [
      "conversation",
      (coordinate: NonNullable<NonNullable<SessionMetadata["browser"]>["remoteRecovery"]>) => {
        coordinate.runtime.conversationId = "different-conversation";
      },
    ],
    [
      "URL",
      (coordinate: NonNullable<NonNullable<SessionMetadata["browser"]>["remoteRecovery"]>) => {
        coordinate.runtime.tabUrl = "https://chatgpt.com/c/different-conversation";
      },
    ],
  ])(
    "refuses a public/private %s mismatch before endpoint lookup or dispatch",
    async (_label, mutate) => {
      const { metadata } = await createStoredFixture();
      const loadConfig = currentConfigLoader();
      const recover = recoveryMock();
      const mismatched = structuredClone(metadata);
      const coordinate = mismatched.browser?.remoteRecovery;
      if (!coordinate) throw new Error("missing public recovery fixture");
      mutate(coordinate);

      await expect(
        recoverStoredRemoteBrowserSession(mismatched, {}, { loadConfig, recover }),
      ).rejects.toThrow(/does not match its private capability/i);
      expect(loadConfig).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      await expect(readRemoteBrowserRecoverySecret(metadata.id)).resolves.toBeNull();
      expect(
        (await sessionStore.readSession(metadata.id))?.browser?.remoteRecovery,
      ).toBeUndefined();
    },
  );

  test("prunes an expired coordinate and private capability before refusing", async () => {
    const { metadata } = await createStoredFixture({ expired: true });
    const loadConfig = currentConfigLoader();
    const recover = recoveryMock();

    await expect(
      recoverStoredRemoteBrowserSession(metadata, {}, { loadConfig, recover }),
    ).rejects.toMatchObject({
      name: "RemoteBrowserRecoveryUnavailableError",
      message: expect.stringMatching(/expired.*originating ChatGPT account/i),
    });
    expect(loadConfig).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    await expect(readRemoteBrowserRecoverySecret(metadata.id)).resolves.toBeNull();
    expect((await sessionStore.readSession(metadata.id))?.browser?.remoteRecovery).toBeUndefined();
  });

  test("does not prune an expired snapshot from under an active same-origin completion claim", async () => {
    const { metadata } = await createStoredFixture({ expired: true });
    const originRunId = metadata.browser?.remoteRecovery?.originRunId;
    if (!originRunId) throw new Error("missing recovery fixture");
    await sessionStore.updateSession(metadata.id, (current) => ({
      browser: {
        ...current.browser,
        remoteRecoveryCompletionClaim: {
          schema: "remote-browser-recovery-completion-claim.v1",
          originRunId,
          claimId: "active-claim",
          claimedAt: new Date().toISOString(),
          ownerPid: process.pid,
        },
      },
    }));

    await expect(
      recoverStoredRemoteBrowserSession(
        metadata,
        {},
        { loadConfig: currentConfigLoader(), recover: recoveryMock() },
      ),
    ).rejects.toBeInstanceOf(RemoteBrowserRecoveryUnavailableError);

    expect(
      (await sessionStore.readSession(metadata.id))?.browser?.remoteRecovery?.originRunId,
    ).toBe(originRunId);
    await expect(readRemoteBrowserRecoverySecret(metadata.id, originRunId)).resolves.not.toBeNull();
  });

  test("fails closed and prunes when the public coordinate has no private capability", async () => {
    const { metadata } = await createStoredFixture({ writeSecret: false });
    const loadConfig = currentConfigLoader();
    const recover = recoveryMock();

    await expect(
      recoverStoredRemoteBrowserSession(metadata, {}, { loadConfig, recover }),
    ).rejects.toBeInstanceOf(RemoteBrowserRecoveryUnavailableError);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect((await sessionStore.readSession(metadata.id))?.browser?.remoteRecovery).toBeUndefined();
    expect((await sessionStore.readSession(metadata.id))?.browser?.remoteRun).toMatchObject({
      terminalDoneOk: false,
      accountId: "acct1",
      laneId: "acct1-9473",
    });
  });

  test("never falls back when a failed remote route has no recovery coordinate", async () => {
    const { metadata } = await createStoredFixture();
    const loadConfig = currentConfigLoader();
    const recover = recoveryMock();
    const withoutCoordinate = structuredClone(metadata);
    if (!withoutCoordinate.browser) throw new Error("missing browser fixture");
    delete withoutCoordinate.browser.remoteRecovery;

    await expect(
      recoverStoredRemoteBrowserSession(withoutCoordinate, {}, { loadConfig, recover }),
    ).rejects.toThrow(/no executable private recovery capability.*originating ChatGPT account/i);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(isFailedRemoteBrowserOrigin(withoutCoordinate)).toBe(true);
  });

  test("requires a currently configured host and token", async () => {
    const { metadata } = await createStoredFixture();
    const loadConfig = currentConfigLoader("", "");
    const recover = recoveryMock();

    await expect(
      recoverStoredRemoteBrowserSession(metadata, {}, { loadConfig, recover }),
    ).rejects.toThrow(/endpoint is not configured/i);
    expect(recover).not.toHaveBeenCalled();
  });
});
