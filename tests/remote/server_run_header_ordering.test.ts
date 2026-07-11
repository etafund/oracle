import { describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRemoteServer } from "../../src/remote/server.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

// P1-3 (duplicate-paid-run guard) — PINNED SERVER ORDERING.
//
// The client arms a RETRYABLE, pre-submit request-level timeout that fires if
// the worker sends no response headers within `streamIdleTimeoutMs`
// (src/remote/client.ts). That is only safe if the worker writes the /runs 200
// response headers SYNCHRONOUSLY with run acceptance — src/remote/server.ts
// writeHead(200) + flushHeaders() at ~L1087-1090, immediately after the
// single-flight `busy` flip — and BEFORE any long pre-work inside runBrowser
// (profile-lock waits, model selection, the ChatGPT submit at ~L1250). If
// headers were deferred behind that pre-work, a slow-but-accepted run could be
// aborted "retryable before-submit" on the client while the worker keeps
// executing it (the worker abandons only on client disconnect), retried onto
// another lane, and SUBMITTED TWICE — a duplicate paid run.
//
// This test blocks runBrowser indefinitely (a stand-in for that pre-work +
// submit) and asserts the client still receives 200 + X-Oracle-Run-Id headers
// while runBrowser has NOT completed. If the implementation regressed to write
// headers after runBrowser returned, the client would never receive headers and
// this test would hang (and fail on the runner timeout).

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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const MINIMAL_RESULT: BrowserRunResult = {
  answerText: "ok",
  answerMarkdown: "ok",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 2,
};

describe("server: /runs header ordering (duplicate-run guard)", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "writes 200 + run-id headers before runBrowser pre-work / submit completes",
    async () => {
      const entered = defer<void>();
      const gate = defer<void>();
      let runBrowserSettled = false;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async () => {
            // Stand-in for the worker's long pre-work + submit: block here. A
            // correct worker has ALREADY flushed the 200 headers before reaching
            // this point, so the client below observes them while we are stuck.
            entered.resolve();
            await gate.promise;
            runBrowserSettled = true;
            return MINIMAL_RESULT;
          },
        },
      );

      const body = JSON.stringify({
        prompt: "hi",
        attachments: [],
        browserConfig: {},
        options: {},
      });
      const headers = defer<{ status: number | undefined; runId: string | undefined }>();
      const done = defer<string>();
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/runs",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            // Ensure the socket closes after the stream ends so server.close()
            // resolves without waiting on a keep-alive connection.
            Connection: "close",
            authorization: "Bearer secret",
          },
        },
        (res) => {
          const runIdHeader = res.headers["x-oracle-run-id"];
          headers.resolve({
            status: res.statusCode,
            runId: Array.isArray(runIdHeader) ? runIdHeader[0] : runIdHeader,
          });
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            raw += chunk;
          });
          res.on("end", () => done.resolve(raw));
          res.on("error", () => {});
        },
      );
      req.on("error", () => {});
      req.end(body);

      try {
        const received = await headers.promise;
        // The worker accepted the run and flushed headers...
        expect(received.status).toBe(200);
        expect(typeof received.runId === "string" && received.runId.length > 0).toBe(true);
        // ...while the long pre-work / submit stand-in is still blocked, i.e.
        // headers necessarily PRECEDE submit. A pre-header client timeout can
        // therefore never abort a run the worker has begun submitting.
        expect(runBrowserSettled).toBe(false);
        // The run genuinely reached the pre-work stage (this was an acceptance,
        // not a refusal), and headers were already in hand before it could
        // finish.
        await entered.promise;
        expect(runBrowserSettled).toBe(false);
        // Release the pre-work; the SAME accepted run streams its terminal done
        // event (stamped with the same run id), confirming end-to-end continuity.
        gate.resolve();
        const raw = await done.promise;
        expect(raw).toContain('"type":"done"');
        expect(raw).toContain(received.runId as string);
        expect(runBrowserSettled).toBe(true);
      } finally {
        req.destroy();
        await server.close();
      }
    },
  );
});
