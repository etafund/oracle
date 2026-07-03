import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import { runBrowserMode } from "../../src/browser/index.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

// Caller-gone abort contract: a dropped caller must not pin a lane for the
// remainder of the run. On client disconnect the server aborts the run's
// AbortSignal; the browser layer stops at its next raced wait point and
// unwinds through its normal cleanup path; the worker returns to ready in
// bounded time and the run's sink line carries the submit-aware typed
// transport class (before-submit retryable, after-submit not).

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

const savedSinkDir = process.env.ORACLE_RUN_EVENTS_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (savedSinkDir === undefined) {
    delete process.env.ORACLE_RUN_EVENTS_DIR;
  } else {
    process.env.ORACLE_RUN_EVENTS_DIR = savedSinkDir;
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function isolatedSinkDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-abort-sink-"));
  tempDirs.push(dir);
  process.env.ORACLE_RUN_EVENTS_DIR = dir;
  return dir;
}

/**
 * Stub run that behaves like a raced browser wait: it settles only when the
 * caller-gone signal fires (rejecting the way an interrupted wait would) or
 * when the test releases it.
 */
function abortAwareRunStub(hooks: {
  onStart?: (options: { log?: (message: string) => void }) => void | Promise<void>;
}) {
  return async (options: {
    signal?: AbortSignal;
    log?: (message: string) => void;
  }): Promise<BrowserRunResult> => {
    await hooks.onStart?.(options);
    return await new Promise<BrowserRunResult>((_, reject) => {
      const signal = options.signal;
      if (!signal) {
        reject(new Error("test stub expected an abort signal to be provided"));
        return;
      }
      if (signal.aborted) {
        reject(new Error("wait interrupted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("wait interrupted")), {
        once: true,
      });
    });
  };
}

describe("client-disconnect abort", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "pre-submit disconnect frees the lane in bounded time with a retryable class",
    async () => {
      const sinkDir = await isolatedSinkDir();
      let sawSignal = false;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: abortAwareRunStub({
            onStart: (options) => {
              sawSignal = true;
              void options;
            },
          }),
        },
      );

      const run = startAbortableRun(server.port, "secret");
      void run.finished.catch(() => undefined);
      try {
        await waitUntil(async () => {
          const ready = await getReady(server.port, "secret");
          return ready.statusCode === 409;
        });
        run.abort();

        // Bounded recovery: the worker must return to idle-ready promptly.
        const recoveredAt = Date.now();
        await waitUntil(async () => {
          const ready = await getReady(server.port, "secret");
          return ready.statusCode === 200;
        }, 3_000);
        expect(Date.now() - recoveredAt).toBeLessThan(3_000);
        expect(sawSignal).toBe(true);

        const line = await readSingleSinkLine(sinkDir);
        expect(line.done_ok).toBe(false);
        expect(line.error_class).toBe("transport_interrupted_before_submit");
        expect(line.submitted_at).toBeNull();
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "post-submit disconnect is classified as a non-retryable after-submit interruption",
    async () => {
      const sinkDir = await isolatedSinkDir();
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: abortAwareRunStub({
            onStart: async (options) => {
              // Cross the Send boundary before the caller drops.
              options.log?.("Submitted prompt via Enter key");
              await new Promise((resolve) => setTimeout(resolve, 30));
            },
          }),
        },
      );

      const run = startAbortableRun(server.port, "secret");
      void run.finished.catch(() => undefined);
      try {
        await waitUntil(async () => {
          const ready = await getReady(server.port, "secret");
          return ready.statusCode === 409;
        });
        // Give the submit marker time to be recorded before dropping.
        await new Promise((resolve) => setTimeout(resolve, 100));
        run.abort();

        await waitUntil(async () => {
          const ready = await getReady(server.port, "secret");
          return ready.statusCode === 200;
        }, 3_000);

        const line = await readSingleSinkLine(sinkDir);
        expect(line.done_ok).toBe(false);
        expect(line.error_class).toBe("transport_interrupted_after_submit");
        expect(typeof line.submitted_at).toBe("string");
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "primary click-path submit ('Clicked send button') crosses the submit boundary: after-submit class, submitted_at stamped",
    async () => {
      const sinkDir = await isolatedSinkDir();
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: abortAwareRunStub({
            onStart: async (options) => {
              // The PRIMARY submission path clicks the send button; its log
              // line must stamp the submit boundary just like the Enter
              // fallback does, BEFORE commit-verify ever runs. A failure in
              // the click-to-commit-verify window must never be classified as
              // a retryable before-submit interruption (that classification
              // triggers an automatic resubmission of a prompt that may
              // already be generating in the account).
              options.log?.("Clicked send button");
              await new Promise((resolve) => setTimeout(resolve, 30));
            },
          }),
        },
      );

      const run = startAbortableRun(server.port, "secret");
      void run.finished.catch(() => undefined);
      try {
        await waitUntil(async () => {
          const ready = await getReady(server.port, "secret");
          return ready.statusCode === 409;
        });
        // Give the submit marker time to be recorded, then inject the
        // failure (caller drop) before any commit-verify confirmation.
        await new Promise((resolve) => setTimeout(resolve, 100));
        run.abort();

        await waitUntil(async () => {
          const ready = await getReady(server.port, "secret");
          return ready.statusCode === 200;
        }, 3_000);

        const line = await readSingleSinkLine(sinkDir);
        expect(line.done_ok).toBe(false);
        expect(line.error_class).toBe("transport_interrupted_after_submit");
        expect(typeof line.submitted_at).toBe("string");
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a caller already gone before the disconnect listener registers still aborts the run",
    async () => {
      const sinkDir = await isolatedSinkDir();
      let runStarted = false;
      let signalAbortedAtStart: boolean | null = null;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: abortAwareRunStub({
            onStart: (options: { signal?: AbortSignal; log?: (message: string) => void }) => {
              runStarted = true;
              signalAbortedAtStart = options.signal?.aborted ?? null;
            },
          }),
        },
      );

      // A sizeable attachment widens the admission staging window
      // (mkdtemp + decode + writeFile) between the body read and the
      // disconnect-listener registration. The client flushes the whole
      // request and immediately destroys its socket, so the server-side
      // "close" fires during staging — before the listener exists. The run
      // must still be aborted (via the post-registration socket-state probe),
      // not executed to completion against a dead caller.
      const attachmentBytes = Buffer.alloc(4 * 1024 * 1024, 7);
      const body = JSON.stringify({
        prompt: "pre-staging disconnect",
        attachments: [
          {
            fileName: "big.bin",
            contentBase64: attachmentBytes.toString("base64"),
            sizeBytes: attachmentBytes.length,
          },
        ],
        browserConfig: {},
        options: {},
      });
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: server.port,
            path: "/runs",
            method: "POST",
            headers: {
              authorization: "Bearer secret",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => res.resume(),
        );
        req.on("error", () => resolve());
        req.on("close", () => resolve());
        req.on("finish", () => {
          // Whole body handed to the OS; drop the connection right away.
          setImmediate(() => req.destroy());
        });
        req.write(body, (error) => (error ? reject(error) : undefined));
        req.end();
      });

      try {
        // Bounded recovery: the lane must free itself; an unnoticed
        // disconnect would pin it for the full run timeout.
        await waitUntil(async () => {
          const ready = await getReady(server.port, "secret");
          return ready.statusCode === 200;
        }, 5_000);
        // The run either never started or saw an already-aborted signal — it
        // must not have executed to completion.
        if (runStarted) {
          expect(signalAbortedAtStart).toBe(true);
        }
        const line = await readSingleSinkLine(sinkDir);
        expect(line.done_ok).toBe(false);
        expect(line.error_class).toBe("transport_interrupted_before_submit");
        expect(line.submitted_at).toBeNull();
      } finally {
        await server.close();
      }
    },
  );

  test("runBrowserMode fails fast (typed, retryable) when the caller is already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runBrowserMode({ prompt: "abort before any browser work", signal: controller.signal }),
    ).rejects.toMatchObject({
      details: {
        oracleErrorClass: "transport_interrupted_before_submit",
        retryable: true,
        stage: "client-abort",
      },
    });
  });
});

async function readSingleSinkLine(sinkDir: string): Promise<Record<string, unknown>> {
  const files = await waitForSinkFiles(sinkDir);
  const raw = await readFile(path.join(sinkDir, files[0]!), "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

async function waitForSinkFiles(dir: string, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const files = await readdir(dir).catch(() => [] as string[]);
    if (files.length > 0) {
      return files;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("sink directory stayed empty");
}

async function waitUntil(read: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await read()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not reached in time");
}

async function getReady(
  port: number,
  token: string,
): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/ready",
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = body.length ? (JSON.parse(body) as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function startAbortableRun(
  port: number,
  token: string,
): { abort(): void; finished: Promise<{ statusCode: number }> } {
  const body = JSON.stringify({
    prompt: "abort test",
    attachments: [],
    browserConfig: {},
    options: {},
  });
  let req: http.ClientRequest | undefined;
  const finished = new Promise<{ statusCode: number }>((resolve, reject) => {
    req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        const settle = () => resolve({ statusCode: res.statusCode ?? 0 });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return {
    abort() {
      req?.destroy();
    },
    finished,
  };
}
