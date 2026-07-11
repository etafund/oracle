import { describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRemoteBrowserExecutor, RemoteRunFailedError } from "../../src/remote/client.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import type { RemoteArtifactDescriptor } from "../../src/remote/types.js";
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
        expect((failure as RemoteRunFailedError).message).toContain("4096-byte NDJSON line cap");
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

// Two additional hang paths (bugs-remote#0 / #1) that the /runs stream idle
// watchdog does NOT cover, because it is armed only between the 200 response
// and stream end:
//   1. a bridge ARTIFACT download that sends 200 headers and then stalls — the
//      /runs stream has already ended and cleared its idle timer, so without a
//      download-level timeout the terminal `await Promise.allSettled(...)`
//      waits forever;
//   2. a worker that accepts the /runs TCP connection but never sends response
//      headers — the per-chunk idle watchdog never arms, so the pre-header
//      window is unbounded.
// Both must convert to a typed, bounded failure instead of hanging.
describe("client: artifact-transfer and pre-header hang guards", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a stalled artifact download fails the run with a typed post-submit timeout, not a hang",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "oracle-artifact-stall-"));
      setOracleHomeDirOverrideForTest(home);
      const descriptor: RemoteArtifactDescriptor = {
        artifactId: "art1",
        runId: "run1",
        kind: "file",
        filename: "result.bin",
        byteSize: 16,
        sha256: "a".repeat(64),
        sourceUrlKind: "sandbox",
        transferStatus: "ready",
      };
      const fake = await startStallingArtifactServer(descriptor);
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
          streamIdleTimeoutMs: 80,
        });
        const startedAt = Date.now();
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        const elapsedMs = Date.now() - startedAt;
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toMatch(/stalled|no data/i);
        // A stalled transfer arrives AFTER the answer was submitted, so it is a
        // non-retryable post-submit interruption (never blind-resubmitted).
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_after_submit",
        );
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
        // Bounded by the download inactivity timeout; must not hang.
        expect(elapsedMs).toBeLessThan(5000);
      } finally {
        await fake.close();
        setOracleHomeDirOverrideForTest(null);
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a connection accepted but never given response headers aborts before submit",
    async () => {
      const fake = await startFakeRunServer(() => {
        // Accept the /runs connection but never call res.writeHead: no response
        // headers ever arrive, so the per-chunk idle watchdog never arms. The
        // pre-header request-level timeout must fire instead of hanging.
      });
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
          streamIdleTimeoutMs: 80,
        });
        const startedAt = Date.now();
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        const elapsedMs = Date.now() - startedAt;
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toMatch(/no response headers/i);
        // Nothing reached the account yet (no headers, no submit), so this is a
        // retryable pre-submit transport failure.
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_before_submit",
        );
        expect((failure as RemoteRunFailedError).retryable).toBe(true);
        expect(elapsedMs).toBeGreaterThanOrEqual(30);
        expect(elapsedMs).toBeLessThan(5000);
      } finally {
        await fake.close();
      }
    },
  );

  // Progress-aware overall-transfer deadline (P1-1): the post-stream deadline
  // that guards a never-settling transfer promise must key off BYTE PROGRESS,
  // not a fixed wall-clock multiple of the idle timeout. A healthy, actively-
  // streaming large artifact whose total transfer time legitimately exceeds any
  // fixed cap (here ~6 chunks * 40ms = ~240ms, well past the old
  // streamIdleTimeoutMs*(n+1) = 120ms cap) must SURVIVE and deliver its bytes,
  // because each inter-chunk gap (~40ms) is comfortably inside the idle window
  // (60ms) and resets the deadline. Only a genuinely stalled transfer (covered
  // by the test above) still fails.
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a slow-but-progressing artifact download survives past the old fixed deadline",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "oracle-artifact-slow-"));
      setOracleHomeDirOverrideForTest(home);
      // 24 bytes streamed as 6 * 4-byte chunks; sha256/byteSize must match so
      // the transfer validates and completes (a failed validation would mask
      // the deadline behavior under test).
      const content = Buffer.from("abcdefghijklmnopqrstuvwx", "utf8");
      const descriptor: RemoteArtifactDescriptor = {
        artifactId: "art-slow",
        runId: "run-slow",
        kind: "file",
        filename: "result.bin",
        byteSize: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        sourceUrlKind: "sandbox",
        transferStatus: "ready",
      };
      const fake = await startSlowProgressingArtifactServer({
        descriptor,
        content,
        chunkCount: 6,
        gapMs: 40,
      });
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
          // Old cap would have been 60 * (1 + 1) = 120ms; the transfer takes
          // ~240ms of ACTIVE streaming, so a fixed cap would wrongly abort it.
          streamIdleTimeoutMs: 60,
        });
        const startedAt = Date.now();
        const result = await executor({ prompt: "x", config: {}, sessionId: descriptor.runId });
        const elapsedMs = Date.now() - startedAt;
        // The run completed with its answer, and the slow artifact was
        // transferred (not aborted by the outer deadline).
        expect(result.answerText).toBe("the answer");
        expect(result.savedFiles?.some((f) => f.sourceUrl === "bridge-artifact")).toBe(true);
        // No transfer-failure warning was recorded.
        expect(
          (result.warnings ?? []).some((w) => w.code === "remote-artifact-transfer-failed"),
        ).toBe(false);
        // It genuinely outlived the old fixed cap (120ms) — proving the deadline
        // is now progress-aware, not a fixed wall-clock race.
        expect(elapsedMs).toBeGreaterThan(120);
        expect(elapsedMs).toBeLessThan(5000);
      } finally {
        await fake.close();
        setOracleHomeDirOverrideForTest(null);
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

/**
 * Fake bridge that streams a valid `artifact-ready` + terminal `done`, then
 * serves the artifact GET with 200 headers followed by an indefinite stall
 * (no body bytes, never ends) — the wedged half-open transfer of bugs-remote#0.
 */
async function startStallingArtifactServer(
  descriptor: RemoteArtifactDescriptor,
): Promise<{ port: number; close: () => Promise<void> }> {
  const artifactPath = `/runs/${encodeURIComponent(descriptor.runId)}/artifacts/${encodeURIComponent(
    descriptor.artifactId,
  )}`;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          `${JSON.stringify({ type: "log", message: "Submitted prompt via Enter key" })}\n`,
        );
        res.write(
          `${JSON.stringify({ type: "artifact-ready", runId: descriptor.runId, artifact: descriptor })}\n`,
        );
        res.end(`${JSON.stringify({ type: "done", ok: true, result: MINIMAL_RESULT })}\n`);
      });
      return;
    }
    if (req.method === "GET" && req.url === artifactPath) {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(descriptor.byteSize),
        "X-Oracle-Artifact-Sha256": descriptor.sha256,
      });
      // Deliberately write nothing and never end: a half-open connection that
      // sent headers and then went silent mid-transfer.
      res.on("error", () => {});
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
    throw new Error("stalling artifact server did not bind");
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

/**
 * Fake bridge that streams a valid `artifact-ready` + terminal `done`, then
 * serves the artifact GET as a SLOW BUT STEADY transfer: `chunkCount` chunks of
 * the content, each separated by `gapMs`, so the transfer is always making byte
 * progress but its total duration exceeds the old fixed overall-transfer cap.
 * Exercises the progress-aware deadline (P1-1): a healthy slow transfer must
 * complete, not be aborted.
 */
async function startSlowProgressingArtifactServer(params: {
  descriptor: RemoteArtifactDescriptor;
  content: Buffer;
  chunkCount: number;
  gapMs: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const { descriptor, content, chunkCount, gapMs } = params;
  const artifactPath = `/runs/${encodeURIComponent(descriptor.runId)}/artifacts/${encodeURIComponent(
    descriptor.artifactId,
  )}`;
  const chunkSize = Math.ceil(content.length / chunkCount);
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(
          `${JSON.stringify({ type: "log", message: "Submitted prompt via Enter key" })}\n`,
        );
        res.write(
          `${JSON.stringify({ type: "artifact-ready", runId: descriptor.runId, artifact: descriptor })}\n`,
        );
        res.end(`${JSON.stringify({ type: "done", ok: true, result: MINIMAL_RESULT })}\n`);
      });
      return;
    }
    if (req.method === "GET" && req.url === artifactPath) {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(descriptor.byteSize),
        "X-Oracle-Artifact-Sha256": descriptor.sha256,
      });
      res.on("error", () => {});
      let offset = 0;
      const interval = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(interval);
          return;
        }
        const next = content.subarray(offset, offset + chunkSize);
        offset += next.length;
        res.write(next);
        if (offset >= content.length) {
          clearInterval(interval);
          res.end();
        }
      }, gapMs);
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
    throw new Error("slow progressing artifact server did not bind");
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
