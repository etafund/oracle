import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, open, readFile, readdir, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, test } from "vitest";

import { computePromptSha256 } from "../../src/browser/actions/captureBinding.js";
import { buildPromptRecoveryOwnershipPreview } from "../../src/browser/promptDomMatch.js";
import type { BrowserAutomationConfig } from "../../src/browser/types.js";
import {
  createRemoteBrowserExecutor,
  getRemoteBrowserFailedRouteFromError,
  getRemoteBrowserPendingRecoveryClaimFromError,
  getRemoteBrowserRecoveryFromError,
  RemoteRunFailedError,
} from "../../src/remote/client.js";
import {
  readRemoteBrowserPendingRecoveryClaim,
  readRemoteBrowserRecoverySecret,
} from "../../src/remote/sessionRecoveryStore.js";
import { persistRemoteBrowserFailureRecoveryState } from "../../src/cli/sessionRunner.js";
import { sessionStore } from "../../src/sessionStore.js";
import {
  assertStructuredTestLogRecords,
  createStructuredTestLog,
} from "../_helpers/structuredTestLog.js";
import {
  assertNoRemoteLaneChallenge,
  readOwnerOnlyTokenFile,
  startRemoteRecoverySeveringProxy,
  type RemoteRecoveryProxySnapshot,
  type RemoteRecoverySeveringProxy,
  type RemoteRecoveryProxyTarget,
} from "../_helpers/remoteRecoverySeveringProxy.js";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";

const LIVE =
  process.env.ORACLE_LIVE_TEST === "1" &&
  process.env.ORACLE_LIVE_BROWSER === "1" &&
  process.env.ORACLE_LIVE_REMOTE_RECOVERY === "1";

// Covers the maximum initial 65m inactivity window, a maximum 70m recovery
// child, bounded lock/readiness waits, and cleanup/final evidence persistence.
const MAX_LIVE_TEST_MS = 160 * 60_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_CLAIM_READY_TIMEOUT_MS = 2 * 60_000;
const MAX_CHILD_OUTPUT_BYTES = 2 * 1024 * 1024;
const READY_POLL_TIMEOUT_MS = 2 * 60_000;
const READY_POLL_INTERVAL_MS = 500;
const LIVE_LOCK_TIMEOUT_MS = 5 * 60_000;
const CHILD_TERMINATE_GRACE_MS = 5_000;
const SESSION_MODEL = "gpt-5.6-sol";

interface LiveRecoveryConfig {
  target: RemoteRecoveryProxyTarget;
  targetHost: string;
  tokenFile: string;
  expectedAccountId: string;
  expectedLaneId: string;
  oracleHome: string;
  recoveryTimeoutMs: number;
  claimReadyTimeoutMs: number;
  chromePidFile: string | null;
}

interface JsonResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface ChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

(LIVE ? describe : describe.skip)("remote browser durable recovery live smoke", () => {
  test(
    "disconnects only after a durable claim, then promotes and capture-recovers without replay",
    async () => {
      const config = loadLiveRecoveryConfig();
      const token = await readOwnerOnlyTokenFile(config.tokenFile);
      const previousEnvironment = {
        oracleHome: process.env.ORACLE_HOME_DIR,
        remoteHost: process.env.ORACLE_REMOTE_HOST,
        remoteToken: process.env.ORACLE_REMOTE_TOKEN,
        legacyRoutes: process.env.ORACLE_TEST_ALLOW_LEGACY_ROUTES,
      };
      process.env.ORACLE_HOME_DIR = config.oracleHome;
      delete process.env.ORACLE_REMOTE_HOST;
      delete process.env.ORACLE_REMOTE_TOKEN;
      delete process.env.ORACLE_TEST_ALLOW_LEGACY_ROUTES;

      const globalLock = "chatgpt-browser";
      const accountLock = `remote-recovery-${config.expectedAccountId}`;
      let globalLockHeld = false;
      let accountLockHeld = false;
      let proxy: RemoteRecoverySeveringProxy | null = null;
      let sessionId: string | null = null;
      let evidencePath: string | null = null;
      let testError: Error | null = null;
      let structuredLog: ReturnType<typeof createStructuredTestLog> | null = null;
      let challengeObserved = false;

      try {
        await acquireLiveTestLock(globalLock, LIVE_LOCK_TIMEOUT_MS);
        globalLockHeld = true;
        await acquireLiveTestLock(accountLock, LIVE_LOCK_TIMEOUT_MS);
        accountLockHeld = true;

        const readyBefore = await readReady(config.target, token);
        assertIdleOwnedDirectLane(readyBefore, config);
        const healthBefore = await readHealth(config.target, token);
        const healthBeforeObservedAtMs = performance.now();
        assertIdleHealth(healthBefore);
        const chromePidBefore = await readOptionalChromePid(config.chromePidFile);

        const nonce = randomUUID().replace(/-/gu, "").slice(0, 12).toUpperCase();
        const sentinel = `ORACLE_RECOVERY_${nonce}`;
        const prompt = `Controlled recovery smoke. Reply with exactly ${sentinel} and no other text.`;
        assertCondition(
          prompt.length <= 160,
          "controlled recovery prompt exceeded preview capacity",
        );
        const browserConfig: BrowserAutomationConfig = {
          desiredModel: "GPT-5.6 Sol",
          modelStrategy: "select",
          thinkingTime: "extended",
          archiveConversations: "never",
          timeoutMs: config.recoveryTimeoutMs,
          inputTimeoutMs: 60_000,
          queueTimeoutMs: 2 * 60_000,
          assistantRecheckDelayMs: 30_000,
          assistantRecheckTimeoutMs: 2 * 60_000,
          autoReattachDelayMs: 0,
          autoReattachIntervalMs: 0,
          autoReattachTimeoutMs: 2 * 60_000,
        };

        await sessionStore.ensureStorage();
        const session = await sessionStore.createSession(
          {
            prompt,
            model: SESSION_MODEL,
            mode: "browser",
            lane: "chatgpt-pro",
            browserConfig,
            browserAttachments: "never",
            browserFollowUps: [],
            verbose: true,
            heartbeatIntervalMs: 15_000,
            waitPreference: true,
          },
          process.cwd(),
          undefined,
          `live-remote-recovery-${nonce.toLowerCase()}`,
        );
        sessionId = session.id;
        const sessionPaths = await sessionStore.getPaths(session.id);
        evidencePath = path.join(sessionPaths.dir, "remote-recovery-live-evidence.jsonl");
        structuredLog = createStructuredTestLog({
          testName: "live.remote-browser.durable-recovery",
          evidencePointer: `oracle session ${session.id} --render`,
        });
        structuredLog.record("preflight", {
          session_id: session.id,
          account_id: config.expectedAccountId,
          lane_id: config.expectedLaneId,
          direct_target_hash: shortHash(config.targetHost),
          provider_route: "gpt-5.6-sol+pro",
          account_drained_acknowledged: true,
          direct_lane_acknowledged: true,
          chrome_owner_verified: true,
          chrome_pid_file_proof: chromePidBefore !== null,
        });
        await sessionStore.updateSession(session.id, {
          status: "running",
          startedAt: new Date().toISOString(),
        });

        const promptPreviewSha256 = computePromptSha256(
          buildPromptRecoveryOwnershipPreview(prompt),
        );
        proxy = await startRemoteRecoverySeveringProxy({
          target: config.target,
          token,
          expectedAccountId: config.expectedAccountId,
          expectedLaneId: config.expectedLaneId,
          expectedSessionId: session.id,
          expectedPromptSha256: computePromptSha256(prompt),
          expectedPromptPreviewSha256: promptPreviewSha256,
          claimReadyTimeoutMs: config.claimReadyTimeoutMs,
        });

        const executor = createRemoteBrowserExecutor({
          host: proxy.host,
          token,
          streamIdleTimeoutMs: config.recoveryTimeoutMs,
          recoveryClaimLookupTimeoutMs: 60_000,
          recoveryClaimPollIntervalMs: 100,
        });
        const browserLogs: string[] = [];
        const disconnectObserved = proxy.waitForDisconnect().then(
          () => null,
          (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        );
        const failure = await executor({
          sessionId: session.id,
          prompt,
          config: browserConfig,
          heartbeatIntervalMs: 15_000,
          verbose: true,
          runProgress: true,
          log: (message) => {
            browserLogs.push(message);
            challengeObserved ||= hasPositiveChallengeLog(message);
          },
        }).then(
          () => null,
          (error: unknown) => error,
        );
        const disconnectError = await disconnectObserved;
        if (disconnectError) throw disconnectError;

        assertCondition(
          failure instanceof RemoteRunFailedError,
          "controlled stream cut did not produce a typed remote failure",
        );
        assertCondition(
          failure.errorClass === "transport_interrupted_after_submit",
          "controlled stream cut was not classified after submit",
        );
        assertNoChallenge(browserLogs, failure);
        assertNoSensitiveText(browserLogs.join("\n"), token, proxy, "initial browser logs");
        assertNoSensitiveText(failure.message, token, proxy, "initial remote failure");

        const failedRoute = getRemoteBrowserFailedRouteFromError(failure);
        const pendingClaim = getRemoteBrowserPendingRecoveryClaimFromError(failure);
        const immediatelyResolvedCarrier = getRemoteBrowserRecoveryFromError(failure);
        assertCondition(Boolean(failedRoute), "controlled failure lost its authenticated route");
        assertCondition(Boolean(pendingClaim), "controlled failure lost its pending claim");
        if (!failedRoute || !pendingClaim) {
          throw new Error("unreachable: failed route and pending claim were asserted");
        }
        assertCondition(
          failedRoute.accountId === config.expectedAccountId &&
            failedRoute.laneId === config.expectedLaneId &&
            failedRoute.terminalDoneOk === false,
          "failed route changed account/lane identity",
        );
        assertCondition(
          pendingClaim.originRunId === failedRoute.runId &&
            pendingClaim.accountId === failedRoute.accountId &&
            pendingClaim.originLaneId === failedRoute.laneId,
          "pending claim did not bind to the failed route",
        );
        if (immediatelyResolvedCarrier) {
          assertCondition(
            immediatelyResolvedCarrier.recovery.originRunId === failedRoute.runId &&
              immediatelyResolvedCarrier.accountId === failedRoute.accountId &&
              immediatelyResolvedCarrier.laneId === failedRoute.laneId,
            "post-disconnect claim lookup returned a cross-route carrier",
          );
        }

        const prePersistSnapshot = proxy.snapshot();
        assertControlledDisconnectSnapshot(prePersistSnapshot, config);
        assertCondition(
          prePersistSnapshot.claimLookupsForwarded >= 1 &&
            prePersistSnapshot.claimLookupStatuses.includes(200),
          "client did not perform an authenticated successful claim lookup after disconnect",
        );
        const protectedProofIndex = browserLogs.findIndex((line) =>
          /Protected route: GPT-5\.6 Sol \+ Pro public-menu proof minted at the dispatch boundary/iu.test(
            line,
          ),
        );
        const submittedIndex = browserLogs.findIndex((line) =>
          /submitted prompt|prompt submitted|clicked send button/iu.test(line),
        );
        assertCondition(
          protectedProofIndex >= 0 &&
            submittedIndex > protectedProofIndex &&
            !browserLogs.some((line) =>
              /\b(?:clicked|clicking|auto-clicked|auto-clicking|will click|about to click|attempt(?:ed|ing)? to click)["'\s:-]*(?:the\s+)?["']?Answer now\b/iu.test(
                line,
              ),
            ),
          "protected model proof/order failed or Answer now was clicked",
        );

        // Intentionally persist only the private pending authority, even when
        // the first client lookup already returned a carrier. This models the
        // crash window that attachSession must now promote before /recover.
        await persistRemoteBrowserFailureRecoveryState({
          sessionId: session.id,
          browser: session.browser,
          failedRoute,
          pendingRecoveryClaim: pendingClaim,
        });
        await sessionStore.updateSession(session.id, (current) => ({
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage:
            "Controlled post-claim caller disconnect; capture-only recovery is required.",
          response: { status: "incomplete", incompleteReason: "chrome-disconnected" },
          error: {
            category: "browser-automation",
            message: "Controlled post-claim caller disconnect; capture-only recovery is required.",
          },
          browser: current.browser,
        }));
        const pendingMetadata = await sessionStore.readSession(session.id);
        assertCondition(
          pendingMetadata?.browser?.remoteRun?.runId === failedRoute.runId &&
            pendingMetadata.browser.remoteRun.terminalDoneOk === false &&
            pendingMetadata.browser.remoteRecovery === undefined,
          "pending-only session state was not persisted fail-closed",
        );
        assertCondition(
          Boolean(await readRemoteBrowserPendingRecoveryClaim(session.id, failedRoute.runId)),
          "pending claim sidecar was not durably stored",
        );
        assertCondition(
          (await readRemoteBrowserRecoverySecret(session.id, failedRoute.runId)) === null,
          "pending-only fixture unexpectedly stored an executable carrier",
        );
        structuredLog.record("pending_claim_persisted", {
          session_id: session.id,
          origin_run_hash: shortHash(failedRoute.runId ?? ""),
          account_id: failedRoute.accountId,
          lane_id: failedRoute.laneId,
          public_recovery_coordinate_present: false,
          private_pending_sidecar_present: true,
          immediately_resolved_carrier_discarded_for_regression_path: Boolean(
            immediatelyResolvedCarrier,
          ),
        });

        // Wait for the worker's client-gone unwind to release its single-flight
        // slot. This is read-only and never restarts/signals Chrome.
        const readyAfterCut = await waitForIdleReady(config.target, token, config);
        assertIdleOwnedDirectLane(readyAfterCut, config);

        const claimLookupsBeforeAttach = proxy.snapshot().claimLookupsForwarded;
        const child = await runSessionRender({
          sessionId: session.id,
          oracleHome: config.oracleHome,
          proxyHost: proxy.host,
          token,
          timeoutMs: config.recoveryTimeoutMs + 5 * 60_000,
        });
        assertNoSensitiveText(child.stdout, token, proxy, "CLI stdout");
        assertNoSensitiveText(child.stderr, token, proxy, "CLI stderr");
        assertNoChallenge([child.stdout, child.stderr], null);
        assertCondition(
          !proxy.snapshot().forbiddenAnswerNowClickObserved,
          "capture-only recovery reported a forbidden Answer now click",
        );
        assertCondition(child.exitCode === 0, "session --render recovery exited nonzero");
        assertCondition(
          child.stdout.includes(sentinel),
          "session --render did not capture the original sentinel answer",
        );

        const finalSnapshot = proxy.snapshot();
        assertFinalProxySnapshot(finalSnapshot, prePersistSnapshot, config);
        assertCondition(
          finalSnapshot.claimLookupsForwarded > claimLookupsBeforeAttach &&
            finalSnapshot.claimLookupStatuses.includes(200),
          "pending-only attach did not perform authenticated claim promotion",
        );

        const completed = await sessionStore.readSession(session.id);
        assertCondition(completed?.status === "completed", "recovered session was not completed");
        assertCondition(
          completed.browser?.remoteRun?.terminalDoneOk === true &&
            completed.browser.remoteRun.provenance?.captureBindingVerified === true &&
            completed.browser.remoteRun.provenance.captureBindingQuality === "message-handle" &&
            completed.browser.remoteRun.provenance.challengeClean === true &&
            completed.browser.remoteRecovery === undefined &&
            completed.browser.remoteRecoveryCompletionClaim === undefined &&
            completed.browser.runtime?.promptSubmitted === true,
          "completed session retained stale recovery authority or lacked terminal proof",
        );
        assertCondition(
          (await readRemoteBrowserPendingRecoveryClaim(session.id, failedRoute.runId)) === null,
          "successful promotion left the pending claim sidecar behind",
        );
        assertCondition(
          (await readRemoteBrowserRecoverySecret(session.id, failedRoute.runId)) === null,
          "successful completion left the executable recovery sidecar behind",
        );

        const transcript = completed.artifacts?.find((artifact) => artifact.kind === "transcript");
        assertCondition(Boolean(transcript?.path), "recovery committed no transcript artifact");
        if (!transcript?.path) throw new Error("unreachable: transcript path was asserted");
        const transcriptPath = path.isAbsolute(transcript.path)
          ? transcript.path
          : path.join(sessionPaths.dir, transcript.path);
        const transcriptInfo = await stat(transcriptPath);
        assertCondition(
          transcriptInfo.isFile() && transcriptInfo.size > 0,
          "recovery transcript was empty or not a regular file",
        );
        const transcriptText = await readFile(transcriptPath, "utf8");
        assertCondition(
          transcriptText.includes(sentinel),
          "recovery transcript did not contain the original sentinel answer",
        );
        assertNoSensitiveText(transcriptText, token, proxy, "recovery transcript");
        assertNoSensitiveText(
          await sessionStore.readLog(session.id),
          token,
          proxy,
          "session output log",
        );
        await assertSessionTreeHasNoSecrets(sessionPaths.dir, token, proxy);

        const readyAfter = await waitForIdleReady(config.target, token, config);
        assertIdleOwnedDirectLane(readyAfter, config);
        const healthAfter = await readHealth(config.target, token);
        const healthAfterObservedAtMs = performance.now();
        assertIdleHealth(healthAfter);
        assertStableWorker(
          healthBefore,
          healthAfter,
          healthAfterObservedAtMs - healthBeforeObservedAtMs,
        );
        const chromePidAfter = await readOptionalChromePid(config.chromePidFile);
        if (chromePidBefore !== null) {
          assertCondition(
            chromePidAfter === chromePidBefore,
            "Chrome PID changed during the caller-disconnect recovery smoke",
          );
        }

        structuredLog.record("recovery_completed", {
          session_id: session.id,
          origin_run_hash: shortHash(failedRoute.runId ?? ""),
          recovery_run_hash: shortHash(finalSnapshot.recoveryRoute?.runId ?? ""),
          run_post_attempts: finalSnapshot.runPostAttempts,
          run_posts_forwarded: finalSnapshot.runPostsForwarded,
          recovery_post_attempts: finalSnapshot.recoveryPostAttempts,
          recovery_posts_forwarded: finalSnapshot.recoveryPostsForwarded,
          authenticated_claim_lookups: finalSnapshot.claimLookupsForwarded,
          claim_ready_before_disconnect: finalSnapshot.claimReadyBeforeDisconnect,
          protected_route_proof_before_submit: true,
          answer_now_click_log_observed: false,
          chrome_owner_verified_after: true,
          chrome_pid_stable: chromePidBefore === null ? null : chromePidAfter === chromePidBefore,
          transcript_sha256: `sha256:${sha256(transcriptText)}`,
          sentinel_sha256: `sha256:${sha256(sentinel)}`,
          session_preserved: true,
        });
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const safeMessage = proxy
          ? proxy.redactSensitive(rawMessage)
          : rawMessage
              .split(token)
              .join("[redacted]")
              .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]");
        const hardHalt = challengeObserved || hasChallengeSignal(safeMessage);
        testError = new Error(
          hardHalt
            ? `HARD-HALT: account challenge/quarantine during remote recovery smoke; keep the account drained and send the operator an urgent Gavel task. ${safeMessage}`
            : safeMessage,
        );
        structuredLog?.record("failed", {
          session_id: sessionId,
          error_kind: error instanceof Error ? error.name : typeof error,
          error_message: testError.message,
          hard_halt: hardHalt,
          account_must_remain_drained: true,
          session_preserved: Boolean(sessionId),
        });
      } finally {
        if (proxy) {
          try {
            await proxy.close();
            assertCondition(
              proxy.snapshot().outstandingUpstreamRequests === 0,
              "test proxy cleanup left an outbound worker request alive",
            );
          } catch (cleanupError) {
            const rawCleanupMessage =
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            const cleanupFailure = new Error(
              `HARD-HALT: proxy cleanup could not prove all outbound recovery requests stopped; keep the account drained and send the operator an urgent Gavel task. ${proxy.redactSensitive(rawCleanupMessage)}`,
            );
            structuredLog?.record("cleanup_failed", {
              session_id: sessionId,
              error_message: cleanupFailure.message,
              hard_halt: true,
              account_must_remain_drained: true,
              session_preserved: Boolean(sessionId),
            });
            testError = testError
              ? new Error(`${testError.message}\n${cleanupFailure.message}`, {
                  cause: new AggregateError([testError, cleanupFailure]),
                })
              : cleanupFailure;
          }
        }
        if (accountLockHeld) {
          await releaseLiveTestLock(accountLock).catch(() => undefined);
        }
        if (globalLockHeld) {
          await releaseLiveTestLock(globalLock).catch(() => undefined);
        }
        structuredLog?.record("lease_released", {
          global_lock: globalLock,
          account_lock: accountLock,
          session_preserved: Boolean(sessionId),
        });
        restoreEnvironment("ORACLE_HOME_DIR", previousEnvironment.oracleHome);
        restoreEnvironment("ORACLE_REMOTE_HOST", previousEnvironment.remoteHost);
        restoreEnvironment("ORACLE_REMOTE_TOKEN", previousEnvironment.remoteToken);
        restoreEnvironment("ORACLE_TEST_ALLOW_LEGACY_ROUTES", previousEnvironment.legacyRoutes);
        if (structuredLog && evidencePath) {
          assertStructuredTestLogRecords(structuredLog.records());
          const serialized = `${structuredLog.jsonLines().join("\n")}\n`;
          assertNoSensitiveText(serialized, token, proxy, "structured evidence");
          await structuredLog.writeJsonl(evidencePath);
          await chmod(evidencePath, 0o600);
        }
      }

      if (testError) throw testError;
    },
    MAX_LIVE_TEST_MS,
  );
});

function loadLiveRecoveryConfig(): LiveRecoveryConfig {
  assertEnvironmentAck("ORACLE_LIVE_DIRECT_LANE_ACK");
  assertEnvironmentAck("ORACLE_LIVE_ACCOUNT_DRAINED");
  assertEnvironmentAck("ORACLE_LIVE_PRESERVE_SESSION");
  if (process.env.ORACLE_REMOTE_TOKEN?.trim()) {
    throw new Error(
      "Refusing live recovery smoke with ORACLE_REMOTE_TOKEN set; use only ORACLE_LIVE_REMOTE_TOKEN_FILE.",
    );
  }

  const targetHost = requiredEnvironment("ORACLE_LIVE_REMOTE_HOST");
  const target = parseDirectTarget(targetHost);
  if (![9473, 9474].includes(target.port)) {
    throw new Error(
      "ORACLE_LIVE_REMOTE_HOST must be a direct worker lane on port 9473 or 9474; router/account-tier ports are refused.",
    );
  }
  const expectedAccountId = requiredEnvironment("ORACLE_LIVE_EXPECT_ACCOUNT");
  const expectedLaneId = requiredEnvironment("ORACLE_LIVE_EXPECT_LANE");
  if (
    !/^[A-Za-z0-9._-]{1,64}$/u.test(expectedAccountId) ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(expectedLaneId) ||
    expectedLaneId !== `${expectedAccountId}-${target.port}`
  ) {
    throw new Error("expected account/lane identity does not match the direct target port");
  }

  const tokenFile = path.resolve(requiredEnvironment("ORACLE_LIVE_REMOTE_TOKEN_FILE"));
  if (!path.isAbsolute(requiredEnvironment("ORACLE_LIVE_REMOTE_TOKEN_FILE"))) {
    throw new Error("ORACLE_LIVE_REMOTE_TOKEN_FILE must be an absolute path");
  }
  const oracleHome = path.resolve(requiredEnvironment("ORACLE_LIVE_ORACLE_HOME"));
  const expectedOracleHome = path.resolve(os.homedir(), ".oracle");
  if (oracleHome !== expectedOracleHome) {
    throw new Error(
      "ORACLE_LIVE_ORACLE_HOME must resolve to this operator's ~/.oracle so the recovery session is preserved for manual inspection.",
    );
  }

  const chromePidRaw = process.env.ORACLE_LIVE_CHROME_PID_FILE?.trim();
  // This optional proof is available only when the test process can read the
  // worker VM's PID file (shared filesystem or test executed on that VM).
  // Otherwise the operator runbook must snapshot the remote Chrome PID; the
  // smoke still enforces owned-CDP readiness and worker-uptime continuity.
  const chromePidFile = chromePidRaw ? path.resolve(chromePidRaw) : null;
  if (chromePidRaw && !path.isAbsolute(chromePidRaw)) {
    throw new Error("ORACLE_LIVE_CHROME_PID_FILE must be absolute when supplied");
  }

  return {
    target,
    targetHost,
    tokenFile,
    expectedAccountId,
    expectedLaneId,
    oracleHome,
    recoveryTimeoutMs: boundedDurationEnvironment(
      "ORACLE_LIVE_RECOVERY_TIMEOUT_MS",
      DEFAULT_RECOVERY_TIMEOUT_MS,
      10 * 60_000,
      65 * 60_000,
    ),
    claimReadyTimeoutMs: boundedDurationEnvironment(
      "ORACLE_LIVE_CLAIM_READY_TIMEOUT_MS",
      DEFAULT_CLAIM_READY_TIMEOUT_MS,
      10_000,
      10 * 60_000,
    ),
    chromePidFile,
  };
}

function parseDirectTarget(value: string): RemoteRecoveryProxyTarget {
  if (/^[a-z]+:\/\//iu.test(value) || /[/?#]/u.test(value)) {
    throw new Error("ORACLE_LIVE_REMOTE_HOST must be bare host:port without a URL path");
  }
  const match = /^([^:\s]+):(\d{1,5})$/u.exec(value);
  if (!match) throw new Error("ORACLE_LIVE_REMOTE_HOST must use bare host:port syntax");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("ORACLE_LIVE_REMOTE_HOST contains an invalid TCP port");
  }
  return { hostname: match[1], port };
}

async function readReady(target: RemoteRecoveryProxyTarget, token: string): Promise<JsonResponse> {
  return await requestJson(target, "/ready", token);
}

async function readHealth(target: RemoteRecoveryProxyTarget, token: string): Promise<JsonResponse> {
  return await requestJson(target, "/health", token);
}

async function requestJson(
  target: RemoteRecoveryProxyTarget,
  requestPath: string,
  token: string,
): Promise<JsonResponse> {
  return await new Promise<JsonResponse>((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: requestPath,
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          connection: "close",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > 1024 * 1024) {
            request.destroy(new Error("worker JSON response exceeded 1 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("worker response was not a JSON object");
            }
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              body: parsed as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(10_000, () => {
      request.destroy(new Error("worker JSON probe timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitForIdleReady(
  target: RemoteRecoveryProxyTarget,
  token: string,
  config: LiveRecoveryConfig,
): Promise<JsonResponse> {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
  let latest: JsonResponse | null = null;
  while (Date.now() <= deadline) {
    latest = await readReady(target, token);
    assertNoRemoteLaneChallenge(latest, "post-disconnect direct-lane readiness wait");
    if (latest.statusCode === 200) return latest;
    if (latest.statusCode === 503) {
      throw new Error(`direct lane ${config.expectedLaneId} became unavailable during recovery`);
    }
    await delay(READY_POLL_INTERVAL_MS);
  }
  throw new Error(
    `direct lane ${config.expectedLaneId} did not return to idle-ready after caller disconnect`,
  );
}

function assertIdleOwnedDirectLane(response: JsonResponse, config: LiveRecoveryConfig): void {
  assertNoRemoteLaneChallenge(response, "direct-lane readiness preflight/postflight");
  const identity = asObject(response.body.identity);
  const quarantine = asObject(response.body.quarantine);
  const manifest = asObject(response.body.manifest);
  assertCondition(
    response.statusCode === 200 &&
      response.body.ok === true &&
      response.body.state === "idle-ready" &&
      response.body.busy === false &&
      response.body.admitting === false &&
      response.body.attachOnly === true &&
      response.body.chromeReachable === true &&
      response.body.chromeOwnerOk === true &&
      response.body.activeLeaseCount === 0 &&
      response.body.leaseRegistryReadable === true &&
      identity.accountId === config.expectedAccountId &&
      identity.laneId === config.expectedLaneId &&
      identity.port === config.target.port &&
      quarantine.quarantined === false &&
      manifest.present === true &&
      manifest.match === true,
    "direct worker was not an idle, manifest-matched, owned Chrome lane with the expected identity",
  );
}

function assertIdleHealth(response: JsonResponse): void {
  assertCondition(
    response.statusCode === 200 &&
      response.body.ok === true &&
      response.body.busy === false &&
      response.body.state === "idle-ready" &&
      typeof response.body.version === "string" &&
      typeof response.body.uptimeSeconds === "number",
    "worker health was not idle-ready",
  );
}

function assertStableWorker(
  before: JsonResponse,
  after: JsonResponse,
  elapsedMonotonicMs: number,
): void {
  const expectedMinimumUptime =
    (before.body.uptimeSeconds as number) + Math.max(0, elapsedMonotonicMs / 1000) - 5;
  assertCondition(
    after.body.version === before.body.version &&
      sha256(JSON.stringify(after.body.build ?? null)) ===
        sha256(JSON.stringify(before.body.build ?? null)) &&
      typeof after.body.uptimeSeconds === "number" &&
      typeof before.body.uptimeSeconds === "number" &&
      after.body.uptimeSeconds >= expectedMinimumUptime,
    "remote worker restarted or changed build during the recovery smoke",
  );
}

function assertControlledDisconnectSnapshot(
  snapshot: RemoteRecoveryProxySnapshot,
  config: LiveRecoveryConfig,
): void {
  assertCondition(
    snapshot.runPostAttempts === 1 &&
      snapshot.runPostsForwarded === 1 &&
      snapshot.recoveryPostAttempts === 0 &&
      snapshot.recoveryPostsForwarded === 0 &&
      snapshot.runRequestContractVerified &&
      snapshot.runResponseContractVerified &&
      snapshot.protectedRouteProofObserved &&
      snapshot.submitConfirmationObserved &&
      !snapshot.forbiddenAnswerNowClickObserved &&
      snapshot.claimReadyBeforeDisconnect &&
      snapshot.internalClaimLookupStatuses.includes(200) &&
      snapshot.disconnected &&
      snapshot.acceptedRoute?.accountId === config.expectedAccountId &&
      snapshot.acceptedRoute.laneId === config.expectedLaneId,
    "controlled disconnect evidence was incomplete or route-mismatched",
  );
}

function assertFinalProxySnapshot(
  final: RemoteRecoveryProxySnapshot,
  beforeAttach: RemoteRecoveryProxySnapshot,
  config: LiveRecoveryConfig,
): void {
  assertCondition(
    final.runPostAttempts === 1 &&
      final.runPostsForwarded === 1 &&
      final.recoveryPostAttempts === 1 &&
      final.recoveryPostsForwarded === 1 &&
      final.recoveryRequestContractVerified &&
      final.recoveryClaimBindingVerified &&
      final.recoveryResponseContractVerified &&
      final.recoveryRoute?.accountId === config.expectedAccountId &&
      final.recoveryRoute.laneId === config.expectedLaneId &&
      final.acceptedRoute?.runId === beforeAttach.acceptedRoute?.runId &&
      final.claimLookupsForwarded > beforeAttach.claimLookupsForwarded,
    "reattach replayed /runs, duplicated /recover, or changed route identity",
  );
}

async function runSessionRender(input: {
  sessionId: string;
  oracleHome: string;
  proxyHost: string;
  token: string;
  timeoutMs: number;
}): Promise<ChildResult> {
  const cliEntry = fileURLToPath(new URL("../../bin/oracle-cli.ts", import.meta.url));
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ORACLE_HOME_DIR: input.oracleHome,
    ORACLE_REMOTE_HOST: input.proxyHost,
    ORACLE_REMOTE_TOKEN: input.token,
    ORACLE_REMOTE_BROWSER: "required",
    ORACLE_NO_DETACH: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  delete childEnvironment.ORACLE_TEST_ALLOW_LEGACY_ROUTES;
  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--no-deprecation",
        "--import",
        "tsx",
        cliEntry,
        "session",
        input.sessionId,
        "--render",
        "--hide-prompt",
      ],
      {
        cwd: process.cwd(),
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminalError: Error | null = null;
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = (error: Error): void => {
      if (settled || terminalError) return;
      terminalError = error;
      clearTimeout(timer);
      child.kill("SIGTERM");
      escalationTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, CHILD_TERMINATE_GRACE_MS);
    };
    const timer = setTimeout(() => {
      terminate(new Error("session --render exceeded its bounded recovery timeout"));
    }, input.timeoutMs);
    const capture = (target: Buffer[], stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (terminalError) return;
      const next = stream === "stdout" ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
      if (next > MAX_CHILD_OUTPUT_BYTES) {
        terminate(new Error(`session --render ${stream} exceeded its bounded capture limit`));
        return;
      }
      if (stream === "stdout") stdoutBytes = next;
      else stderrBytes = next;
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout, "stdout"));
    child.stderr.on("data", capture(stderr, "stderr"));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      reject(terminalError ?? error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (terminalError) {
        reject(terminalError);
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    });
  });
}

async function readOptionalChromePid(filePath: string | null): Promise<number | null> {
  if (!filePath) return null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 64) {
      throw new Error("Chrome PID proof path was not a bounded regular file");
    }
    const raw = (await handle.readFile("utf8")).trim();
    if (!/^[1-9]\d{0,9}$/u.test(raw)) {
      throw new Error("Chrome PID proof file did not contain one positive PID");
    }
    return Number(raw);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSessionTreeHasNoSecrets(
  root: string,
  token: string,
  proxy: RemoteRecoverySeveringProxy,
): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      assertCondition(entry.isFile(), "session tree contained a non-regular filesystem entry");
      const info = await stat(candidate);
      assertCondition(info.size <= 2 * 1024 * 1024, "session evidence file exceeded scan limit");
      const text = await readFile(candidate, "utf8");
      assertNoSensitiveText(text, token, proxy, "preserved session tree");
    }
  }
}

function assertNoSensitiveText(
  text: string,
  token: string,
  proxy: RemoteRecoverySeveringProxy | null,
  label: string,
): void {
  if (text.includes(token) || proxy?.containsSensitive(text)) {
    throw new Error(`${label} contained remote authentication or recovery authority`);
  }
}

function assertNoChallenge(lines: readonly string[], error: unknown): void {
  const errorText = error instanceof Error ? error.message : error ? String(error) : "";
  if (lines.some(hasPositiveChallengeLog) || hasChallengeSignal(errorText)) {
    throw new Error("account challenge/quarantine detected during remote recovery smoke");
  }
}

function hasPositiveChallengeLog(value: string): boolean {
  return /account[_ -]?quarant|cloudflare (?:challenge|anti-bot page) detected|challenge[_ -]?detected|captcha (?:detected|required)|verification[_ -]?interstitial (?:detected|required)|human verification required/iu.test(
    value,
  );
}

function hasChallengeSignal(value: string): boolean {
  return /account[_ -]?quarant|cloudflare|challenge(?:[_ -]?gate)?|captcha|verification[_ -]?interstitial|interstitial/iu.test(
    value,
  );
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live remote recovery smoke`);
  return value;
}

function assertEnvironmentAck(name: string): void {
  if (process.env[name] !== "1") {
    throw new Error(`${name}=1 is required for the live remote recovery smoke`);
  }
}

function boundedDurationEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 16);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
