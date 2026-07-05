import { describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRemoteBrowserExecutor, RemoteRunFailedError } from "../../src/remote/client.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

// Stream-inactivity deadline + NDJSON line-buffer cap contract (bead
// oracle-router-xfd): the `/runs` response is a long-lived NDJSON stream
// with no total-duration cap (a legitimate Pro run can take many minutes),
// but the caller must never hang forever on a worker that opens the
// connection and then goes silent, and must never grow its line-accumulation
// buffer without bound when a stream never emits a newline.
//
// - an idle-but-open stream (headers sent, then nothing, ever) must abort
//   with a typed, non-retryable error once `streamIdleTimeoutMs` elapses;
// - a stream that never sends a newline must be rejected once the buffered
//   partial line exceeds `maxLineBytes`, instead of growing without bound;
// - a normal slow stream that keeps emitting data more often than the idle
//   deadline must NOT be aborted, even though its total duration exceeds
//   the deadline — the deadline is on inactivity, not total duration.

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

const MINIMAL_RESULT: BrowserRunResult = {
  answerText: "the answer",
  answerMarkdown: "the answer",
  tookMs: 5,
  answerTokens: 2,
  answerChars: 10,
};

describe("client: stream-inactivity deadline and line-buffer cap", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "an idle-but-open stream aborts after the configured deadline",
    async () => {
      const fake = await startFakeRunServer((res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // Force the headers onto the wire with no body: without this, Node
        // buffers writeHead() until the first write()/end(), and the client
        // would never even observe the response, defeating the scenario.
        res.flushHeaders();
        // Deliberately never write anything else, and never end: simulates a
        // silently-wedged worker that accepted the connection but is stuck.
        res.on("error", () => {});
      });
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
          streamIdleTimeoutMs: 60,
        });
        const startedAt = Date.now();
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        const elapsedMs = Date.now() - startedAt;
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toMatch(/no data.*over 60ms/i);
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_after_submit",
        );
        // Trips close to the configured deadline; must not hang indefinitely.
        expect(elapsedMs).toBeGreaterThanOrEqual(30);
        expect(elapsedMs).toBeLessThan(5000);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "an oversized no-newline stream is rejected instead of buffering without bound",
    async () => {
      const fake = await startFakeRunServer((res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.on("error", () => {});
        // Stream well past the (small, test-configured) line cap without
        // ever sending a newline byte.
        const chunk = "a".repeat(1024);
        let sentBytes = 0;
        const interval = setInterval(() => {
          if (sentBytes > 16 * 1024 || res.writableEnded || res.destroyed) {
            clearInterval(interval);
            return;
          }
          res.write(chunk);
          sentBytes += chunk.length;
        }, 1);
      });
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
          maxLineBytes: 4096,
          streamIdleTimeoutMs: 5000,
        });
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toContain(
          "4096-byte NDJSON line cap",
        );
        expect((failure as RemoteRunFailedError).message).toContain("without a");
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a normal slow stream with periodic data is NOT aborted, even past the idle deadline in total duration",
    async () => {
      const fake = await startFakeRunServer((res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.on("error", () => {});
        let ticks = 0;
        const interval = setInterval(() => {
          ticks += 1;
          res.write(`${JSON.stringify({ type: "log", message: `tick ${ticks}` })}\n`);
          if (ticks >= 6) {
            clearInterval(interval);
            res.write(`${JSON.stringify({ type: "done", ok: true, result: MINIMAL_RESULT })}\n`);
            res.end();
          }
        }, 40);
      });
      try {
        // Total run time (~240ms) exceeds this deadline, but each gap
        // between writes (~40ms) is comfortably inside it — the deadline
        // must key off inactivity, not total duration.
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
          streamIdleTimeoutMs: 150,
        });
        const result = await executor({ prompt: "x", config: {} });
        expect(result.answerText).toBe("the answer");
      } finally {
        await fake.close();
      }
    },
  );
});

/** Fake /runs endpoint with full manual control over response timing/writes. */
async function startFakeRunServer(
  respond: (res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      req.resume();
      req.on("end", () => {
        respond(res);
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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
