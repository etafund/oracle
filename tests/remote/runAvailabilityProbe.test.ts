import { describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { checkRemoteRunAvailability } from "../../src/remote/health.js";

// checkRemoteRunAvailability is the /runs pre-dispatch availability probe: it
// POSTs a deliberately malformed body ("{") and maps the worker's HTTP status
// to an availability verdict. Its mapping is tightly coupled to /runs
// admission behavior — which recently gained 422 model-gate refusals — yet had
// no test and no in-repo caller (test-gaps#2). This pins each status -> verdict
// so a paid-run preflight cannot silently misclassify a busy/upgraded host.
//
//   400 (malformed body parse error)      -> available   { ok: true }
//   409 (busy)                            -> busy, preserving state + activeRun
//   404 (no /runs route)                  -> typed "upgrade" error
//   401 / 403 (auth)                      -> typed unauthorized error
//   422 (new model-gate refusal) + other  -> unavailable, error surfaced
//   stalled connection                    -> timeout error (no hang)
//   invalid host:port                     -> typed error, never throws

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

describe("checkRemoteRunAvailability: /runs probe status mapping", () => {
  test("maps an invalid host:port to a typed error instead of throwing", async () => {
    await expect(
      checkRemoteRunAvailability({ host: "127.0.0.1:not-a-port", token: "secret" }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid port/i),
    });
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "maps 400 (server parsed the malformed probe body) to available",
    async () => {
      await withStubServer(jsonResponder(400, { error: "invalid JSON body" }), async (port) => {
        await expect(
          checkRemoteRunAvailability({ host: `127.0.0.1:${port}`, token: "secret" }),
        ).resolves.toEqual({ ok: true, statusCode: 400 });
      });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "maps 409 to busy and preserves readiness state + activeRun metadata",
    async () => {
      const activeRun = {
        id: "run-1",
        startedAt: "2026-07-03T00:00:00.000Z",
        ageSeconds: 12,
        clientConnected: true,
        promptChars: 42,
        phase: "running",
      };
      await withStubServer(
        jsonResponder(409, {
          error: "remote host is busy",
          state: "active-run-client-connected",
          activeRun,
        }),
        async (port) => {
          await expect(
            checkRemoteRunAvailability({ host: `127.0.0.1:${port}`, token: "secret" }),
          ).resolves.toMatchObject({
            ok: false,
            statusCode: 409,
            busy: true,
            state: "active-run-client-connected",
            activeRun: {
              id: "run-1",
              clientConnected: true,
              promptChars: 42,
              phase: "running",
            },
            error: "remote host is busy",
          });
        },
      );
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "maps 404 to a typed upgrade error (host does not expose /runs)",
    async () => {
      await withStubServer(jsonResponder(404, undefined), async (port) => {
        await expect(
          checkRemoteRunAvailability({ host: `127.0.0.1:${port}`, token: "secret" }),
        ).resolves.toMatchObject({
          ok: false,
          statusCode: 404,
          error: expect.stringMatching(/does not expose \/runs/),
        });
      });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)("maps 401 to the server's unauthorized error", async () => {
    await withStubServer(
      jsonResponder(401, { error: "missing or invalid token" }),
      async (port) => {
        await expect(
          checkRemoteRunAvailability({ host: `127.0.0.1:${port}` }),
        ).resolves.toMatchObject({
          ok: false,
          statusCode: 401,
          error: "missing or invalid token",
        });
      },
    );
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "maps 403 to unauthorized, falling back to a generic message when the body has none",
    async () => {
      await withStubServer(jsonResponder(403, undefined), async (port) => {
        await expect(
          checkRemoteRunAvailability({ host: `127.0.0.1:${port}`, token: "secret" }),
        ).resolves.toMatchObject({
          ok: false,
          statusCode: 403,
          error: "unauthorized",
        });
      });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "maps a new 422 model-gate refusal to unavailable, surfacing the refusal message",
    async () => {
      // Recent /runs admission added 422 model_label_not_allowed /
      // model_strategy_not_allowed gates; the probe must treat these as
      // unavailable (not busy, not available), surfacing the reason.
      await withStubServer(
        jsonResponder(422, { error: "model_label_not_allowed", message: "only GPT-5.6 Sol + Pro" }),
        async (port) => {
          await expect(
            checkRemoteRunAvailability({ host: `127.0.0.1:${port}`, token: "secret" }),
          ).resolves.toMatchObject({
            ok: false,
            statusCode: 422,
            error: "model_label_not_allowed",
          });
        },
      );
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "maps an unexpected status (500) to a generic unavailable error",
    async () => {
      await withStubServer(jsonResponder(500, undefined), async (port) => {
        await expect(
          checkRemoteRunAvailability({ host: `127.0.0.1:${port}`, token: "secret" }),
        ).resolves.toMatchObject({
          ok: false,
          statusCode: 500,
          error: expect.stringMatching(/unexpected \/runs probe status HTTP 500/),
        });
      });
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "maps a stalled connection to a timeout error instead of hanging",
    async () => {
      // Accept the connection but never respond: the probe's request-level
      // timeout must fire and surface a typed error rather than hang.
      await withStubServer(
        (req) => {
          req.resume();
        },
        async (port) => {
          await expect(
            checkRemoteRunAvailability({
              host: `127.0.0.1:${port}`,
              token: "secret",
              timeoutMs: 60,
            }),
          ).resolves.toMatchObject({
            ok: false,
            error: expect.stringMatching(/timeout after 60ms/),
          });
        },
      );
    },
  );
});

/** Responds to any request (after draining the body) with a fixed status + JSON body. */
function jsonResponder(statusCode: number, body: unknown): http.RequestListener {
  return (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(statusCode, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  };
}

async function withStubServer(
  handler: http.RequestListener,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stub server did not bind a TCP port");
  }
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
