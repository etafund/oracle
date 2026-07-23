import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { computePromptSha256 } from "../../src/browser/actions/captureBinding.js";
import {
  buildPromptRecoveryOwnershipPreview,
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../../src/browser/promptDomMatch.js";
import type { BrowserRunOptions } from "../../src/browser/types.js";
import {
  createRemoteBrowserExecutor,
  getRemoteBrowserPendingRecoveryClaimFromError,
  getRemoteBrowserRecoveryFromError,
  recoverRemoteBrowserSession,
  RemoteRunFailedError,
} from "../../src/remote/client.js";
import { createRemoteServer } from "../../src/remote/server.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS,
  REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH,
  REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER,
  REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE,
  REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA,
  REMOTE_BROWSER_RECOVERY_PATH,
  REMOTE_BROWSER_RECOVERY_PROTOCOL,
  REMOTE_BROWSER_RUN_PATH,
  REMOTE_BROWSER_RUN_SCHEMA,
  type RemoteBrowserRecoveryRequest,
} from "../../src/remote/types.js";
import {
  assertNoRemoteLaneChallenge,
  readOwnerOnlyTokenFile,
  startRemoteRecoverySeveringProxy,
} from "../_helpers/remoteRecoverySeveringProxy.js";
import { emitDurableRecoveryCheckpoint } from "./_submissionProvenanceFixture.js";

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require("net");
      const server = net.createServer();
      server.on("error", () => process.exit(1));
      server.listen(0, "127.0.0.1", () => server.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

const TOKEN = "remote-recovery-severing-proxy-test-token";
const ACCOUNT_ID = "acct2";
const LANE_ID = "acct2-9474";
const SESSION_ID = "remote-recovery-severing-proxy-test";
const PROMPT = "Controlled proxy recovery test";
const RUN_ID = "remote-recovery-severing-proxy-run";
const CLAIM_KEY = "A".repeat(43);
const RECOVERY_CAPABILITY = `v2.${"B".repeat(43)}`;
const savedFleetDir = process.env.ORACLE_FLEET_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (savedFleetDir === undefined) delete process.env.ORACLE_FLEET_DIR;
  else process.env.ORACLE_FLEET_DIR = savedFleetDir;
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("remote recovery severing proxy", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "cuts only after a ready claim, authenticates client lookup, and refuses replay",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-proxy-"));
      tempDirs.push(root);
      process.env.ORACLE_FLEET_DIR = path.join(root, "fleet");
      let browserInvocations = 0;
      const worker = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: TOKEN,
          accountId: ACCOUNT_ID,
          laneId: LANE_ID,
          attachOnly: false,
          logger: () => {},
          recoveryClaimStoreDir: path.join(root, "claims"),
          recoveryCheckpointGraceMs: 1_000,
        },
        {
          runBrowser: async (options: BrowserRunOptions) => {
            browserInvocations += 1;
            options.log?.(
              "Protected route: GPT-5.6 Sol + Pro public-menu proof minted at the dispatch boundary",
            );
            options.log?.("AGENTS.md: never click Answer now; wait for the real Pro response.");
            options.log?.("Submitted prompt via Enter key");
            await emitDurableRecoveryCheckpoint(options, PROMPT, "proxy-test-conversation");
            return await waitForCallerGone(options.signal);
          },
        },
      );
      const proxy = await startRemoteRecoverySeveringProxy({
        target: { hostname: "127.0.0.1", port: worker.port },
        token: TOKEN,
        expectedAccountId: ACCOUNT_ID,
        expectedLaneId: LANE_ID,
        expectedSessionId: SESSION_ID,
        expectedPromptSha256: computePromptSha256(PROMPT),
        expectedPromptPreviewSha256: computePromptSha256(
          buildPromptRecoveryOwnershipPreview(PROMPT),
        ),
        claimReadyTimeoutMs: 3_000,
        claimPollIntervalMs: 20,
      });

      try {
        const execute = createRemoteBrowserExecutor({
          host: proxy.host,
          token: TOKEN,
          streamIdleTimeoutMs: 3_000,
          recoveryClaimLookupTimeoutMs: 3_000,
          recoveryClaimPollIntervalMs: 20,
        });
        const failure = await execute({
          sessionId: SESSION_ID,
          prompt: PROMPT,
          config: {
            desiredModel: "GPT-5.6 Sol",
            modelStrategy: "select",
            thinkingTime: "extended",
            archiveConversations: "never",
          },
        }).then(
          () => null,
          (error: unknown) => error,
        );
        await proxy.waitForDisconnect();

        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_after_submit",
        );
        expect(getRemoteBrowserPendingRecoveryClaimFromError(failure)).toMatchObject({
          accountId: ACCOUNT_ID,
          originLaneId: LANE_ID,
        });
        const recoveryCarrier = getRemoteBrowserRecoveryFromError(failure);
        expect(recoveryCarrier).toMatchObject({
          accountId: ACCOUNT_ID,
          laneId: LANE_ID,
        });
        if (!recoveryCarrier) throw new Error("fixture lost its recovery carrier");
        expect(proxy.containsSensitive(recoveryCarrier.recovery.capability)).toBe(true);
        expect(proxy.redactSensitive(recoveryCarrier.recovery.capability)).not.toContain(
          recoveryCarrier.recovery.capability,
        );

        const beforeReplay = proxy.snapshot();
        expect(beforeReplay).toMatchObject({
          runPostAttempts: 1,
          runPostsForwarded: 1,
          claimReadyBeforeDisconnect: true,
          protectedRouteProofObserved: true,
          submitConfirmationObserved: true,
          disconnected: true,
        });
        expect(beforeReplay.claimLookupsForwarded).toBeGreaterThanOrEqual(1);
        expect(beforeReplay.claimLookupStatuses).toContain(200);
        expect(proxy.containsSensitive(JSON.stringify(beforeReplay))).toBe(false);

        expect(await postReplay(proxy.port)).toBe(409);
        expect(proxy.snapshot()).toMatchObject({
          runPostAttempts: 2,
          runPostsForwarded: 1,
        });
        expect(browserInvocations).toBe(1);
      } finally {
        await proxy.close();
        await worker.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "forwards exactly one origin-bound capture-only recovery and returns its sentinel",
    async () => {
      const conversationId = "proxy-recovery-conversation";
      const promptPreview = buildPromptRecoveryOwnershipPreview(PROMPT);
      const promptPreviewSha256 = computePromptSha256(promptPreview);
      const promptDomSha256 = "c".repeat(64);
      const recoveryRunId = "remote-recovery-capture-run";
      const answer = "PROXY_RECOVERY_SENTINEL";
      let runRequests = 0;
      let recoveryRequests = 0;
      const observed = {
        recoveryBody: null as Record<string, unknown> | null,
      };

      const recoveryHint: RemoteBrowserRecoveryRequest["recovery"] = {
        category: "browser-automation",
        stage: "capture-binding",
        originRunId: RUN_ID,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        capability: RECOVERY_CAPABILITY,
        promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
        promptPreviewSha256,
        promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
        promptDomSha256,
        runtime: {
          tabUrl: `https://chatgpt.com/c/${conversationId}`,
          conversationId,
          promptSubmitted: true,
        },
      };

      const upstream = http.createServer((request, response) => {
        if (request.method === "GET" && request.url === REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH) {
          request.resume();
          const body = JSON.stringify({
            schema: REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA,
            status: "ready",
            originRunId: RUN_ID,
            originLaneId: LANE_ID,
            recovery: recoveryHint,
          });
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
            [REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER]:
              REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE,
            [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId]: LANE_ID,
            "x-oracle-run-id": RUN_ID,
            "x-oracle-account-id": ACCOUNT_ID,
            "x-oracle-lane-id": LANE_ID,
          });
          response.end(body);
          return;
        }
        if (request.method === "POST" && request.url === REMOTE_BROWSER_RUN_PATH) {
          runRequests += 1;
          request.resume();
          request.on("end", () => {
            response.writeHead(200, {
              "content-type": "application/x-ndjson",
              ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
              [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey]: CLAIM_KEY,
              "x-oracle-run-id": RUN_ID,
              "x-oracle-account-id": ACCOUNT_ID,
              "x-oracle-lane-id": LANE_ID,
            });
            response.write(
              `${JSON.stringify({
                type: "log",
                runId: RUN_ID,
                message:
                  "Protected route: GPT-5.6 Sol + Pro public-menu proof minted at the dispatch boundary",
              })}\n`,
            );
            response.write(
              `${JSON.stringify({
                type: "log",
                runId: RUN_ID,
                message: "Submitted prompt via Enter key",
              })}\n`,
            );
          });
          return;
        }
        if (request.method === "POST" && request.url === REMOTE_BROWSER_RECOVERY_PATH) {
          recoveryRequests += 1;
          void readJsonObject(request).then(
            (body) => {
              observed.recoveryBody = body;
              const terminal = JSON.stringify({
                type: "done",
                ok: true,
                runId: recoveryRunId,
                result: {
                  answerText: answer,
                  answerMarkdown: answer,
                  tookMs: 7,
                  answerTokens: 4,
                  answerChars: answer.length,
                  tabUrl: `https://chatgpt.com/c/${conversationId}`,
                  conversationId,
                  promptSubmitted: true,
                },
                provenance: {
                  captureBindingVerified: true,
                  captureBindingQuality: "message-handle",
                  challengeClean: true,
                  submission: null,
                },
              });
              response.writeHead(200, {
                "content-type": "application/x-ndjson",
                ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
                "x-oracle-run-id": recoveryRunId,
                "x-oracle-account-id": ACCOUNT_ID,
                "x-oracle-lane-id": LANE_ID,
              });
              const activeClick =
                recoveryRequests === 2
                  ? `${JSON.stringify({
                      type: "log",
                      runId: recoveryRunId,
                      message: "Clicking Answer now during capture recovery",
                    })}\n`
                  : "";
              response.end(`${activeClick}${terminal}\n`);
            },
            () => {
              response.writeHead(400).end();
            },
          );
          return;
        }
        request.resume();
        response.writeHead(404).end();
      });
      await listen(upstream);
      const address = upstream.address();
      if (!address || typeof address === "string") {
        throw new Error("synthetic recovery worker did not bind");
      }
      const proxy = await startRemoteRecoverySeveringProxy({
        target: { hostname: "127.0.0.1", port: address.port },
        token: TOKEN,
        expectedAccountId: ACCOUNT_ID,
        expectedLaneId: LANE_ID,
        expectedSessionId: SESSION_ID,
        expectedPromptSha256: computePromptSha256(PROMPT),
        expectedPromptPreviewSha256: promptPreviewSha256,
        claimReadyTimeoutMs: 3_000,
        claimPollIntervalMs: 20,
      });

      try {
        await Promise.all([postValidRun(proxy.port), proxy.waitForDisconnect()]);
        const request: RemoteBrowserRecoveryRequest = {
          schema: REMOTE_BROWSER_RECOVERY_PROTOCOL,
          recovery: recoveryHint,
          promptPreview,
          browserConfig: {
            desiredModel: "GPT-5.6 Sol",
            modelStrategy: "select",
            thinkingTime: "extended",
            archiveConversations: "never",
            timeoutMs: 60_000,
          },
          options: { sessionId: SESSION_ID },
        };
        // A distinct wrapper skips the client's /health compatibility
        // preflight; this focused fixture serves only the two versioned paths
        // whose composition is under test.
        const requestFn = ((...args: Parameters<typeof http.request>) =>
          http.request(...args)) as typeof http.request;
        const result = await recoverRemoteBrowserSession({
          host: proxy.host,
          token: TOKEN,
          accountId: ACCOUNT_ID,
          request,
          requestFn,
          streamIdleTimeoutMs: 3_000,
        }).catch((error: unknown) => {
          throw new Error(
            `capture-only recovery failed (${error instanceof Error ? error.message : String(error)}); proxy=${JSON.stringify(proxy.snapshot())}`,
            { cause: error },
          );
        });

        expect(result).toMatchObject({
          answerText: answer,
          answerMarkdown: answer,
          conversationId,
          promptSubmitted: true,
          remoteRun: {
            runId: recoveryRunId,
            accountId: ACCOUNT_ID,
            laneId: LANE_ID,
            terminalDoneOk: true,
            provenance: {
              captureBindingVerified: true,
              captureBindingQuality: "message-handle",
              challengeClean: true,
            },
          },
        });
        expect(runRequests).toBe(1);
        expect(recoveryRequests).toBe(1);
        expect(observed.recoveryBody).toMatchObject({
          schema: REMOTE_BROWSER_RECOVERY_PROTOCOL,
          promptPreview,
          recovery: {
            originRunId: RUN_ID,
            runtime: { conversationId, promptSubmitted: true },
          },
        });
        expect(observed.recoveryBody).not.toHaveProperty("prompt");
        expect(observed.recoveryBody).not.toHaveProperty("attachments");
        expect(observed.recoveryBody?.browserConfig).toEqual({ timeoutMs: 60_000 });
        expect(proxy.snapshot()).toMatchObject({
          runPostAttempts: 1,
          runPostsForwarded: 1,
          recoveryPostAttempts: 1,
          recoveryPostsForwarded: 1,
          runRequestContractVerified: true,
          recoveryRequestContractVerified: true,
          recoveryClaimBindingVerified: true,
          runResponseContractVerified: true,
          recoveryResponseContractVerified: true,
          claimReadyBeforeDisconnect: true,
          disconnected: true,
          forbiddenAnswerNowClickObserved: false,
          acceptedRoute: {
            runId: RUN_ID,
            accountId: ACCOUNT_ID,
            laneId: LANE_ID,
          },
          recoveryRoute: {
            runId: recoveryRunId,
            accountId: ACCOUNT_ID,
            laneId: LANE_ID,
          },
        });
        expect(proxy.containsSensitive(JSON.stringify(proxy.snapshot()))).toBe(false);

        const rejectingProxy = await startRemoteRecoverySeveringProxy({
          target: { hostname: "127.0.0.1", port: address.port },
          token: TOKEN,
          expectedAccountId: ACCOUNT_ID,
          expectedLaneId: LANE_ID,
          expectedSessionId: SESSION_ID,
          expectedPromptSha256: computePromptSha256(PROMPT),
          expectedPromptPreviewSha256: promptPreviewSha256,
          claimReadyTimeoutMs: 3_000,
          claimPollIntervalMs: 20,
        });
        const changedCapability = `v2.${"C".repeat(43)}`;
        try {
          await Promise.all([
            postValidRun(rejectingProxy.port),
            rejectingProxy.waitForDisconnect(),
          ]);
          const mismatch = await recoverRemoteBrowserSession({
            host: rejectingProxy.host,
            token: TOKEN,
            accountId: ACCOUNT_ID,
            request: {
              ...request,
              recovery: {
                ...request.recovery,
                capability: changedCapability,
              },
            },
            requestFn,
            streamIdleTimeoutMs: 3_000,
          }).then(
            () => null,
            (error: unknown) => error,
          );
          expect(mismatch).toBeInstanceOf(RemoteRunFailedError);
          expect(mismatch).toBeInstanceOf(Error);
          if (!(mismatch instanceof Error)) throw new Error("expected a typed mismatch failure");
          expect(rejectingProxy.containsSensitive(mismatch.message)).toBe(false);
          expect(mismatch.message).not.toContain(changedCapability);
          expect(rejectingProxy.snapshot()).toMatchObject({
            runPostAttempts: 1,
            runPostsForwarded: 1,
            recoveryPostAttempts: 1,
            recoveryPostsForwarded: 0,
            recoveryRequestContractVerified: false,
            recoveryClaimBindingVerified: false,
            claimReadyBeforeDisconnect: true,
            disconnected: true,
          });
          expect(runRequests).toBe(2);
          expect(recoveryRequests).toBe(1);
        } finally {
          await rejectingProxy.close();
        }

        const clickProxy = await startRemoteRecoverySeveringProxy({
          target: { hostname: "127.0.0.1", port: address.port },
          token: TOKEN,
          expectedAccountId: ACCOUNT_ID,
          expectedLaneId: LANE_ID,
          expectedSessionId: SESSION_ID,
          expectedPromptSha256: computePromptSha256(PROMPT),
          expectedPromptPreviewSha256: promptPreviewSha256,
          claimReadyTimeoutMs: 3_000,
          claimPollIntervalMs: 20,
        });
        try {
          await Promise.all([postValidRun(clickProxy.port), clickProxy.waitForDisconnect()]);
          const clickFailure = await recoverRemoteBrowserSession({
            host: clickProxy.host,
            token: TOKEN,
            accountId: ACCOUNT_ID,
            request,
            requestFn,
            streamIdleTimeoutMs: 3_000,
          }).then(
            () => null,
            (error: unknown) => error,
          );
          expect(clickFailure).toBeInstanceOf(Error);
          expect(clickProxy.snapshot()).toMatchObject({
            recoveryPostAttempts: 1,
            recoveryPostsForwarded: 1,
            recoveryRequestContractVerified: true,
            recoveryClaimBindingVerified: true,
            recoveryResponseContractVerified: true,
            forbiddenAnswerNowClickObserved: true,
          });
          expect(runRequests).toBe(3);
          expect(recoveryRequests).toBe(2);
        } finally {
          await clickProxy.close();
        }
      } finally {
        await proxy.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  test.each([
    {
      name: "done.errorMessage challenge",
      body: JSON.stringify({
        type: "done",
        ok: false,
        runId: RUN_ID,
        errorClass: "integrity_ui_unknown",
        errorMessage: "Cloudflare verification interstitial requires human clearance",
      }),
      maxLineBytes: undefined,
      expected: /account challenge\/quarantine terminated the worker stream/iu,
    },
    {
      name: "active Answer now click",
      body: `${JSON.stringify({
        type: "log",
        runId: RUN_ID,
        message: "Clicking the Answer now control",
      })}\n`,
      maxLineBytes: undefined,
      expected: /forbidden Answer now click/iu,
    },
    {
      name: "post-done data",
      body: `${JSON.stringify({
        type: "done",
        ok: false,
        runId: RUN_ID,
        errorClass: "integrity_ui_unknown",
        errorMessage: "generic failure",
      })}\n${JSON.stringify({ type: "log", runId: RUN_ID, message: "late data" })}\n`,
      maxLineBytes: undefined,
      expected: /data after its terminal done event/iu,
    },
    {
      name: "unterminated oversized line",
      body: "x".repeat(257),
      maxLineBytes: 256,
      expected: /exceeded the 256-byte test proxy cap without a newline/iu,
    },
    {
      name: "unterminated multibyte oversized line",
      body: "é".repeat(129),
      maxLineBytes: 256,
      expected: /exceeded the 256-byte test proxy cap without a newline/iu,
    },
  ])("rejects $name without flattening the failure", async ({ body, maxLineBytes, expected }) => {
    if (!CAN_LISTEN_LOCALHOST) return;
    const error = await observeSyntheticWorkerFailure(body, maxLineBytes);
    expect(error.message).toMatch(expected);
  });

  test("classifies authoritative readiness challenge markers before generic non-idle state", () => {
    const challengeBodies: Array<Record<string, unknown>> = [
      {
        reason: "account_quarantined: verification_interstitial",
        quarantine: { quarantined: true, reason: "verification_interstitial" },
      },
      { errorClass: "account_quarantine" },
      { reason: "cloudflare-challenge" },
      { challenge_detected: true },
    ];
    for (const body of challengeBodies) {
      expect(() =>
        assertNoRemoteLaneChallenge({ statusCode: 503, body }, "direct-lane preflight"),
      ).toThrow(/account challenge\/quarantine detected during direct-lane preflight/iu);
    }
    expect(() =>
      assertNoRemoteLaneChallenge(
        { statusCode: 503, body: { reason: "browser_unavailable" } },
        "direct-lane preflight",
      ),
    ).not.toThrow();
  });

  test.skipIf(process.platform === "win32")("requires an owner-only token file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-token-"));
    tempDirs.push(root);
    const tokenFile = path.join(root, "remote.token");
    await writeFile(tokenFile, "owner-only-token\n", { mode: 0o644 });
    await chmod(tokenFile, 0o644);
    await expect(readOwnerOnlyTokenFile(tokenFile)).rejects.toThrow(/owner-only permissions/iu);
    await chmod(tokenFile, 0o600);
    await expect(readOwnerOnlyTokenFile(tokenFile)).resolves.toBe("owner-only-token");
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "close destroys and awaits a hanging outbound proxy request",
    async () => {
      let releaseAccepted!: () => void;
      const accepted = new Promise<void>((resolve) => {
        releaseAccepted = resolve;
      });
      const upstream = http.createServer(() => {
        releaseAccepted();
      });
      await listen(upstream);
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("upstream did not bind");
      const proxy = await startRemoteRecoverySeveringProxy({
        target: { hostname: "127.0.0.1", port: address.port },
        token: TOKEN,
        expectedAccountId: ACCOUNT_ID,
        expectedLaneId: LANE_ID,
        expectedSessionId: SESSION_ID,
        expectedPromptSha256: computePromptSha256(PROMPT),
        expectedPromptPreviewSha256: computePromptSha256(
          buildPromptRecoveryOwnershipPreview(PROMPT),
        ),
        claimReadyTimeoutMs: 3_000,
      });
      const client = http.get(`http://${proxy.host}/health`);
      client.on("error", () => undefined);
      try {
        await accepted;
        await proxy.close();
        expect(proxy.snapshot().outstandingUpstreamRequests).toBe(0);
      } finally {
        client.destroy();
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "clamps a hanging claim lookup to the remaining ready deadline",
    async () => {
      const upstream = http.createServer((request, response) => {
        if (request.method === "GET" && request.url === REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH) {
          request.resume();
          return;
        }
        if (request.method === "POST" && request.url === REMOTE_BROWSER_RUN_PATH) {
          request.resume();
          request.on("end", () => {
            response.writeHead(200, {
              "content-type": "application/x-ndjson",
              ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
              [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey]: CLAIM_KEY,
              "x-oracle-run-id": RUN_ID,
              "x-oracle-account-id": ACCOUNT_ID,
              "x-oracle-lane-id": LANE_ID,
            });
            response.write(
              `${JSON.stringify({
                type: "log",
                runId: RUN_ID,
                message:
                  "Protected route: GPT-5.6 Sol + Pro public-menu proof minted at the dispatch boundary",
              })}\n`,
            );
            response.write(
              `${JSON.stringify({
                type: "log",
                runId: RUN_ID,
                message: "Submitted prompt via Enter key",
              })}\n`,
            );
          });
          return;
        }
        request.resume();
        response.writeHead(404).end();
      });
      await listen(upstream);
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("upstream did not bind");
      const proxy = await startRemoteRecoverySeveringProxy({
        target: { hostname: "127.0.0.1", port: address.port },
        token: TOKEN,
        expectedAccountId: ACCOUNT_ID,
        expectedLaneId: LANE_ID,
        expectedSessionId: SESSION_ID,
        expectedPromptSha256: computePromptSha256(PROMPT),
        expectedPromptPreviewSha256: computePromptSha256(
          buildPromptRecoveryOwnershipPreview(PROMPT),
        ),
        claimReadyTimeoutMs: 1_000,
      });
      const startedAt = performance.now();
      const failure = proxy.waitForDisconnect().then(
        () => new Error("hanging claim unexpectedly reached the controlled disconnect"),
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      try {
        await postValidRun(proxy.port);
        const error = await failure;
        expect(error.message).toMatch(/durable claim lookup exceeded its absolute deadline/iu);
        expect(performance.now() - startedAt).toBeLessThan(2_500);
      } finally {
        await proxy.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          upstream.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});

async function observeSyntheticWorkerFailure(
  responseBody: string,
  maxNdjsonLineBytes?: number,
): Promise<Error> {
  const upstream = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH) {
      request.resume();
      sendPendingClaim(response);
      return;
    }
    if (request.method === "POST" && request.url === REMOTE_BROWSER_RUN_PATH) {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          "x-oracle-run-id": RUN_ID,
          "x-oracle-account-id": ACCOUNT_ID,
          "x-oracle-lane-id": LANE_ID,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey]: CLAIM_KEY,
        });
        response.end(responseBody);
      });
      return;
    }
    response.writeHead(404).end();
  });
  await listen(upstream);
  const address = upstream.address();
  if (!address || typeof address === "string") {
    throw new Error("synthetic worker did not bind");
  }
  const proxy = await startRemoteRecoverySeveringProxy({
    target: { hostname: "127.0.0.1", port: address.port },
    token: TOKEN,
    expectedAccountId: ACCOUNT_ID,
    expectedLaneId: LANE_ID,
    expectedSessionId: SESSION_ID,
    expectedPromptSha256: computePromptSha256(PROMPT),
    expectedPromptPreviewSha256: computePromptSha256(buildPromptRecoveryOwnershipPreview(PROMPT)),
    claimReadyTimeoutMs: 3_000,
    claimPollIntervalMs: 20,
    maxNdjsonLineBytes,
  });
  const failure = proxy.waitForDisconnect().then(
    () => new Error("synthetic worker unexpectedly reached the controlled disconnect"),
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  try {
    await postValidRun(proxy.port).catch(() => undefined);
    return await failure;
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function sendPendingClaim(response: http.ServerResponse): void {
  const body = JSON.stringify({ error: "recovery_claim_pending" });
  response.writeHead(425, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
    [REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER]: REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE,
    [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId]: LANE_ID,
    "x-oracle-run-id": RUN_ID,
    "x-oracle-account-id": ACCOUNT_ID,
    "x-oracle-lane-id": LANE_ID,
  });
  response.end(body);
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function readJsonObject(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function postValidRun(port: number): Promise<void> {
  const body = Buffer.from(
    JSON.stringify({
      schema: REMOTE_BROWSER_RUN_SCHEMA,
      prompt: PROMPT,
      attachments: [],
      browserConfig: {
        desiredModel: "GPT-5.6 Sol",
        modelStrategy: "select",
        thinkingTime: "extended",
        archiveConversations: "never",
      },
      options: { sessionId: SESSION_ID, followUpPrompts: [] },
    }),
  );
  await new Promise<void>((resolve, reject) => {
    let responseStarted = false;
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: REMOTE_BROWSER_RUN_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": body.length,
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
        },
      },
      (response) => {
        responseStarted = true;
        response.resume();
        const finish = () => resolve();
        response.once("end", finish);
        response.once("close", finish);
        response.once("error", finish);
      },
    );
    request.on("error", (error) => {
      if (responseStarted) resolve();
      else reject(error);
    });
    request.end(body);
  });
}

async function waitForCallerGone(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_, reject) => {
    if (!signal) {
      reject(new Error("fixture expected a caller-gone signal"));
      return;
    }
    const fail = () => reject(new Error("fixture observed caller-gone abort"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

async function postReplay(port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: REMOTE_BROWSER_RUN_PATH,
        method: "POST",
        headers: { "content-length": "0" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}
