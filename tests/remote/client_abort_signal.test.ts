import { describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import {
  createRemoteBrowserExecutor,
  getRemoteBrowserPendingRecoveryClaimFromError,
  RemoteRunFailedError,
} from "../../src/remote/client.js";
import { REMOTE_BROWSER_RUN_PATH } from "../../src/remote/types.js";
import {
  serveCompatibleRecoveryHealth,
  setCompatibleRecoveryResponseHeaders,
} from "./_recoveryProtocolFixture.js";
import {
  primarySubmissionProvenance,
  strongRemoteSuccessProvenance,
} from "./_submissionProvenanceFixture.js";

// Caller-gone abort contract for the remote HTTP executor: BrowserRunOptions
// documents `signal` as "Caller-gone abort. When the signal fires, the run
// stops waiting at the next raced wait point" (src/browser/types.ts), and the
// remote executor is the drop-in replacement for runBrowserMode — so it must
// honor the same contract instead of silently dropping the signal.
//
// - a pre-aborted signal must fail fast WITHOUT opening a connection to the
//   worker (nothing was sent, so the class is before-submit and retryable);
// - an abort while the /runs stream is in flight must reject promptly with
//   the typed transport class AND tear down the outbound request so the
//   worker's client-gone handling (res "close" -> onClientGone, which frees
//   the single-flight busy slot) actually fires;
// - once request dispatch starts, an abort is conservatively classified as
//   submission-ambiguous until proven otherwise. Neither a missing response
//   header nor a missing submit marker proves that the account was untouched;
// - a run that settles normally must remove its abort listener (no leak, and
//   a later abort of the same signal must not touch the settled run).

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

describe("client: caller-gone abort via options.signal", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a pre-aborted signal fails fast without contacting the worker",
    async () => {
      const fake = await startFakeRunServer(() => {
        // Never invoked — a pre-aborted caller must not open a connection.
      });
      try {
        const controller = new AbortController();
        controller.abort();
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const failure = await executor({
          prompt: "x",
          config: {},
          signal: controller.signal,
        }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_before_submit",
        );
        expect((failure as RemoteRunFailedError).retryable).toBe(true);
        expect(fake.requestCount()).toBe(0);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "aborting mid-stream without a submit marker is ambiguous and tears down the connection",
    async () => {
      const fake = await startFakeRunServer((res, clientGone) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.on("error", () => {});
        // No submit-confirmation line yet: the worker is still staging.
        res.write(
          `${JSON.stringify({
            type: "log",
            runId: "fixture-run",
            message: "staging attachments",
          })}\n`,
        );
        // Deliberately never end: only the caller's abort can stop this run.
        void clientGone;
      });
      try {
        const controller = new AbortController();
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
          streamIdleTimeoutMs: 60_000,
        });
        const pending = executor({ prompt: "x", config: {}, signal: controller.signal }).then(
          () => null,
          (error: unknown) => error,
        );
        // Let the stream start before aborting.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const abortedAt = Date.now();
        controller.abort();
        const failure = await pending;
        const elapsedMs = Date.now() - abortedAt;
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toMatch(
          /aborted after request dispatch.*submission status is unknown/i,
        );
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_after_submit",
        );
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
        // Rejection must be prompt (the whole point: not waiting out the run).
        expect(elapsedMs).toBeLessThan(5000);
        expect(fake.recoveryClaimLookupCount()).toBe(0);
        expect(getRemoteBrowserPendingRecoveryClaimFromError(failure)).toMatchObject({
          claimKey: "A".repeat(43),
          originRunId: "fixture-run",
          accountId: "acct1",
          originLaneId: "acct1-9473",
        });
        // The outbound request must actually be destroyed so the worker's
        // client-gone handling (busy-slot release) can fire.
        await fake.waitForClientGone(5000);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "aborting after the submit-confirmation marker is classified post-submit and non-retryable",
    async () => {
      const fake = await startFakeRunServer((res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.on("error", () => {});
        // The same send-confirmation line the worker's own accounting keys
        // off (src/remote/server.ts): the Send boundary has been crossed.
        res.write(
          `${JSON.stringify({
            type: "log",
            runId: "fixture-run",
            message: "[browser] Submitted prompt via send button",
          })}\n`,
        );
        // Never end: generation is "in flight" until the caller aborts.
      });
      try {
        const controller = new AbortController();
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
          streamIdleTimeoutMs: 60_000,
        });
        const seenLogs: string[] = [];
        const pending = executor({
          prompt: "x",
          config: {},
          signal: controller.signal,
          log: (message) => {
            seenLogs.push(message);
          },
        }).then(
          () => null,
          (error: unknown) => error,
        );
        // Wait until the submit-confirmation line has been observed client-side.
        await waitFor(() => seenLogs.some((line) => /submitted prompt/i.test(line)), 5000);
        controller.abort();
        const failure = await pending;
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toMatch(/aborted after submit/i);
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_after_submit",
        );
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
        expect(fake.recoveryClaimLookupCount()).toBe(0);
        expect(getRemoteBrowserPendingRecoveryClaimFromError(failure)).toMatchObject({
          claimKey: "A".repeat(43),
          originRunId: "fixture-run",
          accountId: "acct1",
          originLaneId: "acct1-9473",
        });
        await fake.waitForClientGone(5000);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a run that completes normally is unaffected by a later abort of the same signal",
    async () => {
      const fake = await startFakeRunServer((res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.on("error", () => {});
        res.write(
          `${JSON.stringify({
            type: "done",
            runId: "fixture-run",
            ok: true,
            result: {
              answerText: "the answer",
              answerMarkdown: "the answer",
              tookMs: 5,
              answerTokens: 2,
              answerChars: 10,
              submissionProvenance: primarySubmissionProvenance("x"),
            },
            provenance: strongRemoteSuccessProvenance("x"),
          })}\n`,
        );
        res.end();
      });
      try {
        const controller = new AbortController();
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const result = await executor({ prompt: "x", config: {}, signal: controller.signal });
        expect(result.answerText).toBe("the answer");
        // The abort listener must have been removed at settle: firing the
        // signal now must be a no-op (nothing to reject, nothing to destroy).
        controller.abort();
      } finally {
        await fake.close();
      }
    },
  );
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor condition not met within deadline");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Fake /runs endpoint with manual control over response writes plus
 * observation hooks for "did the client ever connect" and "did the client's
 * TCP side go away" (the worker's onClientGone trigger).
 */
async function startFakeRunServer(
  respond: (res: http.ServerResponse, clientGone: Promise<void>) => void,
): Promise<{
  port: number;
  requestCount: () => number;
  recoveryClaimLookupCount: () => number;
  waitForClientGone: (timeoutMs: number) => Promise<void>;
  close: () => Promise<void>;
}> {
  let requests = 0;
  let recoveryClaimLookups = 0;
  let signalClientGone: (() => void) | null = null;
  const clientGone = new Promise<void>((resolve) => {
    signalClientGone = resolve;
  });
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/recovery-claims?")) {
      recoveryClaimLookups += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "explicit_abort_must_not_lookup" }));
      return;
    }
    if (serveCompatibleRecoveryHealth(req, res)) return;
    if (req.method === "POST" && req.url === REMOTE_BROWSER_RUN_PATH) {
      setCompatibleRecoveryResponseHeaders(res);
      requests += 1;
      res.once("close", () => {
        signalClientGone?.();
      });
      req.resume();
      req.on("end", () => {
        respond(res, clientGone);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake run server did not bind");
  }
  return {
    port: address.port,
    requestCount: () => requests,
    recoveryClaimLookupCount: () => recoveryClaimLookups,
    waitForClientGone: async (timeoutMs: number) => {
      await Promise.race([
        clientGone,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("client connection never closed")), timeoutMs),
        ),
      ]);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
