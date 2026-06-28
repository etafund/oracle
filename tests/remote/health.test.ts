import { describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { checkRemoteHealth, checkTcpConnection } from "../../src/remote/health.js";

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

describe("remote health checks", () => {
  test("reports invalid TCP host strings instead of throwing", async () => {
    await expect(checkTcpConnection("not-a-host-port", 10)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/host:port/i),
    });
  });

  test("reports invalid health host strings instead of throwing", async () => {
    await expect(
      checkRemoteHealth({ host: "127.0.0.1:not-a-port", token: "secret", timeoutMs: 10 }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/invalid port/i),
    });
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)("preserves busy active-run metadata", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          busy: true,
          error: "busy",
          version: "1.2.3",
          uptimeSeconds: 10,
          activeRun: {
            id: "run-1",
            startedAt: "2026-06-28T03:27:58.000Z",
            ageSeconds: 30,
            clientConnected: false,
            promptChars: 42,
            sessionId: "session-1",
            desiredModel: "gpt-5.5-pro",
          },
        }),
      );
    });
    try {
      const port = await listen(server);
      await expect(
        checkRemoteHealth({ host: `127.0.0.1:${port}`, token: "secret", timeoutMs: 1000 }),
      ).resolves.toMatchObject({
        ok: false,
        statusCode: 409,
        busy: true,
        version: "1.2.3",
        uptimeSeconds: 10,
        activeRun: {
          id: "run-1",
          clientConnected: false,
          sessionId: "session-1",
          desiredModel: "gpt-5.5-pro",
        },
      });
    } finally {
      await close(server);
    }
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
