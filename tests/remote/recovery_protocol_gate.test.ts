import http from "node:http";
import { spawnSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";

import { createRemoteBrowserExecutor, RemoteRunFailedError } from "../../src/remote/client.js";
import { createRemoteServer } from "../../src/remote/server.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RECOVERY_PROTOCOL,
  REMOTE_BROWSER_RUN_PATH,
} from "../../src/remote/types.js";
import {
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../../src/browser/promptDomMatch.js";
import { setCompatibleRecoveryResponseHeaders } from "./_recoveryProtocolFixture.js";

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

const EXACT_BROWSER_RECOVERY_CAPABILITY = {
  protocol: REMOTE_BROWSER_RECOVERY_PROTOCOL,
  promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
  promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
};

describe("remote browser recovery mixed-version admission", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "health advertises the exact executable protocol and both identity algorithms",
    async () => {
      const server = await createRemoteServer({
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        logger: () => {},
      });
      try {
        const response = await requestJson(server.port, "/health", {
          authorization: "Bearer secret",
        });
        expect(response.statusCode).toBe(200);
        expect(response.json?.capabilities).toMatchObject({
          browserRecovery: EXACT_BROWSER_RECOVERY_CAPABILITY,
        });
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "worker rejects missing or mismatched admission IDs before body parsing or browser execution",
    async () => {
      const runBrowser = vi.fn(async () => {
        throw new Error("must not execute");
      });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        { runBrowser },
      );
      try {
        const missing = await requestJson(
          server.port,
          REMOTE_BROWSER_RUN_PATH,
          { authorization: "Bearer secret", "content-type": "application/json" },
          "{",
        );
        expect(missing.statusCode).toBe(426);
        expect(missing.json).toMatchObject({
          error: "remote_recovery_protocol_incompatible",
          expected: EXACT_BROWSER_RECOVERY_CAPABILITY,
        });

        const mismatched = await requestJson(
          server.port,
          REMOTE_BROWSER_RUN_PATH,
          {
            authorization: "Bearer secret",
            "content-type": "application/json",
            ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
            "x-oracle-prompt-dom-identity-algorithm": "oracle.rendered-prompt-dom-identity.v1",
          },
          "{",
        );
        expect(mismatched.statusCode).toBe(426);

        const compatible = await requestJson(
          server.port,
          REMOTE_BROWSER_RUN_PATH,
          {
            authorization: "Bearer secret",
            "content-type": "application/json",
            ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          },
          "{",
        );
        expect(compatible.statusCode).toBe(400);
        expect(runBrowser).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "client refuses an old worker from /health without ever posting /runs",
    async () => {
      const paths: string[] = [];
      const fake = await listen(
        http.createServer((req, res) => {
          paths.push(req.url ?? "");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              capabilities: {
                artifactTransfer: true,
                artifactProtocolVersion: 1,
                maxArtifactBytes: 1024,
                browserRecovery: {
                  ...EXACT_BROWSER_RECOVERY_CAPABILITY,
                  protocol: "remote-browser-recovery.v1",
                },
              },
            }),
          );
        }),
      );
      try {
        const execute = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const failure = await execute({ prompt: "must not submit", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toMatch(/incompatible.*upgrade/i);
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
        expect(paths).toEqual(["/health"]);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "compatible client sends the exact contract again on POST /runs",
    async () => {
      let runHeaders: http.IncomingHttpHeaders | null = null;
      const fake = await listen(
        http.createServer((req, res) => {
          if (req.url === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                capabilities: {
                  artifactTransfer: true,
                  artifactProtocolVersion: 1,
                  maxArtifactBytes: 1024,
                  browserRecovery: EXACT_BROWSER_RECOVERY_CAPABILITY,
                },
              }),
            );
            return;
          }
          setCompatibleRecoveryResponseHeaders(res);
          runHeaders = req.headers;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "fixture_stop" }));
        }),
      );
      try {
        const execute = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        await execute({ prompt: "header proof", config: {} }).catch(() => undefined);
        expect(runHeaders).toMatchObject(REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES);
      } finally {
        await fake.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "client refuses when health hits v2 but the admitted backend does not echo v2",
    async () => {
      const fake = await listen(
        http.createServer((req, res) => {
          if (req.url === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                capabilities: {
                  artifactTransfer: true,
                  artifactProtocolVersion: 1,
                  maxArtifactBytes: 1024,
                  browserRecovery: EXACT_BROWSER_RECOVERY_CAPABILITY,
                },
              }),
            );
            return;
          }
          // Simulates a load balancer routing /health to v2 and /runs to an
          // old worker which ignores the request contract. It deliberately
          // omits all response echoes even though it claims success.
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end(
            `${JSON.stringify({
              type: "done",
              ok: true,
              result: {
                answerText: "must not surface",
                answerMarkdown: "must not surface",
                tookMs: 1,
                answerTokens: 1,
                answerChars: 16,
              },
            })}\n`,
          );
        }),
      );
      try {
        const execute = createRemoteBrowserExecutor({
          host: `127.0.0.1:${fake.port}`,
          token: "secret",
        });
        const failure = await execute({ prompt: "must fail closed", config: {} }).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(RemoteRunFailedError);
        expect((failure as RemoteRunFailedError).message).toMatch(
          /without echoing.*mixed-version/i,
        );
        expect((failure as RemoteRunFailedError).errorClass).toBe("integrity_ui_unknown");
        expect((failure as RemoteRunFailedError).retryable).toBe(false);
      } finally {
        await fake.close();
      }
    },
  );
});

async function requestJson(
  port: number,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = responseBody ? (JSON.parse(responseBody) as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function listen(server: http.Server): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
