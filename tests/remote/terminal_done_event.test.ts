import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRemoteServer, parseCaptureBindingVerifiedQuality } from "../../src/remote/server.js";
import {
  buildCaptureBindingFailureError,
  formatCaptureBindingVerifiedLog,
} from "../../src/browser/actions/captureBinding.js";
import { createRemoteBrowserExecutor, RemoteRunFailedError } from "../../src/remote/client.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

// Terminal done-event contract:
// - the server emits exactly one terminal `done` event per accepted run and
//   the caller-usable answer travels ONLY in done.ok === true;
// - intermediate `result`-style events are non-authoritative and ignored;
// - the client refuses to treat a stream without a terminal done event as
//   success (EOF-without-done = failure; error event = failure; truncated
//   stream = failure) and surfaces typed retry classes so automation never
//   auto-retries post-submit, integrity, or quarantine failures.

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
  modelSelection: {
    requestedModel: "GPT-5.6 Sol",
    resolvedLabel: "GPT-5.6 Sol + Pro",
    requestedModelLabel: "GPT-5.6 Sol",
    resolvedModelLabel: "GPT-5.6 Sol",
    modelVerified: true,
    requestedMode: "Pro",
    resolvedModeLabel: "Pro",
    modeVerified: true,
    verifiedBeforePromptSubmit: true,
    strategy: "select",
    status: "already-selected",
    verified: true,
    source: "chatgpt-model-picker",
    capturedAt: "2026-07-03T00:00:00.000Z",
  },
};

const savedFleetDir = process.env.ORACLE_FLEET_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (savedFleetDir === undefined) {
    delete process.env.ORACLE_FLEET_DIR;
  } else {
    process.env.ORACLE_FLEET_DIR = savedFleetDir;
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function isolatedFleetDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-done-fleet-"));
  tempDirs.push(dir);
  process.env.ORACLE_FLEET_DIR = dir;
  return dir;
}

describe("server: terminal done event", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "success: answer travels only in done.ok with provenance; no result event",
    async () => {
      await isolatedFleetDir();
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async (options) => {
            options.log?.("Submitted prompt via Enter key");
            options.submittedPromptPreviewCb?.("test");
            options.log?.(formatCaptureBindingVerifiedLog("message-handle", "abc123"));
            return MINIMAL_RESULT;
          },
        },
      );
      try {
        const response = await rawRun(server.port, "secret");
        expect(response.statusCode).toBe(200);
        const events = response.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);

        // No non-authoritative result events are emitted anymore.
        expect(events.some((event) => event.type === "result")).toBe(false);
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        expect(done.ok).toBe(true);
        expect(done.errorClass).toBeNull();
        expect((done.result as Record<string, unknown>).answerText).toBe("the answer");
        expect(done.provenance).toEqual({
          modelVerified: true,
          modelRequested: "GPT-5.6 Sol",
          modelResolved: "GPT-5.6 Sol + Pro",
          requestedModelLabel: "GPT-5.6 Sol",
          resolvedModelLabel: "GPT-5.6 Sol",
          modelLabelVerified: true,
          requestedMode: "Pro",
          resolvedModeLabel: "Pro",
          modeVerified: true,
          verifiedBeforePromptSubmit: true,
          captureBindingVerified: true,
          captureBindingQuality: "message-handle",
          challengeClean: true,
        });
      } finally {
        await server.close();
      }
    },
  );

  // Regression (oracle-router-8em): a conversation-only degraded binding pass
  // must not be reported as full structural verification — the provenance
  // carries the tier so captureBindingVerified:true is never vacuous.
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "degraded conversation-only binding is distinguishable in provenance",
    async () => {
      await isolatedFleetDir();
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async (options) => {
            options.log?.("Submitted prompt via Enter key");
            options.log?.(formatCaptureBindingVerifiedLog("conversation-only", "abc123"));
            return MINIMAL_RESULT;
          },
        },
      );
      try {
        const response = await rawRun(server.port, "secret");
        expect(response.statusCode).toBe(200);
        const events = response.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        expect(done.ok).toBe(true);
        const provenance = done.provenance as Record<string, unknown>;
        expect(provenance.captureBindingVerified).toBe(true);
        expect(provenance.captureBindingQuality).toBe("conversation-only");
      } finally {
        await server.close();
      }
    },
  );

  // Regression: a multi-turn run whose FIRST turn's capture binding verified
  // but whose LATER follow-up turn failed structural binding validation must
  // not report a stale captureBindingVerified:true on the failed terminal
  // done event. The failure travels as the typed capture-binding error (its
  // message contains no "capture binding" substring, so log-text sniffing
  // can never see it); the server must read the verdict from the error's
  // own details.stage === "capture-binding".
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a later turn's binding failure overrides an earlier turn's verified marker",
    async () => {
      await isolatedFleetDir();
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async (options) => {
            // Turn 1: submit confirmed and capture binding verified at full
            // structural strength.
            options.log?.("Submitted prompt via Enter key");
            await options.submittedPromptPreviewCb?.("test");
            options.log?.(formatCaptureBindingVerifiedLog("message-handle", "abc123"));
            await options.runtimeHintCb?.({
              tabUrl: "https://chatgpt.com/c/recoverable-123?private=1",
              conversationId: "recoverable-123",
              promptSubmitted: true,
              chromePid: 1234,
              chromePort: 9222,
              userDataDir: "/home/oracle/private-profile",
            });
            // Follow-up turn: the capture binding fails structurally — thrown
            // exactly as assertCapturedAssistantResponseBound throws it.
            throw buildCaptureBindingFailureError(
              {
                ok: false,
                code: "capture-binding-message-mismatch",
                detail: "captured assistant message is not bound to this run's user message",
                warnings: [],
              },
              { quality: "message-handle", promptSha256: "abc123" },
            );
          },
        },
      );
      try {
        const response = await rawRun(server.port, "secret");
        const done = lastEvent(response.body);
        expect(done.type).toBe("done");
        expect(done.ok).toBe(false);
        expect(done.errorClass).toBe("integrity_binding_failed");
        expect(done.retryable).toBe(false);
        expect(done.recovery).toMatchObject({
          category: "browser-automation",
          stage: "capture-binding",
          originRunId: expect.any(String),
          expiresAt: expect.any(String),
          capability: expect.stringMatching(/^v1\./),
          promptPreviewSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          runtime: {
            tabUrl: "https://chatgpt.com/c/recoverable-123",
            conversationId: "recoverable-123",
            promptSubmitted: true,
          },
        });
        expect(JSON.stringify(done.recovery)).not.toContain("9222");
        expect(JSON.stringify(done.recovery)).not.toContain("private-profile");
        const provenance = done.provenance as Record<string, unknown>;
        expect(provenance.captureBindingVerified).toBe(false);
        expect(provenance.captureBindingQuality).toBeNull();
      } finally {
        await server.close();
      }
    },
  );

  describe("parseCaptureBindingVerifiedQuality", () => {
    // Coupled to the REAL log format: the parser must understand exactly what
    // formatCaptureBindingVerifiedLog emits, for every quality tier.
    test("extracts each tier from the actual verified log line", () => {
      for (const quality of ["message-handle", "guessed", "conversation-only"] as const) {
        expect(
          parseCaptureBindingVerifiedQuality(formatCaptureBindingVerifiedLog(quality, "deadbeef")),
        ).toBe(quality);
      }
    });

    test("returns null for legacy lines without a recognizable tier", () => {
      expect(
        parseCaptureBindingVerifiedQuality(
          "[browser] Structural capture binding verified (strict)",
        ),
      ).toBeNull();
      expect(parseCaptureBindingVerifiedQuality("capture binding verified")).toBeNull();
    });
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "failure: done.ok=false carries the declared typed class and retry verdict",
    async () => {
      await isolatedFleetDir();
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async () => {
            throw new BrowserAutomationError("Account is quarantined; refusing to run.", {
              oracleErrorClass: "account_quarantine",
              retryable: false,
            });
          },
        },
      );
      try {
        const response = await rawRun(server.port, "secret");
        const events = response.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        expect(done.ok).toBe(false);
        expect(done.errorClass).toBe("account_quarantine");
        expect(done.retryable).toBe(false);
        expect(done.result).toBeUndefined();
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "failure: a worker-local filesystem path in the error is scrubbed from the done event",
    async () => {
      await isolatedFleetDir();
      const localPath = "/Users/worker-runner/oracle/tmp/session-9f21/profile/Default";
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async () => {
            throw new BrowserAutomationError(
              `Failed to launch Chrome profile at ${localPath}: lock held`,
              { oracleErrorClass: "capacity_busy", retryable: true },
            );
          },
        },
      );
      try {
        const response = await rawRun(server.port, "secret");
        const done = lastEvent(response.body);
        expect(done.type).toBe("done");
        expect(done.ok).toBe(false);
        const errorMessage = String(done.errorMessage);
        expect(errorMessage).not.toContain(localPath);
        expect(errorMessage).not.toContain("worker-runner");
        // Actionable detail (error class/reason) survives the scrub.
        expect(errorMessage).toContain("Failed to launch Chrome profile");
        expect(errorMessage).toContain("lock held");
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "failure without a declared class falls back to submit-aware transport classes",
    async () => {
      await isolatedFleetDir();
      let call = 0;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async (options) => {
            call += 1;
            if (call === 2) {
              options.log?.("Submitted prompt via Enter key");
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error("socket hang up");
          },
        },
      );
      try {
        const before = await rawRun(server.port, "secret");
        const beforeDone = lastEvent(before.body);
        expect(beforeDone.errorClass).toBe("transport_interrupted_before_submit");
        expect(beforeDone.retryable).toBe(true);

        const after = await rawRun(server.port, "secret");
        const afterDone = lastEvent(after.body);
        expect(afterDone.errorClass).toBe("transport_interrupted_after_submit");
        expect(afterDone.retryable).toBe(false);
      } finally {
        await server.close();
      }
    },
  );
});

describe("client: terminal done enforcement", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)("resolves only on done.ok", async () => {
    const fake = await startFakeRunServer([
      { type: "log", message: "working" },
      {
        type: "done",
        ok: true,
        runId: "run-sol-pro-1",
        result: MINIMAL_RESULT,
        provenance: {
          modelVerified: true,
          modelRequested: "GPT-5.6 Sol",
          modelResolved: "GPT-5.6 Sol + Pro",
          requestedModelLabel: "GPT-5.6 Sol",
          resolvedModelLabel: "GPT-5.6 Sol",
          modelLabelVerified: true,
          requestedMode: "Pro",
          resolvedModeLabel: "Pro",
          modeVerified: true,
          verifiedBeforePromptSubmit: true,
          captureBindingVerified: true,
          captureBindingQuality: "message-handle",
          challengeClean: true,
        },
      },
    ]);
    try {
      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${fake.port}`,
        token: "secret",
      });
      const result = await executor({ prompt: "x", config: {} });
      expect(result.answerText).toBe("the answer");
      expect(result.remoteRun).toMatchObject({
        runId: "run-sol-pro-1",
        terminalDoneOk: true,
        provenance: {
          modelVerified: true,
          modelLabelVerified: true,
          modeVerified: true,
          captureBindingQuality: "message-handle",
        },
      });
    } finally {
      await fake.close();
    }
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "EOF without done fails, even when a legacy result event was streamed",
    async () => {
      const fake = await startFakeRunServer([
        { type: "log", message: "working" },
        { type: "result", result: MINIMAL_RESULT },
      ]);
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toContain(
          "without a terminal done event",
        );
        expect((failure as RemoteRunFailedError).errorClass).toBe(
          "transport_interrupted_after_submit",
        );
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)("an error event fails the run", async () => {
    const fake = await startFakeRunServer([{ type: "error", message: "boom" }]);
    try {
      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${fake.port}`,
        token: "secret",
      });
      await expect(executor({ prompt: "x", config: {} })).rejects.toThrow("boom");
    } finally {
      await fake.close();
    }
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a stream truncated mid-answer fails instead of resolving",
    async () => {
      const fake = await startFakeRunServer([], {
        rawTail: '{"type":"done","ok":true,"result":{"answerText":"trunca',
      });
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
      } finally {
        await fake.close();
      }
    },
  );

  // Regression: NDJSON permits the final line to omit the trailing newline.
  // A COMPLETE terminal done event buffered at EOF must resolve the run, not
  // be dropped and misreported as "stream ended without a terminal done
  // event". (A genuinely truncated tail must still fail — covered above.)
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a complete done event without a trailing newline still resolves",
    async () => {
      const fake = await startFakeRunServer([{ type: "log", message: "working" }], {
        rawTail: JSON.stringify({ type: "done", ok: true, result: MINIMAL_RESULT }),
      });
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const result = await executor({ prompt: "x", config: {} });
        expect(result.answerText).toBe("the answer");
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a complete done.ok=false event without a trailing newline surfaces the typed failure",
    async () => {
      const fake = await startFakeRunServer([], {
        rawTail: JSON.stringify({
          type: "done",
          ok: false,
          errorClass: "account_quarantine",
          errorMessage: "quarantined",
          retryable: false,
        }),
      });
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).errorClass).toBe("account_quarantine");
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "done.ok=false surfaces the typed class to the caller",
    async () => {
      const fake = await startFakeRunServer([
        {
          type: "done",
          ok: false,
          errorClass: "integrity_binding_failed",
          errorMessage: "capture binding lost",
          retryable: false,
        },
      ]);
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).errorClass).toBe("integrity_binding_failed");
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
        expect((failure as RemoteRunFailedError).message).toBe("capture binding lost");
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a recoverable remote failure preserves only logical conversation metadata",
    async () => {
      const fake = await startFakeRunServer(
        [
          {
            type: "done",
            ok: false,
            runId: "run-recovery-1",
            errorClass: "transport_interrupted_after_submit",
            errorMessage: "Assistant response timed out before completion.",
            retryable: false,
            recovery: {
              category: "browser-automation",
              stage: "assistant-timeout",
              originRunId: "run-recovery-1",
              expiresAt: "2099-01-01T00:00:00.000Z",
              capability: `v1.${"a".repeat(43)}`,
              promptPreviewSha256:
                "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
              runtime: {
                tabUrl: "https://chatgpt.com/c/recoverable-123",
                conversationId: "recoverable-123",
                promptSubmitted: true,
                chromePort: 9222,
              },
            },
          },
        ],
        {
          headers: {
            "x-oracle-run-id": "run-recovery-1",
            "x-oracle-account-id": "acct2",
            "x-oracle-lane-id": "acct2-9473",
          },
        },
      );
      try {
        const executor = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const failure = await executor({ prompt: "x", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(BrowserAutomationError);
        expect(failure).not.toBeInstanceOf(RemoteRunFailedError);
        expect((failure as { errorClass?: string }).errorClass).toBe(
          "transport_interrupted_after_submit",
        );
        expect((failure as { retryable?: boolean }).retryable).toBe(false);
        expect((failure as BrowserAutomationError).details).toEqual({
          stage: "assistant-timeout",
          runtime: {
            tabUrl: "https://chatgpt.com/c/recoverable-123",
            conversationId: "recoverable-123",
            promptSubmitted: true,
          },
          errorClass: "transport_interrupted_after_submit",
          retryable: false,
          remoteRun: {
            runId: "run-recovery-1",
            accountId: "acct2",
            laneId: "acct2-9473",
            terminalDoneOk: false,
            provenance: null,
          },
        });
        expect(JSON.stringify((failure as BrowserAutomationError).details)).not.toContain("9222");
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "busy refusals surface capacity_busy with a retry verdict",
    async () => {
      await isolatedFleetDir();
      let release: ((result: BrowserRunResult) => void) | undefined;
      let started: () => void = () => {};
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const finished = new Promise<BrowserRunResult>((resolve) => {
        release = resolve;
      });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async () => {
            started();
            return await finished;
          },
        },
      );
      const executor = createRemoteBrowserExecutor({
        host: `127.0.0.1:${server.port}`,
        token: "secret",
      });
      const active = executor({ prompt: "hold", config: {} });
      try {
        await startedPromise;
        const refusal = await executor({ prompt: "second", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(RemoteRunFailedError);
        expect((refusal as RemoteRunFailedError).errorClass).toBe("capacity_busy");
        expect((refusal as RemoteRunFailedError).retryable).toBe(true);
      } finally {
        release?.(MINIMAL_RESULT);
        await active.catch(() => undefined);
        await server.close();
      }
    },
  );
});

function lastEvent(body: string): Record<string, unknown> {
  const events = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return events[events.length - 1]!;
}

async function rawRun(port: number, token: string): Promise<{ statusCode: number; body: string }> {
  const payload = JSON.stringify({
    prompt: "terminal done test",
    attachments: [],
    browserConfig: {},
    options: {},
  });
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        const settle = () => resolve({ statusCode: res.statusCode ?? 0, body });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Fake /runs endpoint that streams the given events and ends. */
async function startFakeRunServer(
  events: Array<Record<string, unknown>>,
  options: { rawTail?: string; headers?: Record<string, string> } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/runs") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          ...options.headers,
        });
        for (const event of events) {
          res.write(`${JSON.stringify(event)}\n`);
        }
        if (options.rawTail) {
          res.write(options.rawTail);
        }
        res.end();
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
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
