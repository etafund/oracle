import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { BrowserRunOptions } from "../../src/browser/types.js";
import { computePromptSha256 } from "../../src/browser/actions/captureBinding.js";
import { buildPromptRecoveryOwnershipPreview } from "../../src/browser/promptDomMatch.js";
import {
  createRemoteBrowserExecutor,
  getRemoteBrowserFailedRouteFromError,
  getRemoteBrowserPendingRecoveryClaimFromError,
  getRemoteBrowserRecoveryFromError,
  RemoteRunFailedError,
  resolveRemoteBrowserPendingRecoveryClaim,
} from "../../src/remote/client.js";
import { persistRemoteBrowserFailureRecoveryState } from "../../src/cli/sessionRunner.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { promotePendingRemoteBrowserRecoveryClaim } from "../../src/remote/sessionRecovery.js";
import {
  readRemoteBrowserPendingRecoveryClaim,
  readRemoteBrowserRecoverySecret,
} from "../../src/remote/sessionRecoveryStore.js";
import { sessionStore } from "../../src/sessionStore.js";
import { createRemoteServer } from "../../src/remote/server.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS,
  REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH,
  REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER,
  REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE,
  REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA,
  REMOTE_BROWSER_RUN_PATH,
  REMOTE_BROWSER_RUN_SCHEMA,
} from "../../src/remote/types.js";
import { emitDurableRecoveryCheckpoint } from "./_submissionProvenanceFixture.js";

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

const TOKEN = "recovery-claim-integration-token";
const ACCOUNT_ID = "acct2";
const LANE_ID = "acct2-9474";
const savedFleetDir = process.env.ORACLE_FLEET_DIR;
const savedRemoteHost = process.env.ORACLE_REMOTE_HOST;
const savedRemoteToken = process.env.ORACLE_REMOTE_TOKEN;
const tempDirs: string[] = [];

afterEach(async () => {
  setOracleHomeDirOverrideForTest(null);
  if (savedFleetDir === undefined) {
    delete process.env.ORACLE_FLEET_DIR;
  } else {
    process.env.ORACLE_FLEET_DIR = savedFleetDir;
  }
  if (savedRemoteHost === undefined) delete process.env.ORACLE_REMOTE_HOST;
  else process.env.ORACLE_REMOTE_HOST = savedRemoteHost;
  if (savedRemoteToken === undefined) delete process.env.ORACLE_REMOTE_TOKEN;
  else process.env.ORACLE_REMOTE_TOKEN = savedRemoteToken;
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function isolatedState(
  label: string,
): Promise<{ root: string; fleetDir: string; claimDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `oracle-${label}-`));
  tempDirs.push(root);
  const fleetDir = path.join(root, "fleet");
  const claimDir = path.join(root, "claims");
  process.env.ORACLE_FLEET_DIR = fleetDir;
  return { root, fleetDir, claimDir };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_, reject) => {
    if (!signal) {
      reject(new Error("integration fixture expected a caller-gone AbortSignal"));
      return;
    }
    if (signal.aborted) {
      reject(new Error("integration fixture observed caller-gone abort"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("integration fixture observed caller-gone abort")),
      { once: true },
    );
  });
}

async function pendingRecordExists(claimDir: string): Promise<boolean> {
  try {
    const entries = await readdir(claimDir, { recursive: true });
    return entries.some((entry) => entry.endsWith("pending.json"));
  } catch {
    return false;
  }
}

interface RunResponseHandle {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  finished: Promise<string>;
  abort(): void;
}

async function startRun(port: number, prompt: string): Promise<RunResponseHandle> {
  const body = Buffer.from(
    JSON.stringify({
      schema: REMOTE_BROWSER_RUN_SCHEMA,
      prompt,
      attachments: [],
      browserConfig: {},
      options: {},
    }),
  );
  return await new Promise<RunResponseHandle>((resolve, reject) => {
    let response: http.IncomingMessage | null = null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: REMOTE_BROWSER_RUN_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          "content-type": "application/json",
          "content-length": body.length,
        },
      },
      (res) => {
        response = res;
        res.setEncoding("utf8");
        let responseBody = "";
        const finished = new Promise<string>((resolveBody, rejectBody) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolveBody(responseBody);
          };
          res.on("data", (chunk: string) => {
            responseBody += chunk;
          });
          res.on("end", finish);
          res.on("close", finish);
          res.on("error", (error) => {
            if (settled) return;
            settled = true;
            rejectBody(error);
          });
        });
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          finished,
          abort: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.on("error", (error) => {
      if (!response) reject(error);
    });
    req.end(body);
  });
}

interface ClaimCoordinates {
  claimKey: string;
  accountId: string;
  originRunId: string;
  originLaneId: string;
  promptPreviewSha256Candidates: string[];
}

interface JsonResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function lookupClaim(port: number, coordinates: ClaimCoordinates): Promise<JsonResponse> {
  return await new Promise<JsonResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH,
        method: "GET",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: "application/json",
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey]: coordinates.claimKey,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.accountId]: coordinates.accountId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originRunId]: coordinates.originRunId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId]: coordinates.originLaneId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.promptPreviewSha256]:
            coordinates.promptPreviewSha256Candidates.join(","),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: JSON.parse(body) as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function coordinatesFromRun(run: RunResponseHandle, prompt: string): ClaimCoordinates {
  const readHeader = (name: string): string => {
    const value = run.headers[name];
    if (typeof value !== "string") throw new Error(`run response omitted ${name}`);
    return value;
  };
  return {
    claimKey: readHeader(REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey),
    accountId: readHeader("x-oracle-account-id"),
    originRunId: readHeader("x-oracle-run-id"),
    originLaneId: readHeader("x-oracle-lane-id"),
    promptPreviewSha256Candidates: [
      computePromptSha256(buildPromptRecoveryOwnershipPreview(prompt)),
    ],
  };
}

async function waitForClaim(
  port: number,
  coordinates: ClaimCoordinates,
  expectedStatus: number,
  timeoutMs = 3_000,
): Promise<JsonResponse> {
  const deadline = Date.now() + timeoutMs;
  let latest: JsonResponse | null = null;
  while (Date.now() <= deadline) {
    latest = await lookupClaim(port, coordinates);
    if (latest.statusCode === expectedStatus) return latest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `claim never reached HTTP ${expectedStatus}; latest=${JSON.stringify(latest?.body ?? null)}`,
  );
}

async function waitForReady(port: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/ready",
          method: "GET",
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    if (status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("worker did not return to idle-ready");
}

describe("durable remote recovery-claim integration", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "authenticates pending/ready/unrecoverable lookup state and hides every coordinate mismatch",
    async () => {
      const { claimDir } = await isolatedState("recovery-claim-route");
      const publishFirstCheckpoint = deferred();
      const browserCheckedPendingState = deferred();
      let browserInvocations = 0;
      let pendingWasDurableBeforeBrowser = false;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: TOKEN,
          accountId: ACCOUNT_ID,
          laneId: LANE_ID,
          attachOnly: false,
          logger: () => {},
          recoveryClaimStoreDir: claimDir,
          recoveryCheckpointGraceMs: 1_000,
        },
        {
          runBrowser: async (options: BrowserRunOptions) => {
            browserInvocations += 1;
            pendingWasDurableBeforeBrowser = await pendingRecordExists(claimDir);
            browserCheckedPendingState.resolve();
            if (browserInvocations === 1) {
              options.log?.("Submitted prompt via Enter key");
              await publishFirstCheckpoint.promise;
              await emitDurableRecoveryCheckpoint(
                options,
                "durable route proof",
                "durable-route-proof",
              );
              return await waitForAbort(options.signal);
            }
            throw new Error("fixture failed before a recovery checkpoint");
          },
        },
      );

      try {
        const firstRun = await startRun(server.port, "durable route proof");
        expect(firstRun.statusCode).toBe(200);
        const first = coordinatesFromRun(firstRun, "durable route proof");
        expect(first.claimKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const pending = await lookupClaim(server.port, first);
        expect(pending.statusCode).toBe(425);
        expect(pending.body).toEqual({ error: "recovery_claim_pending" });
        expect(pending.headers[REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER]).toBe(
          REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE,
        );
        expect(pending.headers["x-oracle-run-id"]).toBe(first.originRunId);
        expect(pending.headers["x-oracle-account-id"]).toBe(ACCOUNT_ID);
        expect(pending.headers["x-oracle-lane-id"]).toBe(LANE_ID);
        expect(pending.headers[REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId]).toBe(LANE_ID);
        await browserCheckedPendingState.promise;
        expect(pendingWasDurableBeforeBrowser).toBe(true);

        const mismatches: ClaimCoordinates[] = [
          { ...first, claimKey: "B".repeat(43) },
          { ...first, accountId: "acct9" },
          { ...first, originRunId: "wrong-origin-run" },
          { ...first, originLaneId: "wrong-origin-lane" },
          { ...first, promptPreviewSha256Candidates: ["c".repeat(64)] },
        ];
        const mismatchResponses = await Promise.all(
          mismatches.map((coordinates) => lookupClaim(server.port, coordinates)),
        );
        for (const mismatch of mismatchResponses) {
          expect(mismatch.statusCode).toBe(404);
          expect(mismatch.body).toEqual({ error: "recovery_claim_not_found" });
        }

        publishFirstCheckpoint.resolve();
        const ready = await waitForClaim(server.port, first, 200);
        expect(Object.keys(ready.body).sort()).toEqual([
          "originLaneId",
          "originRunId",
          "recovery",
          "schema",
          "status",
        ]);
        expect(ready.body).toMatchObject({
          schema: REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA,
          status: "ready",
          originRunId: first.originRunId,
          originLaneId: LANE_ID,
          recovery: {
            category: "browser-automation",
            stage: "capture-binding",
            originRunId: first.originRunId,
            promptPreviewSha256: first.promptPreviewSha256Candidates[0],
            runtime: {
              tabUrl: "https://chatgpt.com/c/durable-route-proof",
              conversationId: "durable-route-proof",
              promptSubmitted: true,
            },
          },
        });

        firstRun.abort();
        await firstRun.finished.catch(() => "");
        await waitForReady(server.port);
        const stillReady = await lookupClaim(server.port, first);
        expect(stillReady.statusCode).toBe(200);
        expect(stillReady.body).toEqual(ready.body);

        const failedRun = await startRun(server.port, "fails before checkpoint");
        const failed = coordinatesFromRun(failedRun, "fails before checkpoint");
        await failedRun.finished;
        const unrecoverable = await waitForClaim(server.port, failed, 410);
        expect(unrecoverable.body).toEqual({ error: "recovery_claim_unrecoverable" });
        expect(browserInvocations).toBe(2);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "stores an explicit-abort claim immediately and promotes it after the worker binds it",
    async () => {
      const { root, claimDir } = await isolatedState("recovery-claim-explicit-abort");
      setOracleHomeDirOverrideForTest(path.join(root, "oracle-home"));
      await sessionStore.ensureStorage();
      const metadata = await sessionStore.createSession(
        { prompt: "explicit abort recovery", model: "gpt-5.6-sol", mode: "browser" },
        root,
      );
      const submitted = deferred();
      const clientAcceptedClaim = deferred();
      const publishCheckpoint = deferred();
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
          recoveryClaimStoreDir: claimDir,
          recoveryCheckpointGraceMs: 2_000,
        },
        {
          runBrowser: async (options: BrowserRunOptions) => {
            browserInvocations += 1;
            options.log?.("Submitted prompt via Enter key");
            submitted.resolve();
            await publishCheckpoint.promise;
            await emitDurableRecoveryCheckpoint(
              options,
              "explicit abort recovery",
              "explicit-abort-recovery",
            );
            return await waitForAbort(options.signal);
          },
        },
      );

      try {
        const controller = new AbortController();
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${worker.port}`,
          token: TOKEN,
          streamIdleTimeoutMs: 2_000,
          recoveryClaimLookupTimeoutMs: 2_000,
          recoveryClaimPollIntervalMs: 20,
        });
        const pendingRun = executor({
          prompt: "explicit abort recovery",
          config: {},
          sessionId: metadata.id,
          signal: controller.signal,
          log: (message) => {
            if (message.includes("Accepted run route")) clientAcceptedClaim.resolve();
          },
        }).then(
          () => null,
          (error: unknown) => error,
        );
        await submitted.promise;
        await clientAcceptedClaim.promise;
        controller.abort();
        const failure = await pendingRun;
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        const pendingClaim = getRemoteBrowserPendingRecoveryClaimFromError(failure);
        const failedRoute = getRemoteBrowserFailedRouteFromError(failure);
        expect(pendingClaim).toMatchObject({
          originRunId: failedRoute?.runId,
          accountId: ACCOUNT_ID,
          originLaneId: LANE_ID,
        });
        if (!pendingClaim || !failedRoute) throw new Error("abort lost its pending claim route");

        await persistRemoteBrowserFailureRecoveryState({
          sessionId: metadata.id,
          browser: metadata.browser,
          failedRoute,
          pendingRecoveryClaim: pendingClaim,
        });
        await expect(
          readRemoteBrowserPendingRecoveryClaim(metadata.id, failedRoute.runId),
        ).resolves.toMatchObject({
          schema: "remote-browser-pending-recovery-claim-secret.v1",
          claimKey: pendingClaim.claimKey,
          originRunId: failedRoute.runId,
        });
        expect(
          (await sessionStore.readSession(metadata.id))?.browser?.remoteRecovery,
        ).toBeUndefined();

        publishCheckpoint.resolve();
        await waitForReady(worker.port);
        const directReady = await lookupClaim(worker.port, {
          claimKey: pendingClaim.claimKey,
          accountId: pendingClaim.accountId,
          originRunId: pendingClaim.originRunId,
          originLaneId: pendingClaim.originLaneId,
          promptPreviewSha256Candidates: pendingClaim.promptCandidates.map(
            (candidate) => candidate.promptPreviewSha256,
          ),
        });
        expect(directReady.statusCode).toBe(200);
        await expect(
          resolveRemoteBrowserPendingRecoveryClaim({
            host: `127.0.0.1:${worker.port}`,
            token: TOKEN,
            claim: pendingClaim,
            timeoutMs: 2_000,
            pollIntervalMs: 20,
          }),
        ).resolves.toBeTruthy();
        process.env.ORACLE_REMOTE_HOST = `127.0.0.1:${worker.port}`;
        process.env.ORACLE_REMOTE_TOKEN = TOKEN;
        const failedMetadata = await sessionStore.readSession(metadata.id);
        if (!failedMetadata) throw new Error("stored session vanished before claim promotion");
        const promoted = await promotePendingRemoteBrowserRecoveryClaim(failedMetadata, {
          timeoutMs: 2_000,
        });
        expect(promoted?.browser?.remoteRecovery).toMatchObject({
          schema: "remote-browser-recovery-public.v1",
          originRunId: failedRoute.runId,
          accountId: ACCOUNT_ID,
          laneId: LANE_ID,
          runtime: {
            conversationId: "explicit-abort-recovery",
            promptSubmitted: true,
          },
        });
        await expect(
          readRemoteBrowserRecoverySecret(metadata.id, failedRoute.runId),
        ).resolves.toMatchObject({
          schema: "remote-browser-recovery-secret.v2",
          recovery: { originRunId: failedRoute.runId },
          accountId: ACCOUNT_ID,
          laneId: LANE_ID,
        });
        await expect(
          readRemoteBrowserPendingRecoveryClaim(metadata.id, failedRoute.runId),
        ).resolves.toBeNull();
        expect(browserInvocations).toBe(1);
      } finally {
        publishCheckpoint.resolve();
        await worker.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "recovers a severed real HTTP stream through the durable claim without a second POST",
    async () => {
      const { claimDir } = await isolatedState("recovery-claim-severed-stream");
      const streamCut = deferred();
      const firstPendingLookup = deferred();
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
          recoveryClaimStoreDir: claimDir,
          recoveryCheckpointGraceMs: 2_000,
        },
        {
          runBrowser: async (options: BrowserRunOptions) => {
            browserInvocations += 1;
            options.log?.("Submitted prompt via Enter key");
            await streamCut.promise;
            await firstPendingLookup.promise;
            await emitDurableRecoveryCheckpoint(
              options,
              "severed stream recovery",
              "severed-stream-recovery",
            );
            return await waitForAbort(options.signal);
          },
        },
      );
      const proxy = await startSeveringProxy(worker.port, {
        onStreamCut: streamCut.resolve,
        onPendingClaim: firstPendingLookup.resolve,
      });

      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${proxy.port}`,
          token: TOKEN,
          streamIdleTimeoutMs: 2_000,
          recoveryClaimLookupTimeoutMs: 4_000,
          recoveryClaimPollIntervalMs: 20,
        });
        const failure = await executor({ prompt: "severed stream recovery", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_after_submit",
        );
        const recovery = getRemoteBrowserRecoveryFromError(failure);
        expect(recovery).toMatchObject({
          accountId: ACCOUNT_ID,
          laneId: LANE_ID,
          promptPreview: buildPromptRecoveryOwnershipPreview("severed stream recovery"),
          promptDomSha256: "d".repeat(64),
          recovery: {
            category: "browser-automation",
            stage: "capture-binding",
            runtime: {
              tabUrl: "https://chatgpt.com/c/severed-stream-recovery",
              conversationId: "severed-stream-recovery",
              promptSubmitted: true,
            },
          },
        });
        expect(proxy.runPostCount()).toBe(1);
        expect(browserInvocations).toBe(1);
        expect(proxy.claimStatuses()).toContain(425);
        expect(proxy.claimStatuses()).toContain(200);
        await waitForReady(worker.port);
      } finally {
        await proxy.close();
        await worker.close();
      }
    },
  );
});

async function startSeveringProxy(
  workerPort: number,
  hooks: { onStreamCut: () => void; onPendingClaim: () => void },
): Promise<{
  port: number;
  runPostCount: () => number;
  claimStatuses: () => number[];
  close(): Promise<void>;
}> {
  let runPosts = 0;
  const observedClaimStatuses: number[] = [];
  const server = http.createServer((clientReq, clientRes) => {
    const isRun = clientReq.method === "POST" && clientReq.url === REMOTE_BROWSER_RUN_PATH;
    const isClaim =
      clientReq.method === "GET" && clientReq.url === REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH;
    if (isRun) runPosts += 1;

    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: workerPort,
        path: clientReq.url,
        method: clientReq.method,
        headers: { ...clientReq.headers, connection: "close" },
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 502;
        if (isClaim) {
          observedClaimStatuses.push(statusCode);
          if (statusCode === 425) hooks.onPendingClaim();
        }
        clientRes.writeHead(statusCode, upstreamRes.headers);
        if (!isRun) {
          upstreamRes.pipe(clientRes);
          return;
        }

        let severed = false;
        upstreamRes.on("data", (chunk: Buffer) => {
          if (severed) return;
          clientRes.write(chunk);
          if (chunk.toString("utf8").includes("Submitted prompt")) {
            severed = true;
            hooks.onStreamCut();
            clientRes.end();
            upstreamRes.destroy();
          }
        });
        upstreamRes.on("end", () => {
          if (!severed) clientRes.end();
        });
        upstreamRes.on("error", () => {
          if (!severed) clientRes.destroy();
        });
      },
    );
    upstream.on("error", () => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: "proxy_upstream_failed" }));
      } else {
        clientRes.destroy();
      }
    });
    clientReq.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("severing proxy did not bind");
  return {
    port: address.port,
    runPostCount: () => runPosts,
    claimStatuses: () => [...observedClaimStatuses],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
